/**
 * REG-KEY-01, REG-KEY-03 — tokens and token profiles in the admin UI on a v2 software cryptography connector (ilm#431, core#2069).
 */
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { KeyPage } from '../../../pages/KeyPage';
import { TokenPage } from '../../../pages/TokenPage';
import { TokenProfilePage } from '../../../pages/TokenProfilePage';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import { PROFILE_USAGES } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { activationCode, createOwnTokenProfile, findCryptoConnector, getOwnToken, getTokenProfile, tokenAlias, tokenStatusOf, V2_TOKEN_STATUSES } from '../../../utils/regression/platform/tokens';
import { ownName } from '../../../utils/regression/ledger/runState';
import { requireKeyChain } from '../../../utils/regression/platform/keyChain';
import { lookupInList, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';
import { UI_FLOW_MS } from '../../../utils/regression/timeouts';

/** Tokens → Create → a v2 software token through the form; recorded from the create answer before the dialog closes. */
async function createTokenInUi(page: Page, api: GuardedApi, own: OwnObjects, testInfo: TestInfo, prefix: string) {
    const connector = await findCryptoConnector(api, 2);
    if (!connector) throw new Error('the crypto-v2 need was met, yet no v2 cryptography connector was found');
    const tokens = new TokenPage(page);
    const name = ownName(prefix);
    const note = `own token through the UI on ${connector.name}`;
    const answer = await test.step('Tokens → Create → provider → attributes → submit', async () => {
        await tokens.goToList();
        await tokens.openCreateDialog();
        const filled = await tokens.fillSoftwareToken({ name, connectorName: connector.name, alias: tokenAlias(name), activationCode: activationCode() });
        testInfo.annotations.push({ type: 'form-fields', description: filled.join(', ') });
        return await submitRecordingByNameOnFailure({ type: 'tokens', name, spec: own.spec, note, lookup: lookupInList(api, '/api/v1/tokens') }, () => tokens.submitCreateForm());
    });
    const token = own.record('tokens', answer, { name, note });
    await tokens.waitForCreateDialogClosed();
    return { tokens, token, name };
}

test.describe('Tokens and token profiles in the admin UI', { tag: tags.regression }, () => {
    test('a v2 software token created in the UI shows a v2 status and v1-only actions disabled',
        testMeta({
            id: 'REG-KEY-01', prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2',
            rule: [
                'activate / deactivate act only through the v1 TokenActivationCapability; a v2 token never reaches Activated; v2 status vocabulary; the token detail page (buttons need Activated / Deactivated); core#2344',
            ],
        }),
        async ({ signedIn: page, api, own }, testInfo) => {
            test.setTimeout(UI_FLOW_MS);
            const { tokens, token, name } = await createTokenInUi(page, api, own, testInfo, 'uitok');
            const uuid = token.uuid;

            await test.step('Detail: a v2 status badge; Sync, Activate, Deactivate disabled; Edit, Delete, Reload enabled', async () => {
                await tokens.goToDetail(uuid);
                const badge = await tokens.assertStatusBadge(V2_TOKEN_STATUSES);
                testInfo.annotations.push({ type: 'token-status', description: badge });
                await tokens.assertButtons({ sync: 'disabled', activate: 'disabled', deactivate: 'disabled', edit: 'enabled', delete: 'enabled', reload: 'enabled' });
                const detail = await getOwnToken(api, token);
                expect(V2_TOKEN_STATUSES, 'API status word').toContain(tokenStatusOf(detail));
                expect(detail.kind ?? null, 'no kind on a v2 token').toBeNull();
            });

            await test.step('The token is in the list', async () => {
                await tokens.goToList();
                await tokens.assertListed(name);
            });
        });

    test('the Generate Random button is enabled on a usable v2 token',
        testMeta({
            id: 'REG-KEY-01', row: 'random', prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2', bug: 'fe-administrator#2349',
            rule: ['core#2069 AC: the administrator can generate random data with a V2-backed token using the existing token-detail flow; fe-administrator#2349 (Generate Random is available on a usable v2 token)'],
        }),
        async ({ signedIn: page, api, own }, testInfo) => {
            test.setTimeout(UI_FLOW_MS);
            const { tokens, token } = await createTokenInUi(page, api, own, testInfo, 'uirnd');
            const uuid = token.uuid;

            await test.step('Detail: the token is usable (a v2 status badge, API agrees)', async () => {
                await tokens.goToDetail(uuid);
                await tokens.assertStatusBadge(V2_TOKEN_STATUSES);
                expect(V2_TOKEN_STATUSES, 'API status word').toContain(tokenStatusOf(await getOwnToken(api, token)));
            });

            await test.step('Generate Random is enabled on the v2 token', async () => {
                test.fail(true, 'fe-administrator#2349: Generate Random is always disabled on a v2 token (it is enabled only for status Activated)');
                await tokens.assertButtons({ random: 'enabled' });
            });
        });

    test('a new token profile stays disabled until enabled, and Create Key offers enabled ones only',
        testMeta({
            id: 'REG-KEY-03', prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2',
            rule: [
                'enabled defaults to false in the API; usages as submitted; a disabled profile blocks key creation (the Create Key form lists enabled profiles only)',
                'fe-administrator token-profiles form: Create starts with the Enabled switch on (defaultValues enabled: true), so the run switches it off',
            ],
        }),
        async ({ signedIn: page, api, own, live }) => {
            test.setTimeout(UI_FLOW_MS);
            const { token } = await requireKeyChain(api, own.spec);
            // The browser creates the profile under the run's token: prove the token is a live object of this run first.
            await live('tokens', token);
            const disabled = await createOwnTokenProfile(api, own.spec, 'tp03-off', { token, usages: PROFILE_USAGES, enabled: false });
            const profiles = new TokenProfilePage(page);
            const name = ownName('uitp');

            const profileAnswer = await test.step('Create Token Profile: name, token, usages; the enable switch off', async () => {
                await profiles.goToList();
                await profiles.openCreateDialog();
                await expect(profiles.enabledSwitch, 'the form starts with Enabled on').toBeChecked();
                await profiles.fillProfile({ name, tokenName: token.name, usages: ['sign', 'verify'], enabled: false });
                await expect(profiles.enabledSwitch).not.toBeChecked();
                return await submitRecordingByNameOnFailure({ type: 'tokenProfiles', name, spec: own.spec, note: 'own token profile through the UI', parents: { token: token.uuid }, lookup: lookupInList(api, '/api/v1/tokenProfiles') }, () => profiles.submitCreateForm());
            });
            const profile = own.record('tokenProfiles', profileAnswer, { name, note: 'own token profile through the UI', parents: { token: token.uuid } });
            await profiles.waitForCreateDialogClosed();
            const profileUuid = profile.uuid;

            await test.step('Detail shows Disabled; Enable from the toolbar → Enabled (API agrees)', async () => {
                await profiles.goToDetail(token.uuid, profileUuid);
                await profiles.assertProfileEnabled(false);
                await expect(profiles.enableButton).toBeEnabled();
                await expect(profiles.disableButton).toBeDisabled();
                const enabled = await profiles.enableProfile();
                expect(enabled.status, 'the enable request succeeds').toBeLessThan(300);
                await profiles.assertProfileEnabled(true);
                await expect(profiles.disableButton).toBeEnabled();
                expect((await getTokenProfile(api, token, profile)).enabled).toBe(true);
            });

            await test.step('Create Key form: the enabled profile is offered, the disabled one is not', async () => {
                const keys = new KeyPage(page);
                await keys.goToList();
                await keys.openCreateModal();
                const options = await keys.offeredTokenProfiles();
                expect(options, 'the enabled profile is offered').toContain(name);
                expect(options, 'the disabled profile is not offered').not.toContain(disabled.name);
            });
        });
});
