import { attemptCleanup, recordCleanupFailure } from '../../utils/cleanupLedger';
import { test, expect, loginAsSmokeUser, getAuthenticatedApiContext } from '../../fixtures/testFixtures';
import { Navigation } from '../../pages/Navigation';
import { TablePage } from '../../pages/TablePage';
import { DiscoveryPage } from '../../pages/DiscoveryPage';
import * as connectorUtils from '../../utils/connectorUtils';
import { waitForDiscoveryCompletion, listNewlyDiscoveredInventoryUuids, deleteDiscovery } from '../../utils/discoveryUtils';
import { deleteCertificate } from '../../utils/certificateUtils';
import { getCertificateKeyUuid, deleteKeyIfOrphaned } from '../../utils/keyUtils';
import { readSmokeState } from '../../utils/smokeState';
import { Logger } from '../../utils/Logger';

const logger = new Logger('DiscoverySmokeTest');

const DISCOVERY_TIMEOUT_MS = 60_000; // Was 300_000 (5min); discoveries actually take ~10s

test.describe('@smoke discovery', () => {
  // What this run created, for afterEach. Cleanup goes by these UUIDs only: a "select all" on the
  // list pages also deleted what the test on the other worker had just created.
  let discoveryUuid: string | undefined;
  let discoveryName: string | undefined;
  // Keys the platform adds alongside our certificates are recognised partly by creation time.
  // A minute of slack covers clock difference between the runner and the platform.
  let startedAt = new Date();

  test.beforeEach(() => {
    discoveryUuid = undefined;
    discoveryName = undefined;
    startedAt = new Date(Date.now() - 60_000);
  });

  test.afterEach(async ({ request, env }) => {
    if (!discoveryUuid) {
      // The discovery was submitted but its UUID never came back from the page, so there is
      // nothing to delete by UUID. Say so instead of guessing by name.
      if (discoveryName) {
        recordCleanupFailure({ resource: 'discovery', name: discoveryName, message: 'discovery UUID unknown; remove it by hand' });
      }
      return;
    }
    const uuid = discoveryUuid;

    const api = await getAuthenticatedApiContext(request, env);
    try {
      // The certificate list first: deleting the discovery drops it, but not the certificates.
      let certUuids: string[] = [];
      const listed = await attemptCleanup({ resource: 'certificate', name: `added by discovery ${uuid}` },
        async () => { certUuids = await listNewlyDiscoveredInventoryUuids(api, uuid); });

      for (const certUuid of certUuids) {
        const keyUuid = await getCertificateKeyUuid(api, certUuid).catch(() => undefined);
        const deleted = await attemptCleanup({ resource: 'certificate', uuid: certUuid },
          () => deleteCertificate(api, certUuid));
        if (deleted && keyUuid) {
          await attemptCleanup({ resource: 'key', uuid: keyUuid },
            () => deleteKeyIfOrphaned(api, keyUuid, startedAt));
        }
      }

      // Without the list we cannot tell our certificates apart later, so keep the discovery.
      if (listed) {
        await attemptCleanup({ resource: 'discovery', uuid, name: discoveryName },
          () => deleteDiscovery(api, uuid));
      }
    } finally {
      await api.dispose();
    }
  });

  test('SMK-003: network discovery and certificate details', async ({ page, request, env }) => {
    test.setTimeout(360000);
    test.skip(!readSmokeState(), 'Smoke fixtures not provisioned (env vars missing) — globalSetup skipped');

    // --- Step 0: Find existing Connector (Pre-condition) ---
    if (env.smoke.discoveryProviderUrl) {
      await test.step('Find & Approve existing connector', async () => {
        logger.info(`Looking for connector with URL: ${env.smoke.discoveryProviderUrl}`);

        const apiRequest = await getAuthenticatedApiContext(request, env);

        try {
          const connectors = await connectorUtils.getAllConnectors(apiRequest);
          const foundConnector = connectors.find(c => c.url === env.smoke.discoveryProviderUrl);

          if (!foundConnector) {
            logger.debug(`Available connectors: ${connectors.map(c => `${c.name} (${c.url})`).join(', ')}`);
            throw new Error(`Connector with URL ${env.smoke.discoveryProviderUrl} not found in the system.`);
          }

          logger.info(`Found connector: ${foundConnector.name} (UUID: ${foundConnector.uuid}, Status: ${foundConnector.status})`);

          if (foundConnector.status !== 'connected') {
            logger.info(`Connector status is ${foundConnector.status}, attempting approval...`);
            await connectorUtils.approveConnector(apiRequest, foundConnector.uuid);

            await connectorUtils.checkConnectorHealth(apiRequest, foundConnector.uuid);
          }

          env.smoke.discoveryProviderName = foundConnector.name;
          logger.info(`Using connector: ${foundConnector.name}`);

        } catch (error) {
          logger.error('Failed to prepare connector:', error);
          throw error;
        } finally {
          await apiRequest.dispose();
        }
      });
    }

    await loginAsSmokeUser(page, env);
    const nav = new Navigation(page);
    const discoveryPage = new DiscoveryPage(page);

    // --- Step 1: Check Connector Status (UI) ---
    await test.step('Check Connector Status', async () => {
      await nav.openViaSidebar('Connectors', /connectors/i);
      const main = page.locator('main');
      await expect(main).toBeVisible();

      // Surface the discovery connector via the page's filter — the table may
      // hold many connectors and paginate.
      const tablePage = new TablePage(page);
      await tablePage.applyFilter({
        group: 'Property',
        field: 'Name',
        condition: 'contains',
        value: env.smoke.discoveryProviderName!,
      });

      const providerRow = main.getByRole('row', { name: env.smoke.discoveryProviderName! }).first();
      await expect(providerRow, `Provider "${env.smoke.discoveryProviderName}" should be visible in Connectors list`).toBeVisible();
      await expect(providerRow).toContainText(/connected/i);
    });

    await discoveryPage.goToPage();

    // --- Step 2: Create Discovery ---
    await test.step('Create Network Discovery', async () => {
      discoveryName = `smoke-discovery-${Date.now()}`;
      discoveryUuid = await discoveryPage.createDiscovery(
        discoveryName,
        env.smoke.discoveryProviderName!,
        'IP-Hostname',
        env.smoke.discoveryTarget!
      );
    });

    // --- Step 3: Poll for Completion via API, then reload UI ---
    await test.step('Wait for Discovery Completion', async () => {
      const api = await getAuthenticatedApiContext(request, env);
      try {
        await waitForDiscoveryCompletion(api, discoveryUuid!, DISCOVERY_TIMEOUT_MS);
      } finally {
        await api.dispose();
      }
      await page.reload(); // UI was rendered when status was in-progress — refresh
    });

    // --- Step 3b: Verify UI reflects completed status (catches FE rendering regressions) ---
    await test.step('Verify Completed Status badges in UI', async () => {
      await discoveryPage.assertCompletedStatusBadges();
    });

    // --- Step 4: valid Discovered Certificates ---
    await test.step('Verify Discovered Certificate Table', async () => {
      await discoveryPage.openResultsTab();
      await discoveryPage.verifyDiscoveredCertificates();
    });

    // --- Step 5: Certificate Details Verification ---
    await test.step('Verify Certificate Details Page', async () => {
      await discoveryPage.openCertificateDetailsAndVerify();
    });
  });
});