/**
 * lifecycle — certificate lifecycle helpers of the cert-lifecycle area (B2 / B3: API-CERT-01…36, REG-CERT-07…17):
 * issue, renew, rekey, revoke, register, complete (issue-existing), finalize / confirm / cancel probes, approvals through
 * the override path, relations, history, the registration settings, and the teardown handlers of the `approvals` and
 * `approvalProfiles` ledger types (runTeardown `HANDLER_MODULES` maps both to this module).
 *
 * Rules this module keeps (decisions Q1 / D1, review Q2):
 * - every mutation takes the guarded api (`GuardedApi`) and an `OwnRef`; `assertOwnLive` runs before the call, and the
 *   guard judges the request again (path targets, body, headers);
 * - every object the platform makes for a call is recorded in the ledger right after the call and BEFORE any assertion
 *   (certificates, successors, approvals, approval profiles, RA-profile clones), with the parents a later operation
 *   needs (`raProfile`, `authority`, `predecessor`, `certificate`);
 * - the run RA profile (`ensureRaProfile`) is never gated: an approval profile is associated only with an OWN CLONE
 *   (`RA+`, `cloneRunRaProfile`), and `ApprovalGate.release()` removes the association again (the run-end teardown revokes
 *   own issued certificates through their RA profile; a revoke on a gated RA profile would wait for an approval);
 * - negatives never throw on a 4xx: `sendRaw` returns `{ status, text, json }` and the spec asserts status AND body shape
 *   (spec-authoring hard rule 8, `errorContract`);
 * - approvals are never deleted by the platform and an approval profile with approvals cannot be deleted (core
 *   ApprovalProfileServiceImpl "Unable to delete approval profile with existing approvals."): the teardown handlers
 *   close what is pending and report both as `kept` (never a silent leftover).
 */
import type { APIRequestContext } from '@playwright/test';
import { requestVersion } from './attributeVersion';
import * as forge from 'node-forge';
import { Logger } from '../Logger';
import { waitForCertificateState } from '../certificateUtils';
import { errorShape } from './errorContract';
import { guardApi, GuardedApi, requireGuarded } from './guardedApi';
import { assertOwnLive, ownership } from './ownObjects';
import { csrFromKey, GeneratedCsr, SanSet } from './pki';
import { apiJson, createRaProfileLike, enableOwnRaProfile, ensureRaProfile, ensureRole, getCertificate, recordDerivedKeyOf, RunRaProfile } from './regressionApi';
import { createdAfterFrom, OwnRef, readState, recordCreated, regName, RUN_ID, serverDateOf, updateState } from './regressionRun';
import type { TeardownHandler } from './runTeardown';

const logger = new Logger('Lifecycle');

type Json = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stamp = (): string => Date.now().toString(36);

/** An RA profile a lifecycle call goes through: the run RA profile or an own clone (`RA+`). */
export interface RaLike {
    uuid: string;
    name: string;
    authorityUuid: string;
}

/** The v2 operations base of an RA profile (`/api/v2/operations/authorities/{a}/raProfiles/{r}`). */
export const opsBase = (ra: Pick<RaLike, 'uuid' | 'authorityUuid'>): string => `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}`;

// ------------------------------------------------------------------ labels and texts (cert-lifecycle rules)

/** The nine revocation reasons: wire code and UI / history label (`CertificateRevocationReason`, rules RV-2 / RV-5). */
export const REVOKE_REASONS: ReadonlyArray<{ code: string; label: string }> = [
    { code: 'unspecified', label: 'Unspecified' },
    { code: 'keyCompromise', label: 'Key compromise' },
    { code: 'cACompromise', label: 'CA compromise' },
    { code: 'affiliationChanged', label: 'Affiliation changed' },
    { code: 'superseded', label: 'Superseded' },
    { code: 'cessationOfOperation', label: 'Cessation of operation' },
    { code: 'certificateHold', label: 'Certificate hold' },
    { code: 'privilegeWithdrawn', label: 'Privilege withdrawn' },
    { code: 'aACompromise', label: 'AA compromise' },
];

/** Certificate state codes → labels (`CertificateState`, rules §7.2). */
export const STATE_LABELS: Readonly<Record<string, string>> = {
    requested: 'Requested',
    rejected: 'Rejected',
    pending_approval: 'Pending approval',
    pending_issue: 'Pending issue',
    pending_revoke: 'Pending revoke',
    pending_registration: 'Pending registration',
    registered: 'Registered',
    failed: 'Failed',
    issued: 'Issued',
    revoked: 'Revoked',
};

/** The one-element 422 text of RR-2 3 / RV-3: a lifecycle operation on a certificate that is not `issued`. */
export const stateGuardText = (op: 'renew' | 'rekey' | 'revoke', stateCode: string): string =>
    `Cannot perform operation ${op} on certificate in state ${STATE_LABELS[stateCode] ?? stateCode}. Certificate: `;

/** Rule AP-10: the history line the approval close writes. */
export const approvalClosedText = (action: string, profileName: string, status: 'Approved' | 'Rejected' | 'Expired'): string =>
    `Approval for action ${action} with approval profile ${profileName} closed with status ${status}`;

/** Rule RV-5: the history line of a completed revoke. */
export const revokedText = (label: string): string => `Certificate revoked. Reason: ${label}`;

// ------------------------------------------------------------------ raw answers (negatives assert status + shape)

export interface RawAnswer {
    status: number;
    text: string;
    /** Parsed JSON body, when the body parses. */
    json?: unknown;
    /** The server's clock (Date header) and the request's duration: a `createdAfter` for derived objects (R17). */
    serverAt?: Date;
    elapsedMs: number;
}

export interface RawOptions {
    headers?: Record<string, string>;
    /** Another identity than the run's (401 negatives): an identity header needs the guard's switch. */
    identityOverride?: boolean;
}

/**
 * One guarded request whose answer is read without throwing: status, text, parsed JSON when the body parses, the server
 * Date. A Buffer body is sent as written (a malformed-JSON negative); an object is sent as JSON.
 */
export async function sendRaw(api: GuardedApi, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, data?: unknown, opts: RawOptions = {}): Promise<RawAnswer> {
    const started = Date.now();
    const options: Record<string, unknown> = { method };
    if (data !== undefined) options.data = data;
    if (opts.headers) options.headers = opts.headers;
    if (opts.identityOverride) options.identityOverride = true;
    const res = await requireGuarded(api, `lifecycle.sendRaw ${method}`).fetch(url, options);
    const text = await res.text();
    let json: unknown;
    try {
        json = text ? JSON.parse(text) : undefined;
    } catch {
        json = undefined;
    }
    return { status: res.status(), text, json, serverAt: serverDateOf(res.headers()), elapsedMs: Date.now() - started };
}

/** A `createdAfter` from a raw answer's server Date (undefined without one). */
export const createdAfterOf = (a: RawAnswer): string | undefined => (a.serverAt ? createdAfterFrom(a.serverAt, a.elapsedMs) : undefined);

/** The 422 body as its string list, or a problem text (the caller's assertion names it). */
export function messagesOf(a: RawAnswer): string[] {
    const s = errorShape(a.text);
    if (s.kind !== 'messages') throw new Error(`a 422 body must be a JSON array of non-empty strings; got ${s.kind === 'other' ? s.why : s.kind}: ${a.text.slice(0, 300)}`);
    return s.messages;
}

/** The `{message}` body's text, or a problem text. */
export function messageOf(a: RawAnswer): string {
    const s = errorShape(a.text);
    if (s.kind !== 'message') throw new Error(`an error body must be {"message": "<text>"} and nothing else; got ${s.kind === 'other' ? s.why : s.kind}: ${a.text.slice(0, 300)}`);
    return s.message;
}

/** Words an error body must never carry (catalogue J: no stack trace, class name or SQL state leaks). */
export const LEAK_WORDS: readonly RegExp[] = [/\bat com\.\w+/, /Exception\b/, /SQLState/i, /\borg\.(spring|hibernate|postgresql)/];

/** The leak words found in an error body (empty = clean). */
export const leaksIn = (text: string): string[] => LEAK_WORDS.filter((re) => re.test(text)).map(String);

// ------------------------------------------------------------------ own certificates: issue

/** An own certificate this run issued through the v2 API: its CSR and key pair (a same-key renew CSR needs them). */
export interface OwnCertificate extends OwnRef {
    /** The common name (= `name`, run-prefixed). */
    cn: string;
    sans: SanSet;
    csr: GeneratedCsr;
    keys: forge.pki.rsa.KeyPair;
    ra: RaLike;
    createdAfter?: string;
    /** The issue answer (the contract rows assert it). */
    answer: RawAnswer;
}

export interface IssueOptions {
    /** Name suffix (`<run>-<suffix>-<stamp>.example.test`); default `cert`. */
    suffix?: string;
    /** SANs; default: the CN as DNS name and one TEST-NET-1 IP. */
    sans?: Partial<SanSet>;
    /** An existing RSA key pair; default a fresh RSA-2048 pair. */
    keys?: forge.pki.rsa.KeyPair;
    /** Extra request body fields (negatives); `request` / `format` / `attributes` are set unless overridden. */
    body?: Json;
    note?: string;
}

/** A run-prefixed, time-stamped common name (unique under --repeat-each). */
export const certificateName = (suffix = 'cert'): string => `${regName(`${suffix}-${stamp()}`)}.example.test`;

/**
 * The CN of API-CERT-21[rfc4514] (merge review M1): STARTS with the run-prefixed name (the teardown's ownership rule is a
 * prefix test, so a leading space would leave the registered certificate on the tier), and carries the RFC 4514 special
 * characters after it: `<run name>, O= QA+Team` (comma and plus are escaped in the stored DN: `\, O= QA\+Team`).
 */
export const specialCharCn = (name: string): string => `${name}, O= QA+Team`;

/** A fresh RSA-2048 key pair (forge). */
export const newKeyPair = (): forge.pki.rsa.KeyPair => forge.pki.rsa.generateKeyPair(2048);

/** RDN types of an RFC 4514 string the forge subject builder knows (others are passed by OID through `shortName`). */
const RDN_NAMES: Readonly<Record<string, string>> = {
    CN: 'commonName', O: 'organizationName', OU: 'organizationalUnitName', L: 'localityName', ST: 'stateOrProvinceName', C: 'countryName',
    E: 'emailAddress', EMAILADDRESS: 'emailAddress', EMAIL: 'emailAddress', DC: 'domainComponent', SN: 'surname', GN: 'givenName', SERIALNUMBER: 'serialNumber',
    STREET: 'streetAddress', T: 'title',
};

/**
 * The RDNs of an RFC 4514 subject DN string (`CN=a,O=b`) as forge subject attributes, in the string's order; an escaped
 * comma / plus / equals inside a value is unescaped. A rekey CSR must carry the ISSUED certificate's subject, which the
 * CA may have completed (core compares the normalized X500 names: `validateSubjectDnForCertificate`, Sonnet 3).
 */
export function subjectAttributesOf(subjectDn: string): Array<{ name?: string; shortName?: string; value: string }> {
    const parts: string[] = [];
    let cur = '';
    for (let i = 0; i < subjectDn.length; i++) {
        const ch = subjectDn[i];
        if (ch === '\\' && i + 1 < subjectDn.length) {
            cur += subjectDn[i + 1];
            i++;
        } else if (ch === ',') {
            parts.push(cur);
            cur = '';
        } else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean).map((p) => {
        const eq = p.indexOf('=');
        const type = p.slice(0, eq).trim().toUpperCase();
        const value = p.slice(eq + 1).trim();
        const name = RDN_NAMES[type];
        return name ? { name, value } : { shortName: type, value };
    });
}

/** An RSA CSR for a given key pair whose subject is the full `subjectDn` (not only a CN), with the SANs. */
export function csrFromKeyWithSubject(keys: forge.pki.rsa.KeyPair, subjectDn: string, sans: Partial<SanSet> = {}): GeneratedCsr {
    const dns = sans.dns ?? [];
    const ip = sans.ip ?? [];
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject(subjectAttributesOf(subjectDn));
    const altNames = [...dns.map((value) => ({ type: 2, value })), ...ip.map((value) => ({ type: 7, ip: value }))];
    if (altNames.length) csr.setAttributes([{ name: 'extensionRequest', extensions: [{ name: 'subjectAltName', altNames }] }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const derBuffer = Buffer.from(forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes(), 'binary');
    const spki = Buffer.from(forge.asn1.toDer(forge.pki.publicKeyToAsn1(keys.publicKey)).getBytes(), 'binary').toString('base64');
    return {
        pem: forge.pki.certificationRequestToPem(csr),
        derBase64: derBuffer.toString('base64'),
        derBase64Url: derBuffer.toString('base64url'),
        publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
        spkiBase64: spki,
        privateKeyPem: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keys.privateKey))),
        sans: { dns: [...dns], ip: [...ip] },
        keyType: 'rsa-2048',
    };
}

/**
 * An RSA CSR whose SAN carries an rfc822Name (e-mail) next to the CN: the EJBCA-NG end-entity profile of the tiers
 * refuses it (ilm#429 step 1, rule API-12), which is the only shared-tier producer of a `failed` certificate
 * (API-CERT-08 failed row, API-CERT-35). Returns the PEM / base64 DER like `csrFromKey`.
 */
export function csrWithEmailSan(commonName: string, email: string): { pem: string; derBase64: string } {
    const keys = newKeyPair();
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: commonName }]);
    csr.setAttributes([{ name: 'extensionRequest', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: commonName }, { type: 1, value: email }] }] }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes(), 'binary');
    return { pem: forge.pki.certificationRequestToPem(csr), derBase64: der.toString('base64') };
}

/**
 * `POST …/certificates` (v2 issue) with an external CSR; the answer is NOT asserted here: whatever uuid the platform
 * made is recorded first (ledger before assertion), then the caller asserts the contract.
 */
export async function submitOwnCertificate(api: GuardedApi, ra: RaLike, spec: string, opts: IssueOptions = {}): Promise<OwnCertificate> {
    const cn = certificateName(opts.suffix);
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): a documentation address, never a real host.
    const sans: SanSet = { dns: opts.sans?.dns ?? [cn], ip: opts.sans?.ip ?? ['192.0.2.20'] };
    const keys = opts.keys ?? newKeyPair();
    const csr = csrFromKey(keys, cn, sans);
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates`, { request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [], ...(opts.body ?? {}) });
    const uuid = (answer.json as Json | undefined)?.uuid;
    if (typeof uuid !== 'string') throw new Error(`v2 issue answered ${answer.status} without a uuid: ${answer.text.slice(0, 300)}`);
    const ref = recordCreated('certificates', { uuid, name: cn }, spec, opts.note ?? 'issued via API (lifecycle)', { raProfile: ra.uuid, authority: ra.authorityUuid });
    return { ...ref, cn, sans, csr, keys, ra, createdAfter: createdAfterOf(answer), answer };
}

/** `submitOwnCertificate`, then the wait for `issued` (fail-fast on failed / rejected) and the derived-key record. */
export async function issueOwnCertificate(api: GuardedApi, ra: RaLike, spec: string, opts: IssueOptions & { timeoutMs?: number } = {}): Promise<OwnCertificate> {
    const cert = await submitOwnCertificate(api, ra, spec, opts);
    if (cert.answer.status !== 200) throw new Error(`v2 issue answered ${cert.answer.status}: ${cert.answer.text.slice(0, 300)}`);
    await waitForCertificateState(api, cert.uuid, 'issued', opts.timeoutMs ?? 180_000);
    await recordDerivedKeyOf(api, cert.uuid, cert.createdAfter, spec);
    return cert;
}

/** The run RA profile as a `RaLike` (name included), with the deploy gate as a skip. */
export async function runRaProfile(api: GuardedApi, spec: string): Promise<RunRaProfile & RaLike> {
    return ensureRaProfile(api, spec);
}

/**
 * Observed states of a certificate until it reaches `target` (distinct, in order of first observation): the state
 * walk oracle of API-CERT-01 ("a subsequence of requested, pending_issue, issued"). Fails fast on `failed` / `rejected`.
 */
export async function observeStatesUntil(api: APIRequestContext, uuid: string, target: string, timeoutMs: number): Promise<{ states: string[]; elapsedMs: number }> {
    const started = Date.now();
    const states: string[] = [];
    for (;;) {
        const res = await api.get(`/api/v1/certificates/${uuid}`);
        if (res.ok()) {
            const state = String(((await res.json()) as Json).state ?? '');
            if (state && states[states.length - 1] !== state) states.push(state);
            if (state === target) return { states, elapsedMs: Date.now() - started };
            if (state === 'failed' || state === 'rejected') throw new Error(`certificate ${uuid} reached ${state} instead of ${target} (observed ${states.join(' → ')})`);
        } else if (res.status() >= 500) {
            throw new Error(`certificate ${uuid}: GET answered ${res.status()} while observing states`);
        }
        if (Date.now() - started > timeoutMs) throw new Error(`certificate ${uuid} did not reach ${target} within ${timeoutMs} ms (observed ${states.join(' → ')})`);
        await sleep(1000);
    }
}

/** `expected` contains `observed` in order (every observed state appears, in order; nothing else). */
export function isSubsequenceOf(observed: readonly string[], expected: readonly string[]): boolean {
    let i = 0;
    for (const s of observed) {
        while (i < expected.length && expected[i] !== s) i++;
        if (i === expected.length) return false;
        i++;
    }
    return true;
}

// ------------------------------------------------------------------ renew, rekey, revoke, issue-existing, probes

export interface SuccessorAnswer extends RawAnswer {
    /** The successor the platform made (recorded), when the answer carried a uuid. */
    successor?: OwnRef;
    createdAfter?: string;
}

/** Records a successor named by an answer (ledger before assertion); the successor keeps the predecessor's CN. */
function recordSuccessor(answer: RawAnswer, cert: OwnRef, ra: RaLike, spec: string, note: string): SuccessorAnswer {
    const uuid = (answer.json as Json | undefined)?.uuid;
    if (typeof uuid !== 'string') return { ...answer };
    const successor = recordCreated('certificates', { uuid, name: cert.name }, spec, note, { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: cert.uuid });
    return { ...answer, successor, createdAfter: createdAfterOf(answer) };
}

export interface RenewOptions {
    /** Base64 DER CSR on the SAME key (RR-5); omitted = "Existing CSR will be used". */
    csrDerBase64?: string;
    authorizationSecret?: string;
    note?: string;
    identityOverride?: RawOptions;
}

/** `POST …/certificates/{own}/renew`; the successor (if any) is recorded; the answer is returned unasserted. */
export async function renewOwn(api: GuardedApi, cert: OwnRef, ra: RaLike, spec: string, opts: RenewOptions = {}): Promise<SuccessorAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'renewOwn');
    const body: Json = { format: 'pkcs10', attributes: [] };
    if (opts.csrDerBase64) body.request = opts.csrDerBase64;
    if (opts.authorizationSecret !== undefined) body.authorizationSecret = opts.authorizationSecret;
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/renew`, body, opts.identityOverride);
    return recordSuccessor(answer, cert, ra, spec, opts.note ?? 'renew successor');
}

export interface RekeyOptions {
    /** Base64 DER CSR on a NEW key with the same subject (RR-6). */
    csrDerBase64: string;
    authorizationSecret?: string;
    note?: string;
}

/** `POST …/certificates/{own}/rekey`; the successor (if any) is recorded; the answer is returned unasserted. */
export async function rekeyOwn(api: GuardedApi, cert: OwnRef, ra: RaLike, spec: string, opts: RekeyOptions): Promise<SuccessorAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'rekeyOwn');
    const body: Json = { request: opts.csrDerBase64, format: 'pkcs10', attributes: [] };
    if (opts.authorizationSecret !== undefined) body.authorizationSecret = opts.authorizationSecret;
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/rekey`, body);
    return recordSuccessor(answer, cert, ra, spec, opts.note ?? 'rekey successor');
}

export interface RevokeOptions {
    /** Wire code (`keyCompromise`, …); omitted = the platform default `unspecified`. */
    reason?: string;
    destroyKey?: boolean;
    attributes?: Json[];
}

/** `POST …/certificates/{own}/revoke` (RV-1: 204, asynchronous completion); the answer is returned unasserted. */
export async function revokeOwn(api: GuardedApi, cert: OwnRef, ra: RaLike, opts: RevokeOptions = {}): Promise<RawAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'revokeOwn');
    const body: Json = { attributes: opts.attributes ?? [], destroyKey: opts.destroyKey ?? false };
    if (opts.reason !== undefined) body.reason = opts.reason;
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/revoke`, body);
}

export interface IssueExistingOptions {
    /** The operator's CSR (base64 DER): required for a REGISTERED certificate (PR-6). */
    request?: string;
    format?: string;
    /** The registration challenge; `null` sends the JSON null (a "missing" variant), undefined omits the field. */
    authorizationSecret?: string | null;
    body?: Json;
}

/**
 * `POST …/certificates/{own}/issue`: completion of a registered certificate, or the issue of a `requested` one
 * (API-11 / PR-6). The answer is returned unasserted (200 or the 422 texts of the decision table).
 */
export async function issueExisting(api: GuardedApi, cert: OwnRef, ra: RaLike, opts: IssueExistingOptions = {}): Promise<RawAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'issueExisting');
    const body: Json = { attributes: [], ...(opts.body ?? {}) };
    if (opts.request !== undefined) {
        body.request = opts.request;
        body.format = opts.format ?? 'pkcs10';
    }
    if (opts.authorizationSecret !== undefined) body.authorizationSecret = opts.authorizationSecret;
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/issue`, body);
}

/** The three parked-operation endpoints (RV-8 / §7.4): finalize, confirm revoke, cancel. Each answer unasserted. */
export async function finalizeIssue(api: GuardedApi, cert: OwnRef, ra: RaLike): Promise<RawAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'finalizeIssue');
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/issue/finalize`, { identifyAttributes: [] });
}

export async function confirmRevoke(api: GuardedApi, cert: OwnRef, ra: RaLike): Promise<RawAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'confirmRevoke');
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/revoke/confirm`);
}

export async function cancelPending(api: GuardedApi, cert: OwnRef, ra: RaLike): Promise<RawAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'cancelPending');
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/cancel`, {});
}

// ------------------------------------------------------------------ register and complete (pre-registration)

/** A challenge secret: 12–255 printable ASCII (PR-3); run-prefixed so a log line never looks like a real secret. */
export const newChallenge = (): string => `${RUN_ID}-s-${Math.random().toString(36).slice(2, 10)}${stamp()}`;

/**
 * The `commonName` request attribute of the RA profile's resolved request-attribute set
 * (`GET /v1/certificates/csr/attributes?raProfileUuid=`), as a request attribute carrying `cn`. Without the set (an
 * RA profile the suite may not query) the platform default definition (core `CsrAttributes`, a fixed uuid) is used.
 */
export async function cnRequestAttribute(api: APIRequestContext, ra: Pick<RaLike, 'uuid'>, cn: string): Promise<Json> {
    const DEFAULT_CN = { uuid: '9abaeba0-973d-11ed-a8fc-0242ac120002', name: 'commonName', contentType: 'string', version: 'v3' };
    let def: Json = DEFAULT_CN;
    try {
        const defs = await apiJson<Json[]>(api, 'GET', `/api/v1/certificates/csr/attributes?raProfileUuid=${encodeURIComponent(ra.uuid)}`);
        const found = (defs ?? []).find((d) => d.name === 'commonName');
        if (found) def = found;
    } catch (e) {
        logger.warn(`csr attributes of RA profile ${ra.uuid} not readable (${String(e).slice(0, 120)}); using the platform default CN definition`);
    }
    return { version: requestVersion(def, 'v3'), uuid: def.uuid, name: def.name, contentType: def.contentType ?? 'string', content: [{ data: cn }] };
}

export interface RegisterOptions {
    suffix?: string;
    /** The challenge; `undefined` registers without one (no authorization row, PR-3). */
    secret?: string;
    /** ISO date of the issuance window (only with a secret). */
    expiresAt?: string;
    /** Replaces the CN request attribute (negatives: special characters, two identities, …). */
    cn?: string;
    body?: Json;
    note?: string;
}

export interface Registration {
    answer: RawAnswer;
    cn: string;
    secret?: string;
    /** The placeholder the platform made (recorded), when the answer carried a uuid. */
    cert?: OwnRef;
    createdAfter?: string;
}

/**
 * `POST …/certificates/register` (platform-level pre-registration, PR-2 / PR-5) with the CN as `csrAttributes` and an
 * optional challenge; the placeholder is recorded before any assertion. GUARD REQUEST (lifecycle-shared-patches
 * README): the route is a create and must be on the guard's POST_CREATE list; until then the guard refuses it.
 */
export async function registerOwn(api: GuardedApi, ra: RaLike, spec: string, opts: RegisterOptions = {}): Promise<Registration> {
    const cn = opts.cn ?? certificateName(opts.suffix ?? 'reg');
    const body: Json = { csrAttributes: [await cnRequestAttribute(api, ra, cn)], attributes: [], customAttributes: [], ...(opts.body ?? {}) };
    if (opts.secret !== undefined) body.authorizationSecret = opts.secret;
    if (opts.expiresAt !== undefined) body.expiresAt = opts.expiresAt;
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/register`, body);
    const uuid = (answer.json as Json | undefined)?.uuid;
    const cert = typeof uuid === 'string'
        ? recordCreated('certificates', { uuid, name: cn }, spec, opts.note ?? `pre-registered via API${opts.secret ? ' with a challenge' : ''}`, { raProfile: ra.uuid, authority: ra.authorityUuid })
        : undefined;
    return { answer, cn, secret: opts.secret, cert, createdAfter: createdAfterOf(answer) };
}

/** The `registration` block of a certificate detail (`CertificateRegistrationDetailDto`), or undefined. */
export async function registrationOf(api: APIRequestContext, uuid: string): Promise<{ state?: string; expiresAt?: string; failedAttempts?: number } | undefined> {
    const cert = await getCertificate(api, uuid);
    return cert.registration ?? undefined;
}

/** `defaultIssuanceWindowDays` / `maxFailedAttempts` of the tier (read, never set; core defaults 7 / 5 when unset). */
export async function registrationDefaults(api: APIRequestContext): Promise<{ defaultIssuanceWindowDays: number; maxFailedAttempts: number }> {
    const settings = await apiJson<Json>(api, 'GET', '/api/v1/settings/platform');
    const r: Json = settings?.certificates?.registration ?? {};
    return { defaultIssuanceWindowDays: Number(r.defaultIssuanceWindowDays ?? 7), maxFailedAttempts: Number(r.maxFailedAttempts ?? 5) };
}

/**
 * Whether certificate validation runs for the certificates of an RA profile (Haiku F1 preflight): the RA profile's own
 * `certificateValidationSettings.enabled`, else the platform `certificates.validation.enabled`; undefined = not readable.
 */
export async function validationEnabledFor(api: APIRequestContext, ra: Pick<RaLike, 'uuid'>): Promise<boolean | undefined> {
    const profile = await apiJson<Json>(api, 'GET', `/api/v1/raProfiles/${ra.uuid}`).catch(() => undefined);
    const own = profile?.certificateValidationSettings?.enabled;
    if (typeof own === 'boolean') return own;
    const settings = await apiJson<Json>(api, 'GET', '/api/v1/settings/platform').catch(() => undefined);
    const platform = settings?.certificates?.validation?.enabled;
    return typeof platform === 'boolean' ? platform : undefined;
}

/** `GET /v1/certificates/{own}/validate`: re-runs the validation of an OWN certificate (a side-effect GET the guard admits on own objects only). */
export async function revalidate(api: GuardedApi, cert: OwnRef): Promise<Json> {
    await assertOwnLive(api, 'certificates', cert, 'revalidate');
    return apiJson<Json>(api, 'GET', `/api/v1/certificates/${cert.uuid}/validate`);
}

/** |a − b| in milliseconds of two ISO / Date values. */
export const msBetween = (a: string | Date, b: string | Date): number => Math.abs(new Date(a).getTime() - new Date(b).getTime());

// ------------------------------------------------------------------ RA+ clones and the approval gate

/**
 * An OWN, ENABLED clone of the run RA profile (`RA+`): the same authority and connector attributes (read-only copy), an
 * own name. Flags and associations are flipped on the clone only, never on the run RA profile.
 */
export async function cloneRunRaProfile(api: GuardedApi, spec: string, suffix: string): Promise<OwnRef & RaLike> {
    const run = await ensureRaProfile(api, spec);
    const name = regName(`ra-${suffix}-${stamp()}`);
    const ref = recordCreated('raProfiles', await createRaProfileLike(api, { uuid: run.uuid, authorityUuid: run.authorityUuid }, name), spec,
        `RA+ clone of the run RA profile (${suffix})`, { authority: run.authorityUuid });
    await enableOwnRaProfile(api, run.authorityUuid, ref);
    return { ...ref, authorityUuid: run.authorityUuid };
}

/**
 * The run's approval profile (`AP`, run state `approvalProfile`): one step, approver = the run's OWN role (the body may
 * name own objects only), 1 required approval, 24 h expiry. Decisions go through the override path (AP-6), so the
 * approver identity never has to sign in.
 */
export async function ensureApprovalProfile(api: GuardedApi, spec: string): Promise<OwnRef> {
    const state = readState();
    if (state.approvalProfile) return state.approvalProfile;
    const role = await ensureRole(api, spec);
    const name = regName('ap');
    const created = await apiJson<Json>(api, 'POST', '/api/v1/approvalProfiles', {
        name,
        description: `REG run ${RUN_ID}`,
        enabled: true,
        expiry: 24,
        approvalSteps: [{ roleUuid: role.uuid, order: 1, requiredApprovals: 1, description: `REG run ${RUN_ID} step` }],
    });
    const ref = recordCreated('approvalProfiles', { uuid: created.uuid, name }, spec, 'API prerequisite; one step, approver = the run role');
    updateState({ approvalProfile: ref });
    return ref;
}

/** `PATCH /v1/approvalProfiles/{own}/associations/raProfiles/{own}` (AP-2; both objects own). */
export async function associateApprovalProfile(api: GuardedApi, approvalProfile: OwnRef, ra: OwnRef): Promise<void> {
    await assertOwnLive(api, 'approvalProfiles', approvalProfile, 'associateApprovalProfile (approval profile)');
    await assertOwnLive(api, 'raProfiles', ra, 'associateApprovalProfile (RA profile)');
    await apiJson(api, 'PATCH', `/api/v1/approvalProfiles/${approvalProfile.uuid}/associations/raProfiles/${ra.uuid}`);
}

/** `DELETE …/associations/raProfiles/{own}`: a 404 (already gone) is accepted. */
export async function dissociateApprovalProfile(api: GuardedApi, approvalProfile: OwnRef, ra: OwnRef): Promise<void> {
    await assertOwnLive(api, 'approvalProfiles', approvalProfile, 'dissociateApprovalProfile (approval profile)');
    await assertOwnLive(api, 'raProfiles', ra, 'dissociateApprovalProfile (RA profile)');
    const a = await sendRaw(api, 'DELETE', `/api/v1/approvalProfiles/${approvalProfile.uuid}/associations/raProfiles/${ra.uuid}`);
    if (a.status !== 204 && a.status !== 404) throw new Error(`dissociate approval profile answered ${a.status}: ${a.text.slice(0, 300)}`);
}

export interface ApprovalGate {
    /** The own RA+ clone every gated call goes through. */
    ra: OwnRef & RaLike;
    approvalProfile: OwnRef;
    /** Associate the approval profile with the clone (idempotent on the gate object). */
    associate(): Promise<void>;
    /** Remove the association (the spec's `afterAll`; the run-end teardown revokes own certificates ungated). */
    release(): Promise<void>;
}

/** An RA+ clone with the run approval profile; `associate: false` leaves the clone ungated until `associate()`. */
export async function openApprovalGate(api: GuardedApi, spec: string, suffix: string, opts: { associate?: boolean } = {}): Promise<ApprovalGate> {
    const ra = await cloneRunRaProfile(api, spec, suffix);
    const approvalProfile = await ensureApprovalProfile(api, spec);
    let associated = false;
    const gate: ApprovalGate = {
        ra,
        approvalProfile,
        async associate() {
            if (associated) return;
            await associateApprovalProfile(api, approvalProfile, ra);
            associated = true;
        },
        async release() {
            if (!associated) return;
            await dissociateApprovalProfile(api, approvalProfile, ra);
            associated = false;
        },
    };
    if (opts.associate !== false) await gate.associate();
    return gate;
}

// ------------------------------------------------------------------ approvals (override path)

/** The approvals of a certificate (`GET /v1/certificates/{uuid}/approvals`, a plain read). */
export async function approvalsOf(api: APIRequestContext, certificateUuid: string): Promise<Json[]> {
    const body = await apiJson<Json>(api, 'GET', `/api/v1/certificates/${certificateUuid}/approvals`);
    return (body?.approvals ?? []) as Json[];
}

export interface OwnApproval extends OwnRef {
    /** The `ApprovalDto` row as listed on the certificate. */
    row: Json;
}

/**
 * The approval the listener raised for an own certificate (AP-4 is asynchronous: polled up to `timeoutMs`), recorded
 * in the ledger as an `approvals` line (id-named type) so the guard admits the override decision and the detail read.
 */
/**
 * The API answers an approval status with the enum NAME (`PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`: ApprovalStatusEnum has no
 * `@JsonValue`), the UI with the label (`Pending`). Live run 2: comparing `=== 'Pending'` never matched, so no approval was found
 * and the teardown never rejected a pending one (an approval profile was left per run). Compare through these two.
 */
export const approvalStatusLabel = (status: unknown): string => {
    const t = String(status ?? '').trim().toLowerCase();
    return t ? t[0].toUpperCase() + t.slice(1) : '';
};
export const sameApprovalStatus = (a: unknown, b: unknown): boolean => approvalStatusLabel(a) === approvalStatusLabel(b);

export async function findApproval(api: APIRequestContext, cert: OwnRef, spec: string, opts: { timeoutMs?: number; status?: string } = {}): Promise<OwnApproval> {
    const started = Date.now();
    const timeout = opts.timeoutMs ?? 60_000;
    for (;;) {
        const rows = await approvalsOf(api, cert.uuid);
        // The status filter holds: a closed approval never stands in for the Pending one a decision needs (Sonnet 4).
        const row = rows.find((r) => !opts.status || sameApprovalStatus(r.status, opts.status));
        if (row && typeof row.approvalUuid === 'string') {
            const uuid = String(row.approvalUuid);
            const name = regName(`approval-${uuid.slice(0, 8)}`);
            const ref = ownership({ uuid }).own ? ({ uuid, name, kind: 'own' } as OwnRef) : recordCreated('approvals', { uuid, name }, spec, `approval ${row.resourceAction ?? ''} of an own certificate`, { certificate: cert.uuid });
            return { ...ref, row };
        }
        if (Date.now() - started > timeout) throw new Error(`certificate ${cert.uuid}: no approval listed within ${timeout} ms`);
        await sleep(1000);
    }
}

/** `GET /v1/approvals/{own}` (a side-effect GET: the guard admits it on an own approval only). */
export async function approvalDetail(api: GuardedApi, approval: OwnRef): Promise<Json> {
    return apiJson<Json>(api, 'GET', `/api/v1/approvals/${approval.uuid}`);
}

export async function waitForApprovalStatus(api: GuardedApi, approval: OwnRef, status: string, timeoutMs = 60_000): Promise<Json> {
    const started = Date.now();
    for (;;) {
        const d = await approvalDetail(api, approval);
        if (sameApprovalStatus(d.status, status)) return d;
        if (Date.now() - started > timeoutMs) throw new Error(`approval ${approval.uuid}: status ${d.status}, not ${status} within ${timeoutMs} ms`);
        await sleep(1000);
    }
}

/** The override decision (`PATCH /v1/approvals/{own}/approve|reject`, AP-6: 204, recipient comment "Approval flow overridden"). */
export async function decideApproval(api: GuardedApi, approval: OwnRef, decision: 'approve' | 'reject'): Promise<RawAnswer> {
    await assertOwnLive(api, 'approvals', approval, `decideApproval (${decision})`);
    return sendRaw(api, 'PATCH', `/api/v1/approvals/${approval.uuid}/${decision}`);
}

/** The recipient comments of an approval detail (`approvalSteps[].approvalStepRecipients[].comment`). */
export function recipientComments(detail: Json): string[] {
    return ((detail?.approvalSteps ?? []) as Json[]).flatMap((s) => ((s.approvalStepRecipients ?? []) as Json[]).map((r) => String(r.comment ?? ''))).filter(Boolean);
}

// ------------------------------------------------------------------ relations and history

export async function relationsOf(api: APIRequestContext, uuid: string): Promise<{ successors: Json[]; predecessors: Json[] }> {
    const body = await apiJson<Json>(api, 'GET', `/api/v1/certificates/${uuid}/relations`);
    return { successors: (body?.successorCertificates ?? []) as Json[], predecessors: (body?.predecessorCertificates ?? []) as Json[] };
}

/** The certificate history (`CertificateEventHistoryDto[]`) oldest first. */
export async function historyOf(api: APIRequestContext, uuid: string): Promise<Json[]> {
    const rows = await apiJson<Json[]>(api, 'GET', `/api/v1/certificates/${uuid}/history`);
    return sortedHistory(rows ?? []);
}

/**
 * Oldest first by `created`. The server lists the history NEWEST first, so two rows with the same timestamp keep that
 * order reversed (the later server row is the older one); rows without a parsable date keep their relative order.
 */
export function sortedHistory(rows: readonly Json[]): Json[] {
    return rows.map((r, i) => ({ r, i, t: Date.parse(String(r.created ?? '')) }))
        .sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) ? b.i - a.i : a.t - b.t || b.i - a.i))
        .map((x) => x.r);
}

export const historyMessages = (rows: readonly Json[]): string[] => rows.map((r) => String(r.message ?? ''));

/** The `CertificateEvent` JSON codes (`@JsonValue`: the label text), keyed by the enum name the rules use. */
export const EVENT_CODES: Readonly<Record<string, string>> = {
    ISSUE: 'Issue Certificate',
    REQUEST: 'Request Certificate',
    RENEW: 'Renew Certificate',
    REKEY: 'Rekey Certificate',
    REVOKE: 'Revoke Certificate',
    APPROVAL_REQUEST: 'Approve action requested',
    APPROVAL_CLOSE: 'Approve action closed',
    UPDATE_STATE: 'Update State',
};

export type HistoryStep = [event: keyof typeof EVENT_CODES, status: 'SUCCESS' | 'FAILED'];

/**
 * The problem with a history that does not carry `expected` (event / status pairs) in order — presence and order only,
 * never counts (rules §10 C13) — or undefined when it does.
 */
export function historyOrderProblem(rows: readonly Json[], expected: readonly HistoryStep[]): string | undefined {
    const seq = sortedHistory(rows).map((r) => `${String(r.event)}/${String(r.status)}`);
    let from = 0;
    for (const [event, status] of expected) {
        const want = `${EVENT_CODES[event]}/${status}`;
        const at = seq.indexOf(want, from);
        if (at < 0) return `missing ${want} after position ${from} in [${seq.join(', ')}]`;
        from = at + 1;
    }
    return undefined;
}

// ------------------------------------------------------------------ teardown handlers (runTeardown HANDLER_MODULES → lifecycle)

const EXISTING_APPROVALS = /existing approvals/i;

/**
 * `approvals` (step 1 of the teardown order): a Pending approval of an own certificate is REJECTED through the override
 * path (the certificate then leaves `pending_approval`); approvals are never deleted by the platform, so the line is
 * reported as kept with its final status. `approvalProfiles` (step 12): its remaining associations on own RA profiles
 * are removed, then the delete is attempted; a profile that has approvals cannot be deleted (core
 * ApprovalProfileServiceImpl) and is reported as kept, naming the rule. Both send their mutations through the guard
 * (`guardApi` over the teardown's context: ledger lines of this run, dry run honoured).
 */
export const teardownHandlers: Record<string, TeardownHandler> = {
    approvals: {
        action: 'reject through the override path when still Pending; approvals are retained by the platform (kept, reported)',
        async remove(ctx, line) {
            // The guard over the teardown's own context (never disposed here: the context serves every object).
            const api = guardApi(ctx.api);
            const detail = await apiJson<Json>(api, 'GET', `/api/v1/approvals/${line.uuid}`);
            if (sameApprovalStatus(detail.status, 'Pending')) {
                const a = await sendRaw(api, 'PATCH', `/api/v1/approvals/${line.uuid}/reject`);
                if (a.status !== 204) throw new Error(`approval ${line.uuid}: override reject answered ${a.status}: ${a.text.slice(0, 200)}`);
                ctx.warn(`kept approval ${line.uuid}: was Pending, rejected through the override path; the platform retains approvals`);
            } else {
                ctx.warn(`kept approval ${line.uuid}: status ${String(detail.status)}; the platform retains approvals`);
            }
            return 'kept';
        },
    },
    approvalProfiles: {
        action: 'remove its associations on own RA profiles, then DELETE /v1/approvalProfiles/{uuid}; a profile with approvals cannot be deleted (kept, reported)',
        async remove(ctx, line) {
            const api = guardApi(ctx.api);
            {
                const associations = await apiJson<Json[]>(api, 'GET', `/api/v1/approvalProfiles/${line.uuid}/associations`).catch(() => [] as Json[]);
                for (const a of associations ?? []) {
                    const raUuid = String(a.objectUuid ?? a.uuid ?? '');
                    const own = ownership({ uuid: raUuid });
                    if (own.own && own.line?.type === 'raProfiles') {
                        const d = await sendRaw(api, 'DELETE', `/api/v1/approvalProfiles/${line.uuid}/associations/raProfiles/${raUuid}`);
                        if (d.status !== 204 && d.status !== 404) throw new Error(`approval profile ${line.uuid}: dissociating RA profile ${raUuid} answered ${d.status}`);
                    } else {
                        ctx.warn(`approval profile ${line.uuid}: association with ${String(a.resource ?? 'object')} ${raUuid} is not this run's; left as is`);
                    }
                }
                const del = await sendRaw(api, 'DELETE', `/api/v1/approvalProfiles/${line.uuid}`);
                if (del.status === 422 && EXISTING_APPROVALS.test(del.text)) {
                    ctx.warn(`kept approval profile ${line.uuid}: the platform refuses to delete an approval profile with approvals ("Unable to delete approval profile with existing approvals.")`);
                    return 'kept';
                }
                if (del.status !== 204 && del.status !== 200) throw new Error(`approval profile ${line.uuid}: DELETE answered ${del.status}: ${del.text.slice(0, 200)}`);
                for (let i = 0; i < 5; i++) {
                    const res = await ctx.api.get(`/api/v1/approvalProfiles/${line.uuid}`);
                    if (res.status() === 404) return;
                    await sleep(ctx.pollMs ?? 1000);
                }
                throw new Error(`approval profile ${line.uuid}: the delete was answered but the detail still answers; absence not proven`);
            }
        },
    },
};
