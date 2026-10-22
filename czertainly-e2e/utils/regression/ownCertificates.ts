/**
 * ownCertificates — the certificates this run creates.
 *
 * WHAT: the certificates this run creates, in one place: issued from an external CSR through the v2 API, and
 *       uploaded (self-signed or built by a fixture). Every creator records what the platform made in the ledger right after the
 *       call and BEFORE any assertion, with the parents a later operation needs (`raProfile`, `authority`), and the key the
 *       platform linked to the certificate as a derived object.
 *
 *       One argument order for issuing: `(api, ra, spec, options)`. One `OwnCertificate` (every own certificate: its ledger
 *       reference and common name); `IssuedCertificate` adds what an issue from a CSR keeps (CSR, key pair, SANs, RA profile,
 *       the answer).
 * WHY: Issue and upload are written by many specs; their ledger-before-assertion rule must be written once.
 * HOW: Issued from an external CSR through the v2 API or uploaded; every creator records the certificate with its parents and the
 * platform-made key as a derived object right after the call; `sanOracle` holds the SAN rule per CA and `waitIssued` / `waitRevoked` the
 * named waits.
 */
import type * as forge from 'node-forge';
import { waitForCertificateState } from './wait/certificateState';
import { GuardedApi } from './guard/types';
import { APIRequestContext, expect } from '@playwright/test';
import { ISSUED_WAIT_MS, REVOKED_WAIT_MS } from './timeouts';
import { opsBase } from './lifecycle/certificateLabels';
import { sendRaw } from './lifecycle/rawAnswers';
import { GeneratedCsr, csrFromKey, newKeyPair, SanSet, sameSans, sansOfDetail, selfSignedPem } from './pkiBuilders';
import { RaLike } from './ownRaProfiles';
import { Logger } from '../Logger';
import { ApiAnswer, apiJsonWithDate, createdAfterOf } from './apiReads';
import { requiredCustomAttributes } from './customAttributes';
import { recordDerivedKeyOf, recordDerivedKeyOrNamed } from './issuedRecords';
import { OwnRef, recordCreated } from './ledger/ledger';
import { runName, ownName, ownCommonName } from './ledger/runState';
import { settings } from './run/settings';
import type { JsonObject } from './json';

const logger = new Logger('ownCertificates');

/** A run-prefixed common name (unique under --repeat-each). */
export const certificateName = (suffix = 'cert'): string => ownCommonName(suffix);

/**
 * The CN of API-CERT-21[rfc4514]: STARTS with the run-prefixed name (the teardown's ownership rule is a
 * prefix test, so a leading space would leave the registered certificate on the tier), and carries the RFC 4514 special
 * characters after it: `<run name>, O= QA+Team` (comma and plus are escaped in the stored DN: `\, O= QA\+Team`).
 */
export const specialCharCn = (name: string): string => `${name}, O= QA+Team`;

/** An own certificate: its ledger reference (`uuid`, run-prefixed `name`) and common name (= `name`). */
export interface OwnCertificate extends OwnRef {
    cn: string;
}

/** An own certificate this run issued through the v2 API: its CSR and key pair (a same-key renew CSR needs them). */
export interface IssuedCertificate extends OwnCertificate {
    sans: SanSet;
    csr: GeneratedCsr;
    keys: forge.pki.rsa.KeyPair;
    ra: RaLike;
    createdAfter?: string;
    /** The issue answer (the contract rows assert it). */
    answer: ApiAnswer;
}

export interface IssueOptions {
    /** Name suffix (`<run>-<suffix>-<stamp>.example.test`); default `cert`. */
    suffix?: string;
    /** SANs; default: the CN as DNS name and one TEST-NET-1 IP. */
    sans?: Partial<SanSet>;
    /** An existing RSA key pair; default a fresh RSA-2048 pair. */
    keys?: forge.pki.rsa.KeyPair;
    /** Extra request body fields (negatives); `request` / `format` / `attributes` / `customAttributes` are set unless overridden. */
    body?: JsonObject;
    note?: string;
    /**
     * Fill the tier's REQUIRED custom attributes of certificates into the request (default: send none); `body.customAttributes` overrides.
     */
    fillRequiredAttributes?: boolean;
}

/**
 * `POST …/certificates` (v2 issue) with an external CSR; the answer is NOT asserted here: whatever uuid the platform
 * made is recorded first (ledger before assertion), then the caller asserts the contract. With `fillRequiredAttributes` the REQUIRED
 * custom attributes of certificates a tier defines are filled (a create without them answers 422 there); `opts.body` overrides.
 */
export async function submitOwnCertificate(api: GuardedApi, ra: RaLike, spec: string, opts: IssueOptions = {}): Promise<IssuedCertificate> {
    const cn = certificateName(opts.suffix);
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): a documentation address, never a real host.
    const sans: SanSet = { dns: opts.sans?.dns ?? [cn], ip: opts.sans?.ip ?? ['192.0.2.20'] };
    const keys = opts.keys ?? newKeyPair();
    const csr = csrFromKey(keys, cn, sans);
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates`, {
        request: csr.derBase64,
        format: 'pkcs10',
        attributes: [],
        customAttributes: opts.fillRequiredAttributes ? await requiredCustomAttributes(api, 'certificates', runName('ca')) : [],
        ...(opts.body ?? {}),
    });
    const uuid = (answer.json as JsonObject | undefined)?.uuid;
    if (typeof uuid !== 'string') throw new Error(`v2 issue answered ${answer.status} without a uuid: ${answer.text.slice(0, 300)}`);
    const ref = recordCreated('certificates', { uuid, name: cn }, { spec, note: opts.note ?? 'issued via API (lifecycle)', parents: { raProfile: ra.uuid, authority: ra.authorityUuid } });
    // Without a Date header the bound is the one the teardown keeps (createdAfterOf, with a warning), so the
    // platform-made key is always recorded as derived and never left out of the ledger.
    return { ...ref, cn, sans, csr, keys, ra, createdAfter: createdAfterOf(answer, 'v2 issue'), answer };
}

/** `submitOwnCertificate`, then the wait for `issued` (fail-fast on failed / rejected) and the derived-key record. */
export async function issueOwnCertificate(api: GuardedApi, ra: RaLike, spec: string, opts: IssueOptions & { timeoutMs?: number } = {}): Promise<IssuedCertificate> {
    const cert = await submitOwnCertificate(api, ra, spec, opts);
    if (cert.answer.status !== 200) throw new Error(`v2 issue answered ${cert.answer.status}: ${cert.answer.text.slice(0, 300)}`);
    try {
        await waitIssued(api, cert.uuid, opts.timeoutMs);
    } catch (e) {
        // A wait that timed out or saw failed / rejected may still have left the key the platform made: record it before the error goes on.
        await recordDerivedKeyOf(api, cert.uuid, cert.createdAfter, spec).catch((recordError: unknown) => {
            logger.warn(`certificate ${cert.uuid}: the derived key could not be recorded after the failed wait (${String(recordError instanceof Error ? recordError.message : recordError).split('\n')[0].slice(0, 200)}); check the tier for a leftover key`);
        });
        throw e;
    }
    await recordDerivedKeyOf(api, cert.uuid, cert.createdAfter, spec);
    return cert;
}

/**
 * Upload a certificate synchronously (`POST /v1/certificates/upload` answers its uuid) and record it in the ledger
 * before any assertion (an upload whose uuid is only found by a later poll leaves an unrecorded object when the poll
 * fails). `name` is the certificate's common name, which carries the run prefix. Core links a `certKey_<CN>` key to
 * every uploaded certificate (CertificateServiceImpl.uploadCertificateKey): it is recorded as a derived object right
 * after the certificate. `customAttributes` is the complete attribute list of the request (default: the tier's
 * required ones, filled; a caller that uploads many certificates reads them once and passes them in).
 */
export async function uploadOwnCertificate(api: GuardedApi, pem: string, name: string, spec: string, note = 'uploaded', customAttributes?: JsonObject[]): Promise<OwnCertificate> {
    const answer = await apiJsonWithDate(api, 'POST', '/api/v1/certificates/upload', {
        certificate: Buffer.from(pem).toString('base64'),
        customAttributes: customAttributes ?? (await requiredCustomAttributes(api, 'certificates', runName('ca'))),
    });
    const ref = recordCreated('certificates', { uuid: answer.json.uuid, name }, { spec, note });
    await recordDerivedKeyOrNamed(api, answer.json.uuid, name, createdAfterOf(answer, 'upload'), spec, note);
    return { ...ref, cn: name };
}

/** A NEW own self-signed certificate (RSA-2048, 30 days), uploaded: `uploadOwnCertificate` under a run-prefixed, unique common name. */
export async function uploadOwnSelfSigned(api: GuardedApi, spec: string, suffix = 'cert'): Promise<OwnCertificate> {
    const cn = ownName(suffix);
    return uploadOwnCertificate(api, selfSignedPem(cn).pem, cn, spec, 'own self-signed upload (API prerequisite)');
}

// ------------------------------------------------------------------ issue with an external CSR, the SAN oracle per CA

/**
 * v2 issue with an external CSR; returns the new certificate's uuid (issuance continues asynchronously) and, when the
 * server sent a Date header, the `createdAfter` for the certificate's derived `certKey_<CN>` key (server clock).
 */
export async function issueWithCsr(api: GuardedApi, authorityUuid: string, raProfileUuid: string, csrDerBase64: string): Promise<{ uuid: string; body: JsonObject; createdAfter: string }> {
    const answer = await apiJsonWithDate(api, 'POST', `/api/v2/operations/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/certificates`, {
        request: csrDerBase64,
        format: 'pkcs10',
        attributes: [],
        customAttributes: await requiredCustomAttributes(api, 'certificates', runName('ca')),
    });
    return { uuid: answer.json.uuid, body: answer.json, createdAfter: createdAfterOf(answer, 'v2 issue') };
}

/**
 * Waits until the certificate is `issued` (fails at once on `failed` / `rejected`); the budget is `ISSUED_WAIT_MS` unless a spec needs
 * another.
 */
export const waitIssued = (api: APIRequestContext, uuid: string, timeoutMs: number = ISSUED_WAIT_MS): Promise<void> => waitForCertificateState(api, uuid, 'issued', timeoutMs);

/**
 * Waits until the certificate is `revoked` (fails at once on `failed` / `rejected`); the budget is `REVOKED_WAIT_MS` unless a spec needs
 * another.
 */
export const waitRevoked = (api: APIRequestContext, uuid: string, timeoutMs: number = REVOKED_WAIT_MS): Promise<void> => waitForCertificateState(api, uuid, 'revoked', timeoutMs);

/**
 * The SAN oracle of a CA: what the CA accepts is the CA's decision, so the check depends on the connector.
 * `exact` (set equality, DNS and IP) on EJBCA-NG, whose run profiles copy the CSR's SANs; `dns` (the DNS values are
 * present) on any other CA, whose template may rewrite the SAN extension.
 */
export function sanOracleFor(connectorName: string, env: NodeJS.ProcessEnv = process.env): 'exact' | 'dns' {
    return settings(env).exactSanConnectors.includes(connectorName) ? 'exact' : 'dns';
}

/** The SAN rule of one connector as an object: the annotation text and the check of what was issued against the CSR. */
export interface SanOracle {
    readonly connector: string;
    readonly mode: 'exact' | 'dns';
    /** One line for the test annotation: which rule applies on this connector and why. */
    describe(): string;
    /** The SANs a certificate carries (its detail) against the SANs of the CSR; throws a failed expectation naming both sets. */
    expectIssued(detail: { subjectAlternativeNames?: Record<string, unknown> | null }, csrSans: SanSet): void;
    /** The same check for SANs already read (a parsed leaf, a stored request). */
    expectSans(got: SanSet, csrSans: SanSet): void;
}

/** `sanOracleFor` with the checks written once. */
export function sanOracle(connectorName: string, env: NodeJS.ProcessEnv = process.env): SanOracle {
    const mode = sanOracleFor(connectorName, env);
    const expectSans = (got: SanSet, csrSans: SanSet): void => {
        if (mode === 'exact') {
            expect(sameSans(got, csrSans), `issued SANs ${JSON.stringify(got)} = CSR SANs ${JSON.stringify(csrSans)}`).toBe(true);
            return;
        }
        const have = got.dns.map((name) => name.toLowerCase());
        for (const name of csrSans.dns) expect(have, `issued DNS SANs ${JSON.stringify(got.dns)} contain ${name}`).toContain(name.toLowerCase());
    };
    return {
        connector: connectorName,
        mode,
        describe: () => (mode === 'exact' ? `exact SAN set on ${connectorName}` : `DNS values only on ${connectorName} (its template decides the SAN extension)`),
        expectIssued: (detail, csrSans) => expectSans(sansOfDetail(detail.subjectAlternativeNames), csrSans),
        expectSans,
    };
}
