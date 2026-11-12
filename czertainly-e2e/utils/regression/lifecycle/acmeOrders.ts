/**
 * acmeOrders — one ACME order of an own certificate through the RA-profile directory: the run's ACME profile on an own
 * RA profile with one new account, new-order → finalize → settled (every certificate the order makes and its linked
 * key are recorded, also when the finalize or the wait throws), and the CA-policy wording of an EC refusal.
 */
import { expect } from '@playwright/test';
import { AcmeClient, AcmeResponse } from '../protocols/acmeClient';
import { apiJson, searchCertificates, serverCreatedAfter } from '../apiReads';
import { authorityConnectorName } from '../config/authorities';
import type { GuardedApi } from '../guard/types';
import { recordAcmeAccount, recordingIssued } from '../issuedRecords';
import { sanOracleFor } from '../ownCertificates';
import { ensureAcmeOnRaProfile } from '../ownRaProfiles';
import { ecRefusalWording, GeneratedCsr } from '../pkiBuilders';
import { createdAfterMarker, OwnRef } from '../ledger/ledger';
import { runName } from '../ledger/runState';

/** A settled order as the ACME client reads it. */
export type AcmeOrder = Awaited<ReturnType<AcmeClient['waitForOrder']>>;

export interface AcmeRun {
    client: AcmeClient;
    acmeProfile: OwnRef & { identifier: string };
    /** The run ACME profile as the API reads it (`retryInterval`, `validity` in seconds). */
    profile: { retryInterval?: number; validity?: number };
    /** The new-account answer of the shared account (its Retry-After is part of the order-detail oracle). */
    account: AcmeResponse;
    /** The SAN oracle of the CA behind the run RA profile (exact on EJBCA-NG, DNS values elsewhere). */
    sanMode: 'exact' | 'dns';
    connector: string;
}
/**
 * The ACME profile on an own RA profile, its settings, and ONE new account (recorded under a run-prefixed name). Without
 * a CA the RA-profile helper throws `RaProfileSourceMissing` (the caller turns it into a skip with `orSkipWithoutCa`).
 */
export async function startAcmeRun(api: GuardedApi, spec: string): Promise<AcmeRun> {
    const { raProfile, acmeProfile, directoryUrl } = await ensureAcmeOnRaProfile(api, spec);
    const profile = await apiJson<{ retryInterval?: number; validity?: number }>(api, 'GET', `/api/v1/acmeProfiles/${acmeProfile.uuid}`);
    const connector = await authorityConnectorName(api, raProfile.authorityUuid);
    const client = new AcmeClient(directoryUrl);
    await client.init();
    const account = await client.newAccount(`${runName('acme-b1')}@example.test`);
    expect(account.location, 'new-account answers the account URL').toBeTruthy();
    await recordAcmeAccount(api, account.location!, acmeProfile, spec);
    return { client, acmeProfile, profile, account, sanMode: sanOracleFor(connector), connector };
}

/** The inventory certificates of a common name (read-only). */
async function certificatesNamed(api: GuardedApi, commonName: string): Promise<string[]> {
    const rows = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: commonName }], 100);
    return rows.map((r) => String(r.uuid));
}

/**
 * Order → finalize → settle. Ledger first: every certificate of the identifier and its linked key (derived,
 * `createdAfter` from the new-order response's Date). `mine` are the certificates THIS order made (not in the inventory
 * before the order).
 */
export async function orderAndFinalize(api: GuardedApi, run: AcmeRun, csr: GeneratedCsr, spec: string) {
    const identifier = run.acmeProfile.identifier;
    const before = new Set(await certificatesNamed(api, identifier));
    const order = await run.client.newOrder([identifier]);
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const createdAfter = order.date ? createdAfterMarker(order.date) : await serverCreatedAfter(api);
    // The finalize and the wait run inside the recording: a finalize that throws after the server issued, or a
    // wait that times out, still leaves the certificate and its key in the ledger before the error surfaces.
    const { result: { fin, done }, uuids } = await recordingIssued(api, identifier, createdAfter, spec, 'issued via ACME (REG-USE-05.1 / 05.2)', async () => {
        const f = await run.client.finalize(order.body.finalize, csr.derBase64Url);
        const d = f.status < 300 ? await run.client.waitForOrder(order.location!) : undefined;
        return { fin: f, done: d };
    });
    return { order, fin, done, uuids, mine: uuids.filter((u) => !before.has(u)) };
}

/**
 * Why THIS order's issuance was refused, in CA-policy words about the key: the finalize problem's detail,
 * the order's own `error` and the history of the certificates this order made — never the history of the name.
 */
export async function ecRefusal(api: GuardedApi, fin: AcmeResponse, done: AcmeOrder | undefined, mine: string[]): Promise<string | undefined> {
    const parts: string[] = [];
    if (fin.status >= 300) parts.push(String(fin.body?.detail ?? ''));
    if (done?.error) parts.push(String(done.error.detail ?? ''));
    for (const u of mine) {
        const h = await apiJson<Array<{ message?: string }>>(api, 'GET', `/api/v1/certificates/${u}/history`);
        parts.push(...h.map((x) => String(x.message ?? '')));
    }
    return parts.find((t) => ecRefusalWording(t));
}
