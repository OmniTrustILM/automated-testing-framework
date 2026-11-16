/**
 * REG-KEY-04, -05, -06, -08, -09 — keys in the admin UI: create per family, sign and verify, compromise and destroy (ilm#431, core#2069).
 * Every key made inside a test is hard-deleted at its end.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { Download } from '@playwright/test';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import type { RegressionFixtures } from '../../../fixtures/regressionFixtures';
import { KEY_FORM_OPTIONS, KeyFamily, KeyPage } from '../../../pages/KeyPage';
import type { CreateAnswer } from '../../../pages/ui/createAnswer';
import { waitForDetailRoute } from '../../../pages/ui/detailRoute';
import { expectedItemUsages, FAMILIES, PROFILE_USAGES, sameUsages } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { DESTROYED_KEY_STAYS, getKey, itemOf, keyAlias, KeyChain, liveKeysNamed } from '../../../utils/regression/platform/keys';
import { pollUntil } from '../../../utils/regression/wait';
import type { OwnRef } from '../../../utils/regression/ledger/ledger';
import { lookupKey, submitRecordingByNameOnFailure } from '../../../utils/regression/ledger/uiCreates';
import { ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { isLocalTier } from '../../../utils/regression/tier/kind';
import { PAGE_ROUTE_MS, UI_KEY_FLOW_MS } from '../../../utils/regression/timeouts';

/** The bytes of a download (Playwright keeps it under the test output; the suite writes it nowhere else). */
async function downloadBytes(download: Download): Promise<Buffer> {
    const file = await download.path();
    if (!file) throw new Error(`download ${download.suggestedFilename()} has no file (${(await download.failure()) ?? 'no failure reported'})`);
    return fs.readFileSync(file);
}

/** Verify Signature with `data` and `signature` on the shown public item: the `result` of the downloaded verification (true = verified). */
async function verified(keys: KeyPage, data: string, signature: Buffer): Promise<boolean> {
    const download = await keys.verifyWithKey(data, signature);
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

/**
 * The item's tab after a compromise or destroy: once the change lands the detail selects its first tab again, at a moment the page does
 * not announce, so the tab is chosen until it shows `state` and `buttons`.
 */
async function expectItemAfterChange(keys: KeyPage, tab: 'Private key' | 'Public key', state: RegExp, buttons: Parameters<KeyPage['assertItemButtons']>[0]): Promise<void> {
    await expect(async () => {
        await keys.openKeyItem(tab);
        await keys.assertItemState(state, 3_000);
        await keys.assertItemButtons(buttons);
    }, `the ${tab} tab shows ${state} and its buttons`).toPass({ timeout: PAGE_ROUTE_MS });
}

/** Proves the run's token and token profile are live objects of this run before the browser or a key create acts on them. */
async function proveChain(live: RegressionFixtures['live'], chain: KeyChain): Promise<void> {
    await live('tokens', chain.token);
    await live('tokenProfiles', chain.tokenProfile);
}

test.describe('Keys in the admin UI', { tag: tags.regression }, () => {
    for (const family of Object.keys(KEY_FORM_OPTIONS) as KeyFamily[]) {
        test(`the Create Key form makes one ${FAMILIES[family].label} key with two active, disabled items`,
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

                const note = `own ${FAMILIES[family].label} key through the UI`;
                const parents = { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid };
                // Every create of the double click is recorded before the number of creates is judged, each accepted one tracked (deleted
                // after the test): from its answer, or by name when the browser dropped the answer (a second submit cancels the first
                // request, whose key may still land). A refusal is raised after every create was recorded.
                const recorded: OwnRef[] = [];
                const refusals: string[] = [];
                const record = (each: Pick<CreateAnswer, 'status' | 'uuid' | 'text'>, why: string): void => {
                    const ref = ownKeys.record(each, { name, note: why, parents, track: true });
                    if (ref) recorded.push(ref);
                    else refusals.push(`the key create was answered ${each.status}${each.uuid ? '' : ' without an id'}: ${each.text.slice(0, 300)}`);
                };
                const submittedAt = Date.now();
                let first: CreateAnswer | undefined;
                let answered: CreateAnswer[] = [];
                try {
                    first = await test.step('Fill the form (the Token Profile select offers the run profile) and double-click Create', async () => {
                        await keys.goToList();
                        await keys.openCreateModal();
                        expect(await keys.offeredTokenProfiles(), 'the enabled run profile is offered').toContain(c.tokenProfile.name);
                        await keys.fillKeyPair({ name, tokenProfileName: c.tokenProfile.name, alias: keyAlias(name), family });
                        return await submitRecordingByNameOnFailure({ type: 'keys', name, spec: own.spec, note, parents, lookup: lookupKey(api) }, () => keys.submitCreateForm({ doubleClick: true }));
                    });
                    answered = await creates.settled();
                } finally {
                    creates.stop();
                    // The first answer's body may be unreadable once the page moved on; the by-name adoption filled its uuid then.
                    const answers = (answered.length ? answered : first ? [first] : []).map((a) =>
                        (a.request === first?.request && a.uuid === undefined ? { ...a, uuid: first.uuid } : a));
                    answers.forEach((each, i) => record(each, i === 0 ? note : `${note} (another create of the double click)`));
                    const dropped = creates.requests() - answers.length;
                    if (dropped > 0) {
                        try {
                            const known = new Set(recorded.map((r) => r.uuid));
                            const found = await pollUntil(() => liveKeysNamed(api, name, submittedAt), (rows) => rows.filter((k) => !known.has(k.uuid)).length >= dropped,
                                { timeoutMs: PAGE_ROUTE_MS, intervalMs: 2_000, tolerateErrors: 2, onTimeout: 'return' });
                            for (const k of found.filter((row) => !known.has(row.uuid))) {
                                record({ status: 200, uuid: k.uuid, text: '' }, `${note} (found by name: the browser dropped the answer of the double click)`);
                            }
                        } catch (e) {
                            testInfo.annotations.push({ type: 'unrecorded-create', description: `${dropped} dropped create(s) of ${name} not looked up: ${String(e).slice(0, 200)}` });
                        }
                    }
                }
                // Judged before the refusals: the second create of a double click may be refused as a concurrent change of the token.
                expect(creates.requests(), 'at most one create request on a double click').toBeLessThanOrEqual(1);
                if (refusals.length) throw new Error(refusals[0]);
                const uuid = recorded[0].uuid;
                await waitForDetailRoute(page, 'keys', { timeout: PAGE_ROUTE_MS });

                await test.step('Detail: a Private and a Public item, Active, Disabled, the algorithm, the usages of each item type', async () => {
                    await keys.goToDetail(uuid);
                    const detail = await getKey(api, uuid);
                    expect((detail.items ?? []).length).toBe(2);
                    for (const [tab, kind] of [['Private key', 'private'], ['Public key', 'public']] as const) {
                        await keys.openKeyItem(tab);
                        await keys.assertItemState(/^\s*Active\s*$/);
                        await keys.assertItemEnabled(false);
                        await keys.assertItemAlgorithm(new RegExp(FAMILIES[family].algorithm.replace('-', '-?'), 'i'));
                        const item = itemOf(detail, kind)!;
                        expect(String(item.state).toLowerCase(), `${kind} state (API)`).toBe('active');
                        expect(item.enabled, `${kind} enabled (API)`).toBe(false);
                        expect(sameUsages(item.usage ?? [], expectedItemUsages(PROFILE_USAGES, kind, FAMILIES[family].algorithm)), `${kind} usages ${JSON.stringify(item.usage)}`).toBe(true);
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
                await expect(keys.disableKeyButton).toBeEnabled();
                await keys.openKeyItem('Private key');
                await keys.assertItemEnabled(true);
                await keys.assertItemButtons({ sign: 'enabled', verify: 'disabled' });
                await keys.openKeyItem('Public key');
                await keys.assertItemButtons({ verify: 'enabled', sign: 'disabled' });
                expect((await getKey(api, key.uuid)).items!.every((i) => i.enabled === true)).toBe(true);
            });
            await test.step('Disable → back', async () => {
                await keys.disableKey();
                await expect(keys.enableKeyButton).toBeEnabled();
                await keys.openKeyItem('Private key');
                await keys.assertItemEnabled(false);
                await keys.assertItemButtons({ sign: 'disabled' });
            });
        });

    for (const family of ['rsa-2048', 'ec-p256', 'ml-dsa-65'] as KeyFamily[]) {
        test(`a ${FAMILIES[family].label} signature from the private item verifies with the public item`,
            testMeta({ id: 'REG-KEY-06', row: family, prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2', rule: ['private signs, public verifies; core#2069 AC ("No new administrator frontend flow is introduced for encrypt or decrypt"); the FE cryptographic-operations module (signature.sign / verification-result.json downloads)'] }),
            async ({ signedIn: page, own, live, ownKeys }) => {
                test.setTimeout(UI_KEY_FLOW_MS);
                const c = await ownKeys.chain();
                await proveChain(live, c);
                const key = await ownKeys.make(`ui06-${family}`, { chain: c, family, enabled: true });
                const keys = new KeyPage(page);
                await keys.goToDetail(key.uuid);
                const data = `${own.spec} ${family} ${crypto.randomBytes(16).toString('hex')}`;

                const signature = await test.step('Private key → Sign → the signature is delivered (download)', async () => {
                    await keys.openKeyItem('Private key');
                    const download = await keys.signWithKey(data);
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
                await expectItemAfterChange(keys, 'Private key', /Compromised/, { compromise: 'disabled', sign: 'disabled' });
                expect(String(itemOf(await getKey(api, key.uuid), 'private')!.state).toLowerCase()).toBe('compromised');
            });
            await test.step('Public item: Compromise → Compromised, no more Verify or Compromise', async () => {
                await keys.openKeyItem('Public key');
                await keys.compromiseKeyItem();
                await expectItemAfterChange(keys, 'Public key', /Compromised/, { compromise: 'disabled', verify: 'disabled' });
            });
        });

    test('only a compromised key item can be destroyed, and a destroyed item cannot sign',
        testMeta({ id: 'REG-KEY-09', prio: 'P2', issue: 'ilm#431', needs: 'crypto-v2', rule: ['destroy from PRE_ACTIVE / DEACTIVATED / COMPROMISED only; COMPROMISED → DESTROYED_COMPROMISED; FE CryptographicKeyItem (Destroy disabled outside those states)'] }),
        async ({ signedIn: page, api, live, ownKeys }) => {
            test.skip(!isLocalTier(), DESTROYED_KEY_STAYS);
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
                await expectItemAfterChange(keys, 'Private key', /Compromised/, { destroy: 'enabled' });
            });
            await test.step('Destroy → Destroyed Compromised; the item can no longer sign, be destroyed or be compromised (API agrees)', async () => {
                await keys.destroyKeyItem();
                await expectItemAfterChange(keys, 'Private key', /Destroyed.*Compromised/i, { sign: 'disabled', destroy: 'disabled', compromise: 'disabled' });
                expect(String(itemOf(await getKey(api, key.uuid), 'private')!.state).toLowerCase()).toBe('destroyedcompromised');
            });
        });
});
