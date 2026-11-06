/**
 * certificateList — fixtures of the certificate list specs: `listSeed`, the run's own list data and search catalogue.
 */
import { PlatformLabels } from '../../utils/regression/inventory/fieldLabels';
import { CatalogueGroup, readCatalogue } from '../../utils/regression/inventory/searchApi';
import { SeedAManifest, ensureCertificateSeed } from '../../utils/regression/inventory/seedFull';
import { test as regressionTest } from '../regressionFixtures';

export { expect } from '../regressionFixtures';

export interface ListSeed {
    manifest: SeedAManifest;
    catalogue: CatalogueGroup[];
    labels: PlatformLabels;
}

export interface CertificateListFixtures {
    /** Built on the first call of the run, read afterwards. */
    listSeed: ListSeed;
}

export const test = regressionTest.extend<CertificateListFixtures>({
    listSeed: async ({ api, own }, use) => {
        const manifest = await ensureCertificateSeed(api, own.spec);
        await use({ manifest, catalogue: await readCatalogue(api), labels: await PlatformLabels.read(api) });
    },
});
