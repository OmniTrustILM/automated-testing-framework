/**
 * certificateOperations — renew, rekey, revoke, issue of an existing certificate and the parked-operation probes
 * (finalize, confirm revoke, cancel) on OWN certificates through the guarded api, plus the state-walk observer of an
 * issuance. Every successor the platform makes is recorded in the ledger right after the call, before any assertion;
 * answers are returned unasserted.
 */
import type { APIRequestContext } from '@playwright/test';
import { assertOwnLive } from '../ledger/ownership';
import type { RaLike } from '../ownRaProfiles';
import type { GuardedApi } from '../guard/types';
import { isJsonObject, JsonObject } from '../json';
import { OwnRef, recordCreated } from '../ledger/ledger';
import { pollUntil } from '../wait';
import { opsBase } from './certificateLabels';
import { createdAfterOfAnswer, RawOptions, sendRaw } from './rawAnswers';
import { ApiAnswer } from '../apiReads';

/**
 * Observed states of a certificate until it reaches `target` (distinct, in order of first observation): the state
 * walk oracle of API-CERT-01 ("a subsequence of requested, pending_issue, issued"). Fails fast on `failed` / `rejected`.
 */
export async function observeStatesUntil(api: APIRequestContext, uuid: string, target: string, timeoutMs: number): Promise<{ states: string[]; elapsedMs: number }> {
    const started = Date.now();
    const states: string[] = [];
    const last = await pollUntil(async () => {
        const res = await api.get(`/api/v1/certificates/${uuid}`);
        if (res.ok()) {
            const body: unknown = await res.json();
            const state = String((isJsonObject(body) ? body.state : undefined) ?? '');
            if (state && states[states.length - 1] !== state) states.push(state);
            if (state === 'failed' || state === 'rejected') throw new Error(`certificate ${uuid} reached ${state} instead of ${target} (observed ${states.join(' → ')})`);
            return state;
        }
        if (res.status() >= 500) throw new Error(`certificate ${uuid}: GET answered ${res.status()} while observing states`);
        return '';
    }, (state) => state === target, { timeoutMs, intervalMs: 1000, tolerateErrors: 0, onTimeout: 'return' });
    if (last !== target) throw new Error(`certificate ${uuid} did not reach ${target} within ${timeoutMs} ms (observed ${states.join(' → ')})`);
    return { states, elapsedMs: Date.now() - started };
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

export interface SuccessorAnswer extends ApiAnswer {
    /** The successor the platform made (recorded), when the answer carried a uuid. */
    successor?: OwnRef;
    createdAfter?: string;
}

/** Records a successor named by an answer (ledger before assertion); the successor keeps the predecessor's CN. */
function recordSuccessor(answer: ApiAnswer, cert: OwnRef, ra: RaLike, spec: string, note: string): SuccessorAnswer {
    const uuid = isJsonObject(answer.json) ? answer.json.uuid : undefined;
    if (typeof uuid !== 'string') return { ...answer };
    const successor = recordCreated('certificates', { uuid, name: cert.name }, { spec, note, parents: { raProfile: ra.uuid, authority: ra.authorityUuid, predecessor: cert.uuid } });
    return { ...answer, successor, createdAfter: createdAfterOfAnswer(answer) };
}

export interface RenewOptions {
    /** Base64 DER CSR on the SAME key; omitted = "Existing CSR will be used". */
    csrDerBase64?: string;
    authorizationSecret?: string;
    note?: string;
    identityOverride?: RawOptions;
}

/** `POST …/certificates/{own}/renew`; the successor (if any) is recorded; the answer is returned unasserted. */
export async function renewOwnCertificate(api: GuardedApi, cert: OwnRef, ra: RaLike, spec: string, opts: RenewOptions = {}): Promise<SuccessorAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'renewOwnCertificate');
    const body: JsonObject = { format: 'pkcs10', attributes: [] };
    if (opts.csrDerBase64) body.request = opts.csrDerBase64;
    if (opts.authorizationSecret !== undefined) body.authorizationSecret = opts.authorizationSecret;
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/renew`, body, opts.identityOverride);
    return recordSuccessor(answer, cert, ra, spec, opts.note ?? 'renew successor');
}

export interface RekeyOptions {
    /** Base64 DER CSR on a NEW key with the same subject. */
    csrDerBase64: string;
    authorizationSecret?: string;
    note?: string;
}

/** `POST …/certificates/{own}/rekey`; the successor (if any) is recorded; the answer is returned unasserted. */
export async function rekeyOwnCertificate(api: GuardedApi, cert: OwnRef, ra: RaLike, spec: string, opts: RekeyOptions): Promise<SuccessorAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'rekeyOwnCertificate');
    const body: JsonObject = { request: opts.csrDerBase64, format: 'pkcs10', attributes: [] };
    if (opts.authorizationSecret !== undefined) body.authorizationSecret = opts.authorizationSecret;
    const answer = await sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/rekey`, body);
    return recordSuccessor(answer, cert, ra, spec, opts.note ?? 'rekey successor');
}

export interface RevokeOptions {
    /** Wire code (`keyCompromise`, …); omitted = the platform default `unspecified`. */
    reason?: string;
    destroyKey?: boolean;
    attributes?: JsonObject[];
}

/** `POST …/certificates/{own}/revoke` (204, asynchronous completion); the answer is returned unasserted. */
export async function revokeOwnCertificate(api: GuardedApi, cert: OwnRef, ra: RaLike, opts: RevokeOptions = {}): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'revokeOwnCertificate');
    const body: JsonObject = { attributes: opts.attributes ?? [], destroyKey: opts.destroyKey ?? false };
    if (opts.reason !== undefined) body.reason = opts.reason;
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/revoke`, body);
}

export interface IssueExistingOptions {
    /** The operator's CSR (base64 DER): required for a REGISTERED certificate. */
    request?: string;
    format?: string;
    /** The registration challenge; `null` sends the JSON null (a "missing" variant), undefined omits the field. */
    authorizationSecret?: string | null;
    body?: JsonObject;
}

/**
 * `POST …/certificates/{own}/issue`: completion of a registered certificate, or the issue of a `requested` one
 * The answer is returned unasserted (200 or the 422 texts of the decision table).
 */
export async function issueExisting(api: GuardedApi, cert: OwnRef, ra: RaLike, opts: IssueExistingOptions = {}): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'issueExisting');
    const body: JsonObject = { attributes: [], ...(opts.body ?? {}) };
    if (opts.request !== undefined) {
        body.request = opts.request;
        body.format = opts.format ?? 'pkcs10';
    }
    if (opts.authorizationSecret !== undefined) body.authorizationSecret = opts.authorizationSecret;
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/issue`, body);
}

/** The three parked-operation endpoints: finalize, confirm revoke, cancel. Each answer unasserted. */
export async function finalizeIssue(api: GuardedApi, cert: OwnRef, ra: RaLike): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'finalizeIssue');
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/issue/finalize`, { identifyAttributes: [] });
}

export async function confirmRevoke(api: GuardedApi, cert: OwnRef, ra: RaLike): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'confirmRevoke');
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/revoke/confirm`);
}

export async function cancelPending(api: GuardedApi, cert: OwnRef, ra: RaLike): Promise<ApiAnswer> {
    await assertOwnLive(api, 'certificates', cert, 'cancelPending');
    return sendRaw(api, 'POST', `${opsBase(ra)}/certificates/${cert.uuid}/cancel`, {});
}
