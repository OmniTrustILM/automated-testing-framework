/**
 * certificateList — fixtures of the certificate list specs (REG-CERT-40 to REG-CERT-51).
 *
 * Adds `listSeed` to the regression `test`: the run's own list data (24 own certificates, 2 groups, 5 attribute
 * definitions, the owner user), the search catalogue and the labels the filter widget shows.
 *
 * Specs open the list with `CertificateListPage.openSeeded(signedIn, listSeed, options)`. The seed is made through the
 * test's guarded `api` with that test's ledger id, and read from the run state after the first build.
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
