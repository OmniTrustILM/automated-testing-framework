/**
 * issuedRecords — ledger before assertion for certificates and keys the PLATFORM made.
 *
 * Records the `certKey_<CN>` key linked to a run certificate, the certificates a protocol issued (ACME, cert-manager) under a
 * run-prefixed common name, and the ACME account the run registered.
 *
 * The teardown only removes what the ledger holds, so recording happens right after the call, before any assertion. A derived
 * key's age is judged on the server's clock; without one the key is kept and the teardown warns.
 */
import { APIRequestContext, expect } from '@playwright/test';
import { Logger } from '../Logger';
import { apiJson, getCertificate, searchCertificates } from './apiReads';
import { checkOwnership } from './ledger/ownership';
import { keepingBound, OwnRef, recordCreated, recordDerived } from './ledger/ledger';
import { runName } from './ledger/runState';
import { hasRunFamilyPrefix } from './run/runId';
import type { JsonObject } from './json';
import { objectOf } from './json';

const logger = new Logger('IssuedRecords');

/**
 * Records the key the platform linked to a run certificate (`certKey_<CN>`) as a DERIVED ledger object with the server-clock
 * `createdAfter`, so the run-end teardown removes it when the platform made it during the run and nothing uses it any more
 * (teardownHandlers `keys`). No key: nothing to record. No server time: the key is still recorded, with `keepingBound()`, so the teardown
 * keeps it (logged).
 */
export async function recordDerivedKeyOf(api: APIRequestContext, certificateUuid: string, createdAfter: string | undefined, spec: string): Promise<void> {
    const cert = await getCertificate(api, certificateUuid);
    const keyUuid = objectOf(cert.key).uuid as string | undefined;
    if (!keyUuid) {
        logger.info(`certificate ${certificateUuid}: no linked key; no derived key recorded`);
        return;
    }
    if (checkOwnership({ uuid: keyUuid }).own) return;
    let bound = createdAfter;
    if (!bound) {
        // Never a silent no-op: the key is recorded with a bound it can never reach, so the teardown keeps it with a
        // warning instead of deleting it on a guess — a visible, human-decided leftover.
        bound = keepingBound();
        logger.warn(`certificate ${certificateUuid}: no createdAfter for its key ${keyUuid}; recorded with a bound the teardown keeps (check by hand)`);
    }
    recordDerived('keys', { uuid: keyUuid, name: `key of certificate ${certificateUuid}` }, { spec, createdAfter: bound, note: 'key the platform linked to a run certificate', parents: { certificate: certificateUuid } });
}

/**
 * `recordDerivedKeyOf` after a `recordCreated`, with the by-name fallback of `recordingIssued`: when the
 * detail read throws, the run's certificates of `commonName` and their keys are recorded from the inventory instead;
 * a failure of that too surfaces (the test fails, the object is not silently left behind).
 */
export async function recordDerivedKeyOrNamed(api: APIRequestContext, certificateUuid: string, commonName: string, createdAfter: string | undefined, spec: string, note: string): Promise<void> {
    try {
        await recordDerivedKeyOf(api, certificateUuid, createdAfter, spec);
    } catch (e) {
        logger.warn(`recording the key of certificate ${certificateUuid} failed (${String(e).split('\n')[0].slice(0, 120)}); recording by name instead`);
        await recordIssuedNamed(api, commonName, createdAfter, spec, `${note} (recorded by name after a failed key read)`);
    }
}

/**
 * Ledger before assertion for objects a PROTOCOL made (ACME, cert-manager): every inventory certificate whose common
 * name is exactly `commonName` (a run-prefixed name, so only the run can have made it) and that is not in the ledger
 * yet is recorded as this run's. Returns the uuids found (recorded now or before).
 */
export async function recordCertificatesNamed(api: APIRequestContext, commonName: string, spec: string, note: string): Promise<string[]> {
    if (!hasRunFamilyPrefix(commonName)) throw new Error(`recordCertificatesNamed: ${commonName} carries no run prefix; only run-named certificates are adopted`);
    const rows = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: commonName }], 100);
    const uuids = rows.map((r) => String(r.uuid));
    for (const uuid of uuids) {
        if (!checkOwnership({ uuid }).own) recordCreated('certificates', { uuid, name: commonName }, { spec, note });
    }
    return uuids;
}

/** Every certificate of a run-prefixed common name and its platform-linked key, in the ledger (idempotent). */
export async function recordIssuedNamed(api: APIRequestContext, commonName: string, createdAfter: string | undefined, spec: string, note: string): Promise<string[]> {
    const uuids = await recordCertificatesNamed(api, commonName, spec, note);
    for (const uuid of uuids) await recordDerivedKeyOf(api, uuid, createdAfter, spec);
    return uuids;
}

/**
 * Runs `work` — an issuance step that can throw AFTER the server issued (a finalize that errors, a wait that times out) —
 * and records the run's certificates of `commonName` and their keys whether it returns or throws
 * (the teardown is ledger-only, so an issued certificate that was never recorded would be left on the tier). The work's own
 * error is the one the caller sees; a failure of the recording on that path is logged, never thrown over it.
 */
export async function recordingIssued<T>(
    api: APIRequestContext, commonName: string, createdAfter: string | undefined, spec: string, note: string, work: () => Promise<T>,
): Promise<{ result: T; uuids: string[] }> {
    let result: T;
    try {
        result = await work();
    } catch (e) {
        try {
            await recordIssuedNamed(api, commonName, createdAfter, spec, `${note} (recorded after the issuance step failed)`);
        } catch (r) {
            logger.warn(`recording the certificates of ${commonName} after a failed issuance step failed too: ${String(r).slice(0, 200)}`);
        }
        throw e;
    }
    return { result, uuids: await recordIssuedNamed(api, commonName, createdAfter, spec, note) };
}

/** Certificate states in which an issuance is still on its way (a successor can still appear or change). */
const ISSUANCE_IN_FLIGHT = new Set(['requested', 'pending_approval', 'pending_issue', 'pending_registration']);

/**
 * Records, then waits for the API state of `commonName` to settle, then records once more: an
 * issuance that was in flight when its source (a cert-manager Certificate) was deleted can still produce a certificate.
 * Settled = two reads in a row list the same certificates in the same states and none is still requested / pending
 * (`expect.poll` with growing intervals, no fixed sleep); a poll that does not settle in `timeoutMs` is logged and the
 * final recording still runs. Returns every uuid recorded.
 */
export async function recordIssuedSettled(
    api: APIRequestContext, commonName: string, createdAfter: string | undefined, spec: string, note: string, opts: { timeoutMs?: number } = {},
): Promise<string[]> {
    await recordIssuedNamed(api, commonName, createdAfter, spec, note);
    let last: string | undefined;
    try {
        await expect.poll(async () => {
            const rows = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: commonName }], 100);
            const signature = rows.map((r) => `${r.uuid}:${r.state}`).sort().join(',');
            const settled = signature === last && !rows.some((r) => ISSUANCE_IN_FLIGHT.has(String(r.state)));
            last = signature;
            return settled;
        }, { timeout: opts.timeoutMs ?? 15_000, intervals: [500, 1_000, 2_000] }).toBe(true);
    } catch (e) {
        logger.warn(`the certificates of ${commonName} did not settle in time (${String(e).split('\n')[0].slice(0, 120)}); recording what exists`);
    }
    return recordIssuedNamed(api, commonName, createdAfter, spec, note);
}

/**
 * Records an ACME account the run registered (REG-USE-05): found by its server-assigned account id (the last path
 * segment of the account URL), recorded under a run-prefixed name (`acmeAccounts` is id-named).
 */
export async function recordAcmeAccount(api: APIRequestContext, accountUrl: string, acmeProfile: OwnRef, spec: string): Promise<OwnRef> {
    const accountId = accountUrl.split('/').pop() ?? '';
    const accounts = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/acmeAccounts');
    const mine = accounts.find((a) => String(a.accountId) === accountId && a.acmeProfileUuid === acmeProfile.uuid);
    expect(mine, `ACME account ${accountId} of the run ACME profile is listed`).toBeTruthy();
    const name = runName(`acme-account-${String(mine!.accountId).replace(/[^A-Za-z0-9-]/g, '')}`);
    const accountUuid = String(mine!.uuid);
    if (checkOwnership({ uuid: accountUuid }).own) return { uuid: accountUuid, name, kind: 'own' };
    return recordCreated('acmeAccounts', { uuid: accountUuid, name }, { spec, note: 'ACME account, left valid', parents: { acmeProfile: acmeProfile.uuid } });
}
