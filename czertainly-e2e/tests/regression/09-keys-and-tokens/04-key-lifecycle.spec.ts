/**
 * REG-KEY-04, REG-KEY-05, REG-KEY-06, REG-KEY-08, REG-KEY-09 — Keys in the admin UI. ilm#431, core#2069.
 *
 * WHAT: 1. Create Key, one test per family (RSA-2048, RSA-4096, EC P-256, ML-DSA-65, Falcon-1024; REG-KEY-04) with a double click on
 *          Create → at most one create request; the detail shows a Private and a Public item, both Active and disabled, with the
 *          algorithm and the usages of each item type.
 *       2. Enable the key (REG-KEY-05) → Sign is enabled on the private item and Verify on the public item; Disable turns them off.
 *       3. Sign with the private item and Verify with the public item (REG-KEY-06; RSA-2048, EC P-256, ML-DSA-65) → the signature
 *          download has the family's size, verifies with the same data and not with tampered data; no Encrypt or Decrypt control.
 *       4. Compromise (REG-KEY-08) → the item can no longer sign, verify or be compromised again; the API state agrees.
 *       5. Destroy (REG-KEY-09) → only a compromised item can be destroyed (state "destroyed compromised"), and it cannot sign.
 * WHY: key operations need an Active, enabled item, and the state machine of compromise and destroy must hold in the UI; no new
 *      frontend flow for encrypt or decrypt is introduced (core#2069).
 * HOW: the run token and profile come from the API (`ownKeys.chain()` makes them when the run has none; `@needs:crypto-v2` skips a tier
 *      without a v2 cryptography connector before anything is written) and are proven live before the browser or a key create acts on them.
 *      Keys made in the form are recorded from the create answer before the redirect is waited for; keys made through the API are own, and
 *      every key made inside a test is hard-deleted at its end. Sign and verify end in downloads, which the tests read and judge.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { Download } from '@playwright/test';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import type { RegressionFixtures } from '../../../fixtures/regressionFixtures';
import { KEY_FAMILIES, KeyFamily, KeyPage } from '../../../pages/KeyPage';
import { expectedItemUsages, PROFILE_USAGES, sameUsages } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { getKey, itemOf, keyAlias, KeyChain } from '../../../utils/regression/platform/keys';
import type { OwnRef } from '../../../utils/regression/ledger/ledger';
import { lookupKey, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { runName, ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { UI_KEY_FLOW_MS } from '../../../utils/regression/timeouts';

const FAMILY_ALGORITHM: Record<KeyFamily, string> = { 'rsa-2048': 'RSA', 'rsa-4096': 'RSA', 'ec-p256': 'ECDSA', 'ml-dsa-65': 'ML-DSA', 'falcon-1024': 'FALCON' };

/** The bytes of a download (Playwright keeps it under the test output; the suite writes it nowhere else). */
async function downloadBytes(download: Download): Promise<Buffer> {
    const file = await download.path();
    if (!file) throw new Error(`download ${download.suggestedFilename()} has no file (${(await download.failure()) ?? 'no failure reported'})`);
    return fs.readFileSync(file);
}

/** Verify Signature with `data` and `signature` on the shown public item: the `result` of the downloaded verification (true = verified). */
async function verified(keys: KeyPage, data: string, signature: Buffer): Promise<boolean> {
    const download = await keys.operations.verifyWithKey(data, signature);
    expect(download.suggestedFilename(), 'the UI downloads the verification result').toMatch(/verification-result\.json$/);
    const body = JSON.parse((await downloadBytes(download)).toString('utf8')) as { verifications?: Array<{ result?: boolean }> };
    const result = body.verifications?.[0]?.result;
    expect(typeof result, 'the verification result carries a boolean').toBe('boolean');
    return result === true;
}

/**
 * The raw signature of the family has its fixed size: RSA-2048 256 bytes, ML-DSA-65 3309 bytes (FIPS 204), ECDSA P-256 a
 * DER SEQUENCE of at most 72 bytes (or 64 bytes as plain r || s).
 */
function expectSignatureSize(family: KeyFamily, sig: Buffer): void {
    if (family === 'rsa-2048') expect(sig.length, 'RSA-2048 signature size').toBe(256);
    else if (family === 'ml-dsa-65') expect(sig.length, 'ML-DSA-65 signature size').toBe(3309);
    else if (family === 'ec-p256') expect(sig.length === 64 || (sig[0] === 0x30 && sig.length >= 8 && sig.length <= 72), `ECDSA P-256 signature of ${sig.length} bytes`).toBe(true);
    else expect(sig.length, 'a non-empty signature').toBeGreaterThan(0);
}

/** Proves the run's token and token profile are live objects of this run before the browser or a key create acts on them. */
async function proveChain(live: RegressionFixtures['live'], chain: KeyChain): Promise<void> {
    await live('tokens', chain.token);
    await live('tokenProfiles', chain.tokenProfile);
}

test.describe('Keys in the admin UI', { tag: tags.regression }, () => {
    for (const family of Object.keys(KEY_FAMILIES) as KeyFamily[]) {
        test(`the Create Key form makes one ${KEY_FAMILIES[family].label} key with two active, disabled items`,
            testMeta({
                id: 'REG-KEY-04', row: family, prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2',
                rule: [
                    'new items are ACTIVE and disabled, not "Active / Enabled"; usages per item type; the form lists enabled profiles only; a double submit sends at most one create',
                ],
            }),
            async ({ signedIn: page, api, own, live, ownKeys }, testInfo) => {
                test.setTimeout(UI_KEY_FLOW_MS);
                const c = await ownKeys.chain();
                await proveChain(live, c);
                const keys = new KeyPage(page);
                const name = ownName(`uikey-${family}`);
                const creates = keys.watchCreates();

                const note = `own ${KEY_FAMILIES[family].label} key through the UI`;
                const parents = { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid };
                const answer = await test.step('Fill the form (the Token Profile select offers the run profile) and double-click Create', async () => {
                    await keys.goToList();
                    await keys.openCreateDialog();
                    expect(await keys.offeredTokenProfiles(), 'the enabled run profile is offered').toContain(c.tokenProfile.name);
                    await keys.fillKeyPair({ name, tokenProfileName: c.tokenProfile.name, alias: keyAlias(name), family });
                    return await submitRecordingByNameOnFailure({ type: 'keys', name, spec: own.spec, note, parents, lookup: lookupKey(api) }, () => keys.submitCreateForm({ doubleClick: true }));
                });
                // The ledger lines come from the create answers, before the redirect is waited for and before the number of creates is
                // judged: a double click may send two creates, and every accepted one is an object on the tier (tracked: deleted after
                // the test). A refusal is raised after every answer was recorded.
                const recorded: OwnRef[] = [];
                const refusals: string[] = [];
                const record = (each: typeof answer, why: string): void => {
                    const ref = ownKeys.record(each, { name, note: why, parents, track: true });
                    if (ref) recorded.push(ref);
                    else refusals.push(`the key create was answered ${each.status}${each.uuid ? '' : ' without an id'}: ${each.text.slice(0, 300)}`);
                };
                record(answer, note);
                for (const each of (await creates.settled()).filter((other) => other.request !== answer.request)) record(each, `${note} (another create of the double click)`);
                if (refusals.length) throw new Error(refusals[0]);
                const uuid = recorded[0].uuid;
                await keys.waitForDetailRoute();
                expect(creates.requests(), 'at most one create request on a double click').toBeLessThanOrEqual(1);

                await test.step('Detail: a Private and a Public item, Active, Disabled, the algorithm, the usages of each item type', async () => {
                    await keys.goToDetail(uuid);
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

    test('enabling a key enables Sign and Verify on its items, and disabling turns them off again',
        testMeta({ id: 'REG-KEY-05', prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2', rule: ['operations need ACTIVE and enabled; FE CryptographicKeyItem (button enablement) and the key detail page (key-level buttons)'] }),
        async ({ signedIn: page, api, live, ownKeys }) => {
            test.setTimeout(UI_KEY_FLOW_MS);
            const c = await ownKeys.chain();
            await proveChain(live, c);
            const key = await ownKeys.make('ui05', { chain: c, family: 'rsa-2048' });
            const keys = new KeyPage(page);
            await keys.goToDetail(key.uuid);

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
                expect((await getKey(api, key.uuid)).items!.every((i) => i.enabled === true)).toBe(true);
            });
            await test.step('Disable → back', async () => {
                await keys.disableKey();
                await expect(keys.keyButton('enable')).toBeEnabled();
                await keys.openKeyItem('Private key');
                await keys.assertItemEnabled(false);
                await keys.assertItemButtons({ sign: 'disabled' });
            });
        });

    for (const family of ['rsa-2048', 'ec-p256', 'ml-dsa-65'] as KeyFamily[]) {
        test(`a ${KEY_FAMILIES[family].label} signature from the private item verifies with the public item`,
            testMeta({ id: 'REG-KEY-06', row: family, prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2', rule: ['private signs, public verifies; core#2069 AC ("No new administrator frontend flow is introduced for encrypt or decrypt"); the FE cryptographic-operations module (signature.sign / verification-result.json downloads)'] }),
            async ({ signedIn: page, api, own, live, ownKeys }) => {
                test.setTimeout(UI_KEY_FLOW_MS);
                const c = await ownKeys.chain();
                await proveChain(live, c);
                const key = await ownKeys.make(`ui06-${family}`, { chain: c, family, enabled: true });
                const keys = new KeyPage(page);
                await keys.goToDetail(key.uuid);
                const data = `${own.spec} ${family} ${crypto.randomBytes(16).toString('hex')}`;

                const signature = await test.step('Private key → Sign → the signature is delivered (download)', async () => {
                    await keys.openKeyItem('Private key');
                    const download = await keys.operations.signWithKey(data);
                    expect(download.suggestedFilename(), 'the UI downloads the signature').toMatch(/\.sign$/);
                    const sig = await downloadBytes(download);
                    expectSignatureSize(family, sig);
                    return sig;
                });
                await test.step('Public key → Verify with the same data → verified; tampered data → not verified', async () => {
                    await keys.openKeyItem('Public key');
                    expect(await verified(keys, data, signature), 'verified').toBe(true);
                    expect(await verified(keys, `${data}-tampered`, signature), 'not verified').toBe(false);
                });
                await test.step('No Encrypt / Decrypt control on either item', async () => {
                    for (const tab of ['Private key', 'Public key'] as const) {
                        await keys.openKeyItem(tab);
                        await keys.assertItemButtons({ encrypt: 'absent', decrypt: 'absent' });
                    }
                });
            });
    }

    test('a compromised key item can no longer sign, verify or be compromised again',
        testMeta({ id: 'REG-KEY-08', prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2', rule: ['compromise from PRE_ACTIVE / ACTIVE / DEACTIVATED; FE CryptographicKeyItem (Compromise disabled outside those states; Sign and Verify need Active)'] }),
        async ({ signedIn: page, api, live, ownKeys }) => {
            test.setTimeout(UI_KEY_FLOW_MS);
            const c = await ownKeys.chain();
            await proveChain(live, c);
            const key = await ownKeys.make('ui08', { chain: c, family: 'rsa-2048', enabled: true });
            const keys = new KeyPage(page);
            await keys.goToDetail(key.uuid);
            await test.step('Private item: Compromise → Compromised, no more Sign or Compromise (API agrees)', async () => {
                await keys.openKeyItem('Private key');
                await keys.assertItemButtons({ compromise: 'enabled', sign: 'enabled', destroy: 'disabled' });
                await keys.compromiseKeyItem();
                await keys.assertItemState(/Compromised/);
                await keys.assertItemButtons({ compromise: 'disabled', sign: 'disabled' });
                expect(String(itemOf(await getKey(api, key.uuid), 'private')!.state).toLowerCase()).toBe('compromised');
            });
            await test.step('Public item: Compromise → Compromised, no more Verify or Compromise', async () => {
                await keys.openKeyItem('Public key');
                await keys.compromiseKeyItem();
                await keys.assertItemState(/Compromised/);
                await keys.assertItemButtons({ compromise: 'disabled', verify: 'disabled' });
            });
        });

    test('only a compromised key item can be destroyed, and a destroyed item cannot sign',
        testMeta({ id: 'REG-KEY-09', prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2', rule: ['destroy from PRE_ACTIVE / DEACTIVATED / COMPROMISED only; COMPROMISED → DESTROYED_COMPROMISED; FE CryptographicKeyItem (Destroy disabled outside those states)'] }),
        async ({ signedIn: page, api, live, ownKeys }) => {
            test.setTimeout(UI_KEY_FLOW_MS);
            const c = await ownKeys.chain();
            await proveChain(live, c);
            const key = await ownKeys.make('ui09', { chain: c, family: 'rsa-2048', enabled: true });
            const keys = new KeyPage(page);
            await keys.goToDetail(key.uuid);
            await test.step('An active item cannot be destroyed; after Compromise it can', async () => {
                await keys.openKeyItem('Private key');
                await keys.assertItemButtons({ destroy: 'disabled' });
                await keys.compromiseKeyItem();
                await keys.assertItemState(/Compromised/);
                await keys.assertItemButtons({ destroy: 'enabled' });
            });
            await test.step('Destroy → Destroyed Compromised; the item can no longer sign, be destroyed or be compromised (API agrees)', async () => {
                await keys.destroyKeyItem();
                await keys.assertItemState(/Destroyed.*Compromised/i);
                await keys.assertItemButtons({ sign: 'disabled', destroy: 'disabled', compromise: 'disabled' });
                expect(String(itemOf(await getKey(api, key.uuid), 'private')!.state).toLowerCase()).toBe('destroyedcompromised');
            });
        });
});
