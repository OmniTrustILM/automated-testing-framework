/**
 * certificateList — the fixtures of the certificate list specs (REG-CERT-40 to REG-CERT-51).
 *
 * WHAT: `test` is the regression `test` plus `listSeed`: the run's own list data. It holds the seed manifest (24 own
 *       certificates, 2 groups, 5 attribute definitions, the owner user), the search catalogue and the platform labels the
 *       filter widget shows. The specs open the list with `CertificateListPage.openSeeded(signedIn, listSeed, options)`.
 * WHY: 22 tests repeated the same lines before they could look at the page: build or find the seed, read the catalogue and
 *      the labels. The seed is in the run state after its first build, so every later test costs two reads.
 * HOW: the seed is made through the test's guarded `api` and carries the ledger id of the test that builds it (`own.spec`).
 *      The fixture is per test: a worker-scoped seed would need a context of its own, which the spec lint refuses. The page
 *      is not part of the fixture, because an area fixture may not take a page.
 */
import { PlatformLabels } from '../../utils/regression/inventory/fieldLabels';
import { CatalogueGroup, readCatalogue } from '../../utils/regression/inventory/searchApi';
import { SeedAManifest, ensureCertificateSeed } from '../../utils/regression/inventory/seedFull';
import { test as regressionTest } from '../regressionFixtures';

export { expect } from '../regressionFixtures';

/** What the list specs read of the run's own data. */
export interface ListSeed {
    manifest: SeedAManifest;
    catalogue: CatalogueGroup[];
    labels: PlatformLabels;
}

export interface CertificateListFixtures {
    /** The run's seed, catalogue and labels (built on the first call of the run, read afterwards). */
    listSeed: ListSeed;
}

export const test = regressionTest.extend<CertificateListFixtures>({
    listSeed: async ({ api, own }, use) => {
        const manifest = await ensureCertificateSeed(api, own.spec);
        await use({ manifest, catalogue: await readCatalogue(api), labels: await PlatformLabels.read(api) });
    },
});
