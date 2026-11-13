/**
 * seedRows — runs the filter row tables (searchTables.ts) against a tier: each row is sent through the guarded `api` over the run's
 * certificate seed with the Common Name prefix filter and compared with its expected ids.
 */
import type { GuardedApi } from '../guard/types';
import { Filter, readJsonOk, rowsOf, searchRaw, uuidSet } from './searchApi';
import { RowContext } from './searchTables';
import { CertId, ensureCertificateSeed, hasCertificateSeed, idsOfUuids, SeedAManifest, seedIsolation, uuidsOfIds } from './seedFull';
import { readCertificate } from './seedOwnedObjects';
import { ApiAnswer } from '../apiReads';
import { JsonObject } from '../json';

/** The seed budget of a first call (24 key generations, ~60 requests), added to the test timeout only when the seed is still to be built. */
const SEED_BUILD_TIMEOUT_MS = 240_000;

export async function certificateSeedPlan(api: GuardedApi, testInfo: { setTimeout(ms: number): void; timeout: number }, spec: string): Promise<SeedAManifest> {
    if (!hasCertificateSeed()) testInfo.setTimeout(testInfo.timeout + SEED_BUILD_TIMEOUT_MS);
    return ensureCertificateSeed(api, spec);
}

export interface SeedSearch {
    probe: ApiAnswer;
    rows: JsonObject[];
    /** The seed ids of the rows, SORTED; a row outside the manifest shows as `?xxxxxxxx`. */
    ids: CertId[];
    ordered: CertId[];
    uuids: string[];
    totalItems?: number;
}

/** One search over the certificate seed: the isolation filter first, then the row's filters; 100 per page, `includeArchived` default false. */
export async function searchSeedCertificates(api: GuardedApi, m: SeedAManifest, filters: Filter[], extra: JsonObject = {}): Promise<SeedSearch> {
    const probe = await searchRaw(api, { filters: [seedIsolation(m), ...filters], itemsPerPage: 100, pageNumber: 1, ...extra });
    const json = probe.status === 200 ? (probe.json as JsonObject) : undefined;
    const rows = json ? rowsOf(json, 'certificates') : [];
    const uuids = rows.map((r) => String(r.uuid));
    return { probe, rows, ids: idsOfUuids(m, uuids), ordered: uuids.map((u) => m.certificates.find((c) => c.uuid === u)?.id ?? (`?${u.slice(0, 8)}` as CertId)), uuids, totalItems: json ? Number(json.totalItems) : undefined };
}

/** Values some rows need from the live platform: the signature and public key algorithm strings of the seeds. */
export async function resolveRowContext(api: GuardedApi, m: SeedAManifest): Promise<RowContext> {
    const detail = async (id: CertId) => readCertificate(api, uuidsOfIds(m, [id])[0]);
    const [c09, c10, c01] = [await detail('C09'), await detail('C10'), await detail('C01')];
    return {
        signatureSha384: String(c09.signatureAlgorithm),
        signatureSha512: String(c10.signatureAlgorithm),
        rsa: String(c01.publicKeyAlgorithm),
    };
}

export { uuidSet, readJsonOk };
