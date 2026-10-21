/**
 * Runs the filter row tables (searchTables.ts) against a tier through the guarded `api`, over the run's own full
 * certificate seed with the Common Name prefix filter: the exact row-set checks of the certificate search specs.
 */
import type { GuardedApi } from '../guard/types';
import { Filter, readJsonOk, Probe, rowsOf, searchRaw, uuidSet, Json } from './searchApi';
import { RowContext } from './searchTables';
import { CertId, ensureCertificateSeed, hasSeedA, idsOfUuids, SeedAManifest, seedIsolation, uuidsOfIds } from './seedFull';
import { readCertificate } from './seedOwnedObjects';

/** The seed budget of a first call (24 key generations, ~60 requests): added to the test's timeout only when SEED-A still has to be built. */
export const SEED_BUILD_TIMEOUT_MS = 240_000;

/** SEED-A for a test: builds it on the first call (extending the test timeout), reuses it afterwards. */
export async function certificateSeedPlan(api: GuardedApi, testInfo: { setTimeout(ms: number): void; timeout: number }, spec: string): Promise<SeedAManifest> {
    if (!hasSeedA()) testInfo.setTimeout(testInfo.timeout + SEED_BUILD_TIMEOUT_MS);
    return ensureCertificateSeed(api, spec);
}

export interface SeedSearch {
    probe: Probe;
    /** The rows of a 200 answer (else []). */
    rows: Json[];
    /** The seed ids of the rows, SORTED (set comparisons); a row outside the manifest shows as `?xxxxxxxx`. */
    ids: CertId[];
    /** The seed ids in the order the server answered (order comparisons). */
    ordered: CertId[];
    uuids: string[];
    totalItems?: number;
}

/**
 * One search over SEED-A: the isolation filter first, then the row's filters; `itemsPerPage` 100 (all 24 seeds on one
 * page), `includeArchived` as given (default false: SEED-A has no archived certificate).
 */
export async function searchSeedCertificates(api: GuardedApi, m: SeedAManifest, filters: Filter[], extra: Json = {}): Promise<SeedSearch> {
    const probe = await searchRaw(api, { filters: [seedIsolation(m), ...filters], itemsPerPage: 100, pageNumber: 1, ...extra });
    const json = probe.status === 200 ? (probe.json as Json) : undefined;
    const rows = json ? rowsOf(json, 'certificates') : [];
    const uuids = rows.map((r) => String(r.uuid));
    return { probe, rows, ids: idsOfUuids(m, uuids), ordered: uuids.map((u) => m.certificates.find((c) => c.uuid === u)?.id ?? (`?${u.slice(0, 8)}` as CertId)), uuids, totalItems: json ? Number(json.totalItems) : undefined };
}

/** Values some rows need from the live platform: the signature algorithm / public key algorithm strings of the seeds (read back from their detail). */
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
