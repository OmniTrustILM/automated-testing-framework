/**
 * ownCertificates — the certificates this run creates (issued from an
 * external CSR or uploaded), each recorded in the ledger before any assertion.
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
import { ApiAnswer, apiJson, apiJsonWithDate, createdAfterOf, getCertificate } from './apiReads';
import { requiredCustomAttributes } from './customAttributes';
import { recordDerivedKeyOf, recordDerivedKeyOrNamed } from './issuedRecords';
import { OwnRef, recordCreated } from './ledger/ledger';
import { runName, ownName, ownCommonName } from './ledger/runState';
import { settings } from './run/settings';
import type { JsonObject } from './json';

const logger = new Logger('OwnCertificates');

export const certificateName = (suffix = 'cert'): string => ownCommonName(suffix);

/**
 * The CN of API-CERT-21[rfc4514]: starts with the run-prefixed name (the
 * teardown's ownership rule is a prefix test), then RFC 4514 special characters.
 */
export const specialCharCn = (name: string): string => `${name}, O= QA+Team`;

export interface OwnCertificate extends OwnRef {
    cn: string;
}

export interface IssuedCertificate extends OwnCertificate {
    sans: SanSet;
    csr: GeneratedCsr;
    keys: forge.pki.rsa.KeyPair;
    ra: RaLike;
    createdAfter?: string;
    answer: ApiAnswer;
}

export interface IssueOptions {
    suffix?: string;
    sans?: Partial<SanSet>;
    keys?: forge.pki.rsa.KeyPair;
    body?: JsonObject;
    note?: string;
    /** Fill the tier's required custom attributes into the request (default: none); `body.customAttributes` overrides. */
    fillRequiredAttributes?: boolean;
}

/**
 * `POST …/certificates` (v2 issue) with an external CSR; the answer is not
 * asserted here: the uuid is recorded first, the caller asserts the contract.
 */
export async function submitOwnCertificate(api: GuardedApi, ra: RaLike, spec: string, opts: IssueOptions = {}): Promise<IssuedCertificate> {
    const cn = certificateName(opts.suffix);
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
    // Without a Date header the bound is the one the teardown keeps, so the platform-made key is always recorded.
    return { ...ref, cn, sans, csr, keys, ra, createdAfter: createdAfterOf(answer, 'v2 issue'), answer };
}

export async function issueOwnCertificate(api: GuardedApi, ra: RaLike, spec: string, opts: IssueOptions & { timeoutMs?: number } = {}): Promise<IssuedCertificate> {
    const cert = await submitOwnCertificate(api, ra, spec, opts);
    if (cert.answer.status !== 200) throw new Error(`v2 issue answered ${cert.answer.status}: ${cert.answer.text.slice(0, 300)}`);
    try {
        await waitIssued(api, cert.uuid, opts.timeoutMs);
    } catch (e) {
        // A failed wait may still have left the platform-made key: record it first.
        await recordDerivedKeyOf(api, cert.uuid, cert.createdAfter, spec).catch((recordError: unknown) => {
            logger.warn(`certificate ${cert.uuid}: the derived key could not be recorded after the failed wait (${String(recordError instanceof Error ? recordError.message : recordError).split('\n')[0].slice(0, 200)}); check the tier for a leftover key`);
        });
        throw e;
    }
    await recordDerivedKeyOf(api, cert.uuid, cert.createdAfter, spec);
    return cert;
}

/**
 * Upload a certificate synchronously and record it before any assertion, with its derived `certKey_<CN>` key. `customAttributes` defaults
 * to the tier's required ones.
 */
export async function uploadOwnCertificate(api: GuardedApi, pem: string, name: string, spec: string, note = 'uploaded', customAttributes?: JsonObject[]): Promise<OwnCertificate> {
    const answer = await apiJsonWithDate(api, 'POST', '/api/v1/certificates/upload', {
        certificate: Buffer.from(pem).toString('base64'),
        customAttributes: customAttributes ?? (await requiredCustomAttributes(api, 'certificates', runName('ca'))),
    });
    const ref = recordCreated('certificates', { uuid: answer.json.uuid, name }, { spec, note });
    await recordDerivedKeyOrNamed(api, answer.json.uuid, name, createdAfterOf(answer, 'upload'), spec, note);
    await dropUploaderOwner(api, ref);
    return { ...ref, cn: name };
}

async function automaticOwnershipOn(api: GuardedApi): Promise<boolean> {
    try {
        const platform = await apiJson<{ certificates?: { upload?: { automaticOwnership?: boolean } } } | undefined>(api, 'GET', '/api/v1/settings/platform');
        return platform?.certificates?.upload?.automaticOwnership === true;
    } catch (e) {
        logger.warn(`the platform settings could not be read (${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 200)}); an own upload may keep the uploader as owner`);
        return false;
    }
}

/** With automatic ownership on (core#2698) the sync upload answers with the uploader as owner; the suites expect none, so it is removed. */
async function dropUploaderOwner(api: GuardedApi, ref: OwnRef): Promise<void> {
    if (!(await automaticOwnershipOn(api))) return;
    if (!(await getCertificate(api, ref.uuid)).ownerUuid) {
        logger.info(`certificate ${ref.uuid}: automatic ownership is on, but the upload has no owner (an upload trigger may have set none)`);
        return;
    }
    await apiJsonWithDate(api, 'PATCH', `/api/v1/certificates/${ref.uuid}`, { ownerUuid: '' });
    logger.info(`certificate ${ref.uuid}: automatic ownership is on; the uploader's ownership is removed`);
}

export async function uploadOwnSelfSigned(api: GuardedApi, spec: string, suffix = 'cert'): Promise<OwnCertificate> {
    const cn = ownName(suffix);
    return uploadOwnCertificate(api, selfSignedPem(cn).pem, cn, spec, 'own self-signed upload (API prerequisite)');
}


/** v2 issue with an external CSR; returns the uuid and, with a Date header, the `createdAfter` for the derived key. */
export async function issueWithCsr(api: GuardedApi, authorityUuid: string, raProfileUuid: string, csrDerBase64: string): Promise<{ uuid: string; body: JsonObject; createdAfter: string }> {
    const answer = await apiJsonWithDate(api, 'POST', `/api/v2/operations/authorities/${authorityUuid}/raProfiles/${raProfileUuid}/certificates`, {
        request: csrDerBase64,
        format: 'pkcs10',
        attributes: [],
        customAttributes: await requiredCustomAttributes(api, 'certificates', runName('ca')),
    });
    return { uuid: answer.json.uuid, body: answer.json, createdAfter: createdAfterOf(answer, 'v2 issue') };
}

/** Waits until the certificate is `issued` (fails at once on `failed` / `rejected`); budget `ISSUED_WAIT_MS`. */
export const waitIssued = (api: APIRequestContext, uuid: string, timeoutMs: number = ISSUED_WAIT_MS): Promise<void> => waitForCertificateState(api, uuid, 'issued', timeoutMs);

/** Waits until the certificate is `revoked` (fails at once on `failed` / `rejected`); budget `REVOKED_WAIT_MS`. */
export const waitRevoked = (api: APIRequestContext, uuid: string, timeoutMs: number = REVOKED_WAIT_MS): Promise<void> => waitForCertificateState(api, uuid, 'revoked', timeoutMs);

/**
 * The SAN oracle of a CA: `exact` (DNS and IP) on EJBCA-NG, which copies
 * the CSR's SANs; `dns` on any other CA, whose template may rewrite them.
 */
export function sanOracleFor(connectorName: string, env: NodeJS.ProcessEnv = process.env): 'exact' | 'dns' {
    return settings(env).exactSanConnectors.includes(connectorName) ? 'exact' : 'dns';
}

export interface SanOracle {
    readonly connector: string;
    readonly mode: 'exact' | 'dns';
    describe(): string;
    expectIssued(detail: { subjectAlternativeNames?: Record<string, unknown> | null }, csrSans: SanSet): void;
    expectSans(got: SanSet, csrSans: SanSet): void;
}

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
