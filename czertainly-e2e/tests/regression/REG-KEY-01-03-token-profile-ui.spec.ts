/**
 * REG-KEY-01 / REG-KEY-03 — tokens and token profiles through the admin UI (ilm#431, T7; platform area).
 *
 * REG-KEY-01: Tokens → Create → the software provider (interface v2) → the connector's attribute form → submit; the
 * detail badge is a v2 status word; on a v2 token Sync, Activate and Deactivate are disabled
 * (`tokens/detail/index.tsx:145-170`: they need Activated / Deactivated, which a v2 token never is; core#2344, K6); Generate Random
 * is its own test, REG-KEY-01[random] (known bug fe-administrator#2349); the
 * token is in the list. REG-KEY-03: Create Token Profile (name, token, usages, enable switch); a profile created with
 * the switch off shows Disabled until enabled through the toolbar; the Create Key form offers the enabled profile and
 * not a disabled one (`cryptographic-keys/form/index.tsx:188`).
 *
 * Own objects only: the token created through the UI is recorded in the ledger right after the create (its uuid from
 * the list link) and before any assertion; the second (disabled) profile comes from the API. Browser traffic does not
 * pass the guard (it is the user's own form); the API reads after it are GETs.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { KeyPage } from '../../pages/KeyPage';
import { TokenPage } from '../../pages/TokenPage';
import { PROFILE_USAGES } from '../../utils/regression/cryptoMatrix';
import { activationCode, createOwnToken, createOwnTokenProfile, findCryptoConnector, getOwnToken, getTokenProfile, tokenAlias, tokenStatusOf, V2_TOKEN_STATUSES } from '../../utils/regression/keyApi';
import { readState, recordCreated, regName, updateState } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-KEY-01-03';

test.describe('REG-KEY tokens and token profiles (UI)', { tag: tags.regression }, () => {
    test('REG-KEY-01: a software token (v2) created through the UI shows a v2 status badge, has Sync / Activate / Deactivate disabled, and is listed',
        meta({
            id: 'REG-KEY-01', prio: 'P1', issue: 'ilm#431',
            rule: [
                'platform-keys-connectors A2 r3 (activate / deactivate act only through the v1 TokenActivationCapability; a v2 token never reaches Activated), r4 (v2 status vocabulary); FE tokens/detail/index.tsx:145-170 (buttons need Activated / Deactivated); K6, core#2344',
            ],
        }),
        async ({ page, api, env }, testInfo) => {
            test.setTimeout(180_000);
            const connector = await findCryptoConnector(api, 2);
            test.skip(!connector, 'no connected software cryptography connector of interface v2 is registered on this tier (REG_CRYPTO_CONNECTOR_V2)');
            await loginAsSmokeUser(page, env);
            const tokens = new TokenPage(page);
            const name = regName(`uitok-${Date.now().toString(36)}`);

            const uuid = await test.step('Tokens → Create → provider → attributes → submit', async () => {
                await tokens.goToList();
                await tokens.openCreate();
                const filled = await tokens.fillSoftwareToken({ name, connectorName: connector!.name, alias: tokenAlias(name), activationCode: activationCode() });
                testInfo.annotations.push({ type: 'form-fields', description: filled.join(', ') });
                return tokens.submitCreate(name);
            });
            const token = recordCreated('tokens', { uuid, name }, SPEC, `own token through the UI on ${connector!.name}`);
            if (!readState().token) updateState({ token });

            await test.step('Detail: a v2 status badge; Sync, Activate, Deactivate disabled; Edit, Delete, Reload enabled', async () => {
                await tokens.openDetail(uuid);
                const badge = await tokens.assertStatusBadge(V2_TOKEN_STATUSES);
                testInfo.annotations.push({ type: 'token-status', description: badge });
                await tokens.assertButtons({ sync: 'disabled', activate: 'disabled', deactivate: 'disabled', edit: 'enabled', delete: 'enabled', reload: 'enabled' });
                const detail = await getOwnToken(api, token);
                expect(V2_TOKEN_STATUSES, 'API status word').toContain(tokenStatusOf(detail));
                expect(detail.kind ?? null, 'no kind on a v2 token').toBeNull();
            });

            await test.step('The token is in the list', async () => {
                await tokens.assertListed(name);
            });
        });

    test('REG-KEY-01[random]: Generate Random is enabled on an active v2 token (known bug: it is always disabled for v2)',
        meta({
            id: 'REG-KEY-01', prio: 'P1', issue: 'ilm#431', bug: 'fe-administrator#2349',
            rule: ['core#2069 AC: the administrator can generate random data with a V2-backed token using the existing token-detail flow; fe-administrator#2349 (Generate Random is available on a usable v2 token)'],
        }),
        async ({ page, api, env }, testInfo) => {
            test.setTimeout(180_000);
            const connector = await findCryptoConnector(api, 2);
            test.skip(!connector, 'no connected software cryptography connector of interface v2 is registered on this tier (REG_CRYPTO_CONNECTOR_V2)');
            await loginAsSmokeUser(page, env);
            const tokens = new TokenPage(page);
            const name = regName(`uirnd-${Date.now().toString(36)}`);

            const uuid = await test.step('Tokens → Create → provider → attributes → submit', async () => {
                await tokens.goToList();
                await tokens.openCreate();
                const filled = await tokens.fillSoftwareToken({ name, connectorName: connector!.name, alias: tokenAlias(name), activationCode: activationCode() });
                testInfo.annotations.push({ type: 'form-fields', description: filled.join(', ') });
                return tokens.submitCreate(name);
            });
            const token = recordCreated('tokens', { uuid, name }, SPEC, `own token through the UI on ${connector!.name}`);
            if (!readState().token) updateState({ token });

            await test.step('Detail: the token is usable (a v2 status badge, API agrees)', async () => {
                await tokens.openDetail(uuid);
                await tokens.assertStatusBadge(V2_TOKEN_STATUSES);
                expect(V2_TOKEN_STATUSES, 'API status word').toContain(tokenStatusOf(await getOwnToken(api, token)));
            });

            await test.step('Generate Random is enabled on the v2 token', async () => {
                test.fail(true, 'fe-administrator#2349: Generate Random is always disabled on a v2 token (it is enabled only for status Activated)');
                await tokens.assertButtons({ random: 'enabled' });
            });
        });

    test('REG-KEY-03: a token profile created with the enable switch off shows Disabled until enabled from its toolbar; the Create Key form offers the enabled profile and not a disabled one',
        meta({
            id: 'REG-KEY-03', prio: 'P1', issue: 'ilm#431',
            rule: ['platform-keys-connectors A2 r7 (enabled defaults to false; usages as submitted), r8 (a disabled profile blocks key creation; the key form lists enabled profiles only: cryptographic-keys/form/index.tsx:188)'],
        }),
        async ({ page, api, env }) => {
            test.setTimeout(180_000);
            const connector = await findCryptoConnector(api, 2);
            test.skip(!connector, 'no connected software cryptography connector of interface v2 is registered on this tier (REG_CRYPTO_CONNECTOR_V2)');
            const token = readState().token ?? (await createOwnToken(api, connector!, `tok03-${Date.now().toString(36)}`, SPEC));
            if (!readState().token) updateState({ token });
            const disabled = await createOwnTokenProfile(api, token, `tp03-off-${Date.now().toString(36)}`, SPEC, { usages: PROFILE_USAGES, enabled: false });
            await loginAsSmokeUser(page, env);
            const tokens = new TokenPage(page);
            const name = regName(`uitp-${Date.now().toString(36)}`);

            const profileUuid = await test.step('Create Token Profile: name, token, usages; the enable switch stays off', async () => {
                await tokens.goToProfileList();
                await tokens.openCreateProfile();
                await tokens.fillProfile({ name, tokenName: token.name, usages: ['sign', 'verify'] });
                await expect(tokens.enableSwitch()).not.toBeChecked();
                return tokens.submitCreateProfile(name);
            });
            const profile = recordCreated('tokenProfiles', { uuid: profileUuid, name }, SPEC, 'own token profile through the UI', { token: token.uuid });

            await test.step('Detail shows Disabled; Enable from the toolbar → Enabled (API agrees)', async () => {
                await tokens.openProfileDetail(token.uuid, profileUuid);
                await tokens.assertProfileEnabled(false);
                await expect(tokens.profileButton('enable')).toBeEnabled();
                await expect(tokens.profileButton('disable')).toBeDisabled();
                await tokens.enableProfile();
                await expect(tokens.profileButton('disable')).toBeEnabled();
                expect((await getTokenProfile(api, token, profile)).enabled).toBe(true);
            });

            await test.step('Create Key form: the enabled profile is offered, the disabled one is not', async () => {
                const keys = new KeyPage(page);
                await keys.goToList();
                await keys.openCreateModal();
                const options = await keys.tokenProfileOptions();
                expect(options, 'the enabled profile is offered').toContain(name);
                expect(options, 'the disabled profile is not offered').not.toContain(disabled.name);
            });
        });
});
