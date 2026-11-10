/**
 * issuedRecords — ledger before assertion for certificates and keys the PLATFORM made (the `certKey_<CN>` key, protocol-issued
 * certificates, ACME accounts).
 * A derived key's age is judged on the server's clock; without one the key is kept and the teardown warns.
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
 * Records the key the platform linked to a run certificate as a DERIVED object with a server-clock `createdAfter`; without server time it
 * is recorded with `keepingBound()` so the teardown keeps it.
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
        // Never a silent no-op: a bound it can never reach makes the teardown keep the key and warn.
        bound = keepingBound();
        logger.warn(`certificate ${certificateUuid}: no createdAfter for its key ${keyUuid}; recorded with a bound the teardown keeps (check by hand)`);
    }
    recordDerived('keys', { uuid: keyUuid, name: `key of certificate ${certificateUuid}` }, { spec, createdAfter: bound, note: 'key the platform linked to a run certificate', parents: { certificate: certificateUuid } });
}

/** `recordDerivedKeyOf` with the by-name fallback of `recordingIssued` when the detail read throws; a failure of that surfaces. */
export async function recordDerivedKeyOrNamed(api: APIRequestContext, certificateUuid: string, commonName: string, createdAfter: string | undefined, spec: string, note: string): Promise<void> {
    try {
        await recordDerivedKeyOf(api, certificateUuid, createdAfter, spec);
    } catch (e) {
        logger.warn(`recording the key of certificate ${certificateUuid} failed (${String(e).split('\n')[0].slice(0, 120)}); recording by name instead`);
        await recordIssuedNamed(api, commonName, createdAfter, spec, `${note} (recorded by name after a failed key read)`);
    }
}

/**
 * Records every inventory certificate whose common name is exactly
 * `commonName` (run-prefixed) and not yet in the ledger; returns the uuids.
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

export async function recordIssuedNamed(api: APIRequestContext, commonName: string, createdAfter: string | undefined, spec: string, note: string): Promise<string[]> {
    const uuids = await recordCertificatesNamed(api, commonName, spec, note);
    for (const uuid of uuids) await recordDerivedKeyOf(api, uuid, createdAfter, spec);
    return uuids;
}

/**
 * Runs `work` (an issuance step that can throw after the server issued) and records the run's certificates of `commonName` and their keys
 * whether it returns or throws; recording failures on the throw path are logged, not thrown.
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

const ISSUANCE_IN_FLIGHT = new Set(['requested', 'pending_approval', 'pending_issue', 'pending_registration']);

/**
 * Records, waits until two reads list the same certificates with none requested / pending (no fixed sleep; an unsettled poll is logged),
 * then records again: an in-flight issuance can still produce a certificate. Returns every uuid recorded.
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

/** Records an ACME account the run registered, found by the account id (last path segment of the account URL), under a run-prefixed name. */
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
