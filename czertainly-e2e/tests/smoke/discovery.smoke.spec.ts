import { test, expect, loginAsSmokeUser, getAuthenticatedApiContext } from '../../fixtures/testFixtures';
import { Navigation } from '../../pages/Navigation';
import { TablePage } from '../../pages/TablePage';
import { DiscoveryPage } from '../../pages/DiscoveryPage';
import * as connectorUtils from '../../utils/connectorUtils';
import { waitForDiscoveryCompletion } from '../../utils/discoveryUtils';
import { Logger } from '../../utils/Logger';

const logger = new Logger('DiscoverySmokeTest');

const DISCOVERY_TIMEOUT_MS = 60_000; // Was 300_000 (5min); discoveries actually take ~10s

test.describe('@smoke discovery', () => {
  test.afterEach(async ({ page }) => {
    const tablePage = new TablePage(page);

    const cleanupEntity = async (url: string, name: string) => {
      try {
        await tablePage.visit(url);
        await tablePage.bulkDelete(name);
      } catch (e) {
        logger.warn(`Failed to cleanup ${name}:`, e);
      }
    }

    await cleanupEntity('/administrator/#/discoveries', 'Discoveries');
    await cleanupEntity('/administrator/#/certificates', 'Certificates');
    await cleanupEntity('/administrator/#/keys', 'Keys');
  });

  test('SMK-003: network discovery and certificate details', async ({ page, request, env }) => {
    test.setTimeout(360000);
    test.skip(
      !env.discoveryProviderName || !env.discoveryTarget,
      'DISCOVERY_PROVIDER_NAME and DISCOVERY_TARGET are required.'
    );

    // --- Step 0: Find existing Connector (Pre-condition) ---
    if (env.discoveryProviderUrl) {
      await test.step('Find & Approve existing connector', async () => {
        logger.info(`Looking for connector with URL: ${env.discoveryProviderUrl}`);

        const apiRequest = await getAuthenticatedApiContext(request, env);

        try {
          const connectors = await connectorUtils.getAllConnectors(apiRequest);
          const foundConnector = connectors.find(c => c.url === env.discoveryProviderUrl);

          if (!foundConnector) {
            logger.debug(`Available connectors: ${connectors.map(c => `${c.name} (${c.url})`).join(', ')}`);
            throw new Error(`Connector with URL ${env.discoveryProviderUrl} not found in the system.`);
          }

          logger.info(`Found connector: ${foundConnector.name} (UUID: ${foundConnector.uuid}, Status: ${foundConnector.status})`);

          if (foundConnector.status !== 'connected') {
            logger.info(`Connector status is ${foundConnector.status}, attempting approval...`);
            await connectorUtils.approveConnector(apiRequest, foundConnector.uuid);

            await connectorUtils.checkConnectorHealth(apiRequest, foundConnector.uuid);
          }

          env.discoveryProviderName = foundConnector.name;
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

      const providerRow = main.getByRole('row', { name: env.discoveryProviderName! }).first();

      const searchInput = main.locator('input[placeholder="Search"], input#search').first();
      if (await searchInput.isVisible()) {
        await searchInput.fill(env.discoveryProviderName!);
        await searchInput.press('Enter');
        await expect(async () => {
          await expect(providerRow).toBeVisible();
        }).toPass();
      }
      await expect(providerRow, `Provider "${env.discoveryProviderName}" should be visible in Connectors list`).toBeVisible();

      await expect(providerRow).toContainText(/connected/i);
    });

    await discoveryPage.goToPage();

    // --- Step 2: Create Discovery ---
    let discoveryUuid: string;
    await test.step('Create Network Discovery', async () => {
      const discoveryName = `smoke-discovery-${Date.now()}`;
      discoveryUuid = await discoveryPage.createDiscovery(
        discoveryName,
        env.discoveryProviderName!,
        'IP-Hostname',
        env.discoveryTarget!
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
      await discoveryPage.verifyDiscoveredCertificates();
    });

    // --- Step 5: Certificate Details Verification ---
    await test.step('Verify Certificate Details Page', async () => {
      await discoveryPage.openCertificateDetailsAndVerify();
    });
  });
});