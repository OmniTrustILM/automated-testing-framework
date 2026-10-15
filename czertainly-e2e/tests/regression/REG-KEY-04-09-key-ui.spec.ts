/**
 * REG-KEY-04 / 05 / 06 / 08 / 09 — keys through the admin UI: create per family (extends SMK-006), enable / disable and
 * the operation buttons, sign and verify, compromise, destroy (ilm#431, T7; platform area).
 *
 * Own objects only: the run token and enabled profile come from `ensureKeyChain` (API); keys made through the form are
 * recorded in the ledger right after the create (uuid from the detail URL) and before any assertion; the keys the
 * lifecycle rows mutate are own keys made for them. The key-level and the item-level toolbars share button ids: the
 * page object scopes them (`keyActions()` = the Key Details widget, `itemActions()` = the shown item; R2 /
 * fe-administrator#2325 workaround until the `key-item-actions` hook lands). Sign and verify end in downloads
 * (`signature.sign`, `verification-result.json`): the FE has no result dialog, the download IS the shown result.
 */
import * as crypto from 'crypto';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { KeyPage, UI_FAMILY, UiKeyFamily } from '../../pages/KeyPage';
import { expectedItemUsages, PROFILE_USAGES, sameUsages } from '../../utils/regression/cryptoMatrix';
import { createOwnKey, deleteOwnKey, ensureKeyChain, getKey, isSkip, itemOf, keyAlias, KeyChain } from '../../utils/regression/keyApi';
import { OwnRef, recordCreated, regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-KEY-04-09';
type Json = Record<string, any>;

const FAMILY_ALGORITHM: Record<UiKeyFamily, string> = { 'rsa-2048': 'RSA', 'rsa-4096': 'RSA', 'ec-p256': 'ECDSA', 'ml-dsa-65': 'ML-DSA', 'falcon-1024': 'FALCON' };

/** Keys made inside a test, deleted at its end (own hard delete; SCP#137 cap per token, Sonnet F6). */
const made: OwnRef[] = [];

test.describe('REG-KEY keys (UI)', { tag: tags.regression }, () => {
    test.afterEach(async ({ api }) => {
        for (const key of made.splice(0)) await deleteOwnKey(api, key, SPEC);
    });

    for (const family of Object.keys(UI_FAMILY) as UiKeyFamily[]) {
        test(`REG-KEY-04[${family}]: Create Key (${UI_FAMILY[family].label}) through the form: enabled profiles only, one create request on a double click, a PRIVATE and a PUBLIC item Active and Disabled with the r10 usages`,
            meta({
                id: 'REG-KEY-04', prio: 'P1', issue: 'ilm#431',
                rule: [
                    'platform-keys-connectors A2 r12 (new items ACTIVE and disabled — not "Active / Enabled", K3), r10 (usages per item type), r8 (the form lists enabled profiles only); SMK-006 (automated-testing-framework PR #104); catalogue E (double submit)',
                ],
            }),
            async ({ page, api, env }, testInfo) => {
                test.setTimeout(240_000);
                const chain = await ensureKeyChain(api, SPEC);
                test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
                const c = chain as KeyChain;
                await loginAsSmokeUser(page, env);
                const keys = new KeyPage(page);
                const name = regName(`uikey-${family}-${Date.now().toString(36)}`);
                let creates = 0;
                page.on('request', (r) => {
                    if (r.method() === 'POST' && /\/keys\/keyPair$/.test(r.url().split('?')[0])) creates += 1;
                });

                const uuid = await test.step('Fill the form (the Token Profile select offers the run profile) and double-click Create', async () => {
                    await keys.goToList();
                    await keys.openCreateModal();
                    expect(await keys.tokenProfileOptions(), 'the enabled run profile is offered').toContain(c.tokenProfile.name);
                    await keys.fillKeyPair({ name, tokenProfileName: c.tokenProfile.name, alias: keyAlias(name), family });
                    await keys.submitButton().dblclick();
                    await expect(page).toHaveURL(/\/keys\/detail\/[0-9a-f-]{36}/, { timeout: 30_000 });
                    return /\/keys\/detail\/([0-9a-f-]{36})/.exec(page.url())![1];
                });
                made.push(recordCreated('keys', { uuid, name }, SPEC, `own ${UI_FAMILY[family].label} key through the UI`, { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }));
                expect(creates, 'at most one create request on a double click').toBeLessThanOrEqual(1);

                await test.step('Detail: a Private and a Public item, Active, Disabled, the algorithm, the r10 usages', async () => {
                    await keys.openDetail(uuid);
                    const detail = await getKey(api, uuid);
                    expect((detail.items ?? []).length).toBe(2);
                    for (const [tab, kind] of [['Private key', 'private'], ['Public key', 'public']] as const) {
                        await keys.openKeyItem(tab);
                        await keys.assertItemState(/^\s*Active\s*$|Active/);
                        await keys.assertItemEnabled(false);
                        await keys.assertItemAlgorithm(new RegExp(FAMILY_ALGORITHM[family].replace('-', '-?'), 'i'));
                        const item = itemOf(detail, kind)!;
                        expect(String(item.state).toLowerCase(), `${kind} state (API)`).toBe('active');
                        expect(item.enabled, `${kind} enabled (API)`).toBe(false);
                        expect(sameUsages(item.usage ?? [], expectedItemUsages(PROFILE_USAGES, kind, FAMILY_ALGORITHM[family])), `${kind} usages ${JSON.stringify(item.usage)}`).toBe(true);
                    }
                    testInfo.annotations.push({ type: 'key-uuid', description: uuid });
                });
            });
    }

    test('REG-KEY-05: a new key: Enable enabled, Disable disabled, Sign and Verify disabled; Enable → Enabled badge, Sign (private) and Verify (public) enabled; Disable → back',
        meta({ id: 'REG-KEY-05', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r12, r14 (operations need ACTIVE and enabled); FE CryptographicKeyItem.tsx:247-305 (button enablement), detail/index.tsx:212-243 (key-level buttons)'] }),
        async ({ page, api, env }) => {
            test.setTimeout(240_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `ui05-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048' });
            made.push(key);
            await loginAsSmokeUser(page, env);
            const keys = new KeyPage(page);
            await keys.openDetail(key.uuid);

            await test.step('New key: key-level Enable enabled, Disable disabled; items: Sign / Verify disabled', async () => {
                await keys.assertKeyButtons({ enable: 'enabled', disable: 'disabled' });
                await keys.openKeyItem('Private key');
                await keys.assertItemEnabled(false);
                await keys.assertItemButtons({ sign: 'disabled', enable: 'enabled', disable: 'disabled' });
                await keys.openKeyItem('Public key');
                await keys.assertItemButtons({ verify: 'disabled' });
            });
            await test.step('Enable → Enabled; Sign enabled on the private item, Verify on the public item', async () => {
                await keys.enableKey();
                await expect(keys.keyButton('disable')).toBeEnabled();
                await keys.openKeyItem('Private key');
                await keys.assertItemEnabled(true);
                await keys.assertItemButtons({ sign: 'enabled', verify: 'disabled' });
                await keys.openKeyItem('Public key');
                await keys.assertItemButtons({ verify: 'enabled', sign: 'disabled' });
                expect((await getKey(api, key.uuid)).items.every((i: Json) => i.enabled === true)).toBe(true);
            });
            await test.step('Disable → back', async () => {
                await keys.disableKey();
                await expect(keys.keyButton('enable')).toBeEnabled();
                await keys.openKeyItem('Private key');
                await keys.assertItemEnabled(false);
                await keys.assertItemButtons({ sign: 'disabled' });
            });
        });

    for (const family of ['rsa-2048', 'ec-p256', 'ml-dsa-65'] as UiKeyFamily[]) {
        test(`REG-KEY-06[${family}]: Sign on the private item delivers a signature; Verify on the public item reports verified; tampered data reports not verified; no Encrypt / Decrypt control`,
            meta({ id: 'REG-KEY-06', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r14, r15 (private signs, public verifies), r17; core#2069 AC ("No new administrator frontend flow is introduced for encrypt or decrypt"); FE ducks/cryptographic-operations.ts (signature.sign / verification-result.json downloads)'] }),
            async ({ page, api, env }) => {
                test.setTimeout(240_000);
                const chain = await ensureKeyChain(api, SPEC);
                test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
                const c = chain as KeyChain;
                const key = await createOwnKey(api, c, `ui06-${family}-${Date.now().toString(36)}`, SPEC, { family: family as any, enabled: true });
            made.push(key);
                await loginAsSmokeUser(page, env);
                const keys = new KeyPage(page);
                await keys.openDetail(key.uuid);
                const data = `${SPEC} ${family} ${crypto.randomBytes(16).toString('hex')}`;

                const signature = await test.step('Private key → Sign → the signature is delivered (download)', async () => {
                    await keys.openKeyItem('Private key');
                    const sig = await keys.signItem(data);
                    expect(sig.length, 'a non-empty signature').toBeGreaterThan(0);
                    return sig;
                });
                await test.step('Public key → Verify with the same data → verified; tampered data → not verified', async () => {
                    await keys.openKeyItem('Public key');
                    expect(await keys.verifyItem(data, signature), 'verified').toBe(true);
                    expect(await keys.verifyItem(`${data}-tampered`, signature), 'not verified').toBe(false);
                });
                await test.step('No Encrypt / Decrypt control on either item', async () => {
                    for (const tab of ['Private key', 'Public key'] as const) {
                        await keys.openKeyItem(tab);
                        await expect(keys.itemActions().getByTestId(/^(encrypt|decrypt)-button$/)).toHaveCount(0);
                    }
                });
            });
    }

    test('REG-KEY-08: Compromise (reason) → state Compromised; Compromise disabled; Sign / Verify disabled',
        meta({ id: 'REG-KEY-08', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r19 (compromise from PRE_ACTIVE / ACTIVE / DEACTIVATED), r14; FE CryptographicKeyItem.tsx:274 (Compromise disabled outside those states), :292-305 (Sign / Verify need Active)'] }),
        async ({ page, api, env }) => {
            test.setTimeout(240_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `ui08-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            await loginAsSmokeUser(page, env);
            const keys = new KeyPage(page);
            await keys.openDetail(key.uuid);
            await keys.openKeyItem('Private key');
            await keys.assertItemButtons({ compromise: 'enabled', sign: 'enabled', destroy: 'disabled' });
            await keys.compromiseItem();
            await keys.assertItemState(/Compromised/);
            await keys.assertItemButtons({ compromise: 'disabled', sign: 'disabled' });
            expect(String(itemOf(await getKey(api, key.uuid), 'private')!.state).toLowerCase()).toBe('compromised');
            await keys.openKeyItem('Public key');
            await keys.compromiseItem();
            await keys.assertItemState(/Compromised/);
            await keys.assertItemButtons({ compromise: 'disabled', verify: 'disabled' });
        });

    test('REG-KEY-09: Destroy is disabled while Active and enabled once Compromised; Destroy → Destroyed Compromised; Sign disabled',
        meta({ id: 'REG-KEY-09', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r20 (destroy from PRE_ACTIVE / DEACTIVATED / COMPROMISED only; COMPROMISED → DESTROYED_COMPROMISED); FE CryptographicKeyItem.tsx:283 (Destroy disabled outside those states)'] }),
        async ({ page, api, env }) => {
            test.setTimeout(240_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `ui09-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            await loginAsSmokeUser(page, env);
            const keys = new KeyPage(page);
            await keys.openDetail(key.uuid);
            await keys.openKeyItem('Private key');
            await keys.assertItemButtons({ destroy: 'disabled' });
            await keys.compromiseItem();
            await keys.assertItemState(/Compromised/);
            await keys.assertItemButtons({ destroy: 'enabled' });
            await keys.destroyItem();
            await keys.assertItemState(/Destroyed.*Compromised/i);
            await keys.assertItemButtons({ sign: 'disabled', destroy: 'disabled', compromise: 'disabled' });
            expect(String(itemOf(await getKey(api, key.uuid), 'private')!.state).toLowerCase()).toBe('destroyedcompromised');
        });
});
