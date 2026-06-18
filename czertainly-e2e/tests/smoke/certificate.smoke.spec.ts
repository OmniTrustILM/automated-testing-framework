import {
    test, expect,
    loginAsSmokeUser, getAuthenticatedApiContext,
} from '../../fixtures/testFixtures';
import { CertificatePage } from '../../pages/CertificatePage';
import {
    generateCsr, waitForCertificateState,
    revokeCertificate, deleteCertificate,
} from '../../utils/certificateUtils';
import { readSmokeState } from '../../utils/smokeState';
import { CERTIFICATE_DETAILS_TABS } from '../../utils/constants';
import { Logger } from '../../utils/Logger';

const logger = new Logger('CertificateSmokeTest');

// Tabs we assert deeply (specific row checks); the rest get a shallow open-check.
// SHALLOW_TABS is derived from CERTIFICATE_DETAILS_TABS to avoid drift between
// constants.ts and this test (single source of truth).
const DEEP_TABS = ['Details', 'Request', 'History'];
const SHALLOW_TABS = CERTIFICATE_DETAILS_TABS.filter(t => !DEEP_TABS.includes(t));

test.describe('@smoke certificate', () => {
    // Scoped here so afterEach can see it across this describe
    let issuedCertUuid: string | undefined;

    test.afterEach(async ({ request, env }) => {
        if (!issuedCertUuid) return;
        const state = readSmokeState();
        if (!state) return;

        const certUuid = issuedCertUuid;
        issuedCertUuid = undefined;

        try {
            const api = await getAuthenticatedApiContext(request, env);
            try {
                await revokeCertificate(api, {
                    authorityUuid: state.authorityUuid,
                    raProfileUuid: state.raProfileUuid,
                    certUuid,
                });
                await deleteCertificate(api, certUuid);
            } finally {
                await api.dispose();
            }
        } catch (e) {
            logger.warn(`Cleanup failed for cert ${certUuid}: ${e}`);
        }
    });

    test('SMK-004: issue certificate and verify detail tabs', async ({ page, request, env }) => {
        test.setTimeout(60_000); // 1 minute — realistic path is ~40s; tighter than this risks flakes

        const state = readSmokeState();
        test.skip(!state, 'SMK-004 fixtures not provisioned (env vars missing) — globalSetup skipped');

        const certPage = new CertificatePage(page);
        const cn = `qa-smoke-test-${Date.now()}.example.com`;
        const { csr } = generateCsr(cn);

        await loginAsSmokeUser(page, env);

        await test.step('Open Certificates list', async () => {
            await certPage.goToList();
        });

        await test.step('Issue certificate via UI', async () => {
            await certPage.openIssueModal();
            await certPage.selectRaProfile(state!.raProfileName);
            await certPage.selectKeySourceExternal();
            await certPage.pasteCsr(csr);
            issuedCertUuid = await certPage.submitIssue();
            logger.info(`Issued certificate UUID: ${issuedCertUuid}`);
        });

        await test.step('Wait for certificate to reach Issued state', async () => {
            const api = await getAuthenticatedApiContext(request, env);
            try {
                await waitForCertificateState(api, issuedCertUuid!, 'issued', 30_000);
            } finally {
                await api.dispose();
            }
        });

        await test.step('Verify Details tab', async () => {
            await certPage.assertDetailsTab({
                commonName: cn,
                raProfileName: state!.raProfileName,
                ownerName: env.username,
            });
        });

        await test.step('Verify Request tab', async () => {
            await certPage.assertRequestTab({ commonName: cn });
        });

        await test.step('Verify History tab has issuance entry', async () => {
            await certPage.assertHistoryTabHasEntry(/issued|created/i);
        });

        await test.step('Verify other tabs open without errors', async () => {
            await certPage.verifyOtherTabsOpenWithoutError(SHALLOW_TABS);
        });
    });
});
