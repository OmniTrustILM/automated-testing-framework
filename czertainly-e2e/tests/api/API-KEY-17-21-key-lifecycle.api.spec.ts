/**
 * API-KEY-17 / 18 / 19 / 20 — the lifecycle of an own key: enable / disable (idempotent, event once), compromise,
 * destroy, and the terminal states (ilm#431, T7; platform area). State model §2.1 (code, core#420; OQ-2 names the docs
 * diagram as the alternative: these tests follow the code, A2 r19–r20).
 *
 * Each row is split in two tests: `[state]` asserts the transitions, refusals and history through the KEY-level routes
 * (`PATCH /v1/keys/{uuid}/enable|disable|compromise|destroy`); `[ops]` asserts the operation refusals on the ITEMS
 * (sign / verify / encrypt / decrypt; own `keyItems` ledger lines since the guard-integration pass, platform G-1).
 */
import * as crypto from 'crypto';
import { expect, test } from '../../fixtures/testFixtures';
import { signVariants } from '../../utils/regression/cryptoMatrix';
import { expect422Messages } from '../../utils/regression/errorContract';
import {
    cipherWithItem, compromiseOwnKey, createOwnKey, deleteOwnKey, destroyOwnKey, disableOwnKey, enableOwnKey, ensureKeyChain, eventsOf, getKey, isSkip, itemOf, itemRef, KeyChain,
    keyItemHistory, listSignAttributes, signatureAttributesFor, signWithItem, updateOwnKeyItemUsages, verifyWithItem,
} from '../../utils/regression/keyApi';
import { OwnRef } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-KEY-17-21';
type Json = Record<string, any>;

const COMPROMISE_AGGREGATE = 'Some key items could not be marked as compromised. Compromise is allowed only in states Pre-active, Active, or Deactivated.';
const DESTROY_AGGREGATE = 'Key items could not be destroyed because their current states do not allow destruction. Destruction is allowed only in states Pre-active, Deactivated, or Compromised.';

const itemStates = (detail: Json): string[] => (detail.items ?? []).map((i: Json) => String(i.state).toLowerCase());

/** Keys made inside a test, deleted at its end (own hard delete; SCP#137 cap per token, Sonnet F6). */
const made: OwnRef[] = [];

test.describe('API-KEY lifecycle', { tag: tags.api }, () => {
    test.afterEach(async ({ api }) => {
        for (const key of made.splice(0)) await deleteOwnKey(api, key, SPEC);
    });

    test('API-KEY-17[state]: disable and enable are immediate and idempotent; repeated calls add no event: after two real disable / enable transitions each item history holds exactly 2 DISABLE and 2 ENABLE',
        meta({ id: 'API-KEY-17', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r18 (enable / disable: boolean, idempotent conditional UPDATE, event only on change; CryptographicKeyWriter:568-577), r23 (ENABLE / DISABLE events)'] }),
        async ({ api }) => {
            test.setTimeout(120_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k17-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            const history = async (kind: 'private' | 'public') => keyItemHistory(api, key.uuid, String(itemOf(await getKey(api, key.uuid), kind)!.uuid));

            await test.step('disable → items disabled at once', async () => {
                await disableOwnKey(api, key);
                expect((await getKey(api, key.uuid)).items.every((i: Json) => i.enabled === false)).toBe(true);
            });
            await test.step('enable → items enabled; a second enable and a second disable / enable pair answer 2xx and add no event', async () => {
                await enableOwnKey(api, key);
                expect((await getKey(api, key.uuid)).items.every((i: Json) => i.enabled === true)).toBe(true);
                await enableOwnKey(api, key);
                await disableOwnKey(api, key);
                await disableOwnKey(api, key);
                await enableOwnKey(api, key);
                await enableOwnKey(api, key);
            });
            await test.step('History: DISABLE twice and ENABLE twice per item (two real transitions each), never more', async () => {
                for (const kind of ['private', 'public'] as const) {
                    const h = await history(kind);
                    expect(eventsOf(h, 'DISABLE').length, `${kind}: DISABLE events`).toBe(2);
                    expect(eventsOf(h, 'ENABLE').length, `${kind}: ENABLE events`).toBe(2);
                }
            });
        });

    test('API-KEY-17[ops]: disable → sign refused at once (cache evicted); enable → sign succeeds',
        meta({ id: 'API-KEY-17', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r16 (the key-item cache is evicted on enable / disable: a disabled key never signs from a stale cache), r14'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k17o-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            const priv = itemRef(c, 'private', key);
            const sig = signatureAttributesFor(await listSignAttributes(api, priv), signVariants('rsa-2048')[0]) ?? [];
            const data = crypto.randomBytes(64).toString('base64');
            expect((await signWithItem(api, priv, data, sig)).status()).toBe(200);
            await disableOwnKey(api, key);
            const refused = await signWithItem(api, priv, data, sig);
            expect(refused.status()).toBe(422);
            expect(expect422Messages(await refused.text()).join(' ')).toContain('Key needs to be Active and enabled.');
            await enableOwnKey(api, key);
            expect((await signWithItem(api, priv, data, sig)).status()).toBe(200);
        });

    test('API-KEY-18[state]: compromise ACTIVE → COMPROMISED with the history text; a second compromise → 422 aggregate text and a FAILED event',
        meta({ id: 'API-KEY-18', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r19 (compromise from PRE_ACTIVE / ACTIVE / DEACTIVATED; aggregate 422 CryptographicKeyServiceImpl:1470-1476; "Key compromised. Reason: <x>." CryptographicKeyWriter:626), r23; §2.1'] }),
        async ({ api }) => {
            test.setTimeout(120_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k18-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            await test.step('PATCH …/compromise {reason} → every item COMPROMISED; history COMPROMISED "Key compromised. Reason: …."', async () => {
                const res = await compromiseOwnKey(api, key, 'disclosure');
                expect(res.status(), await res.text()).toBeLessThan(300);
                const detail = await getKey(api, key.uuid);
                expect(itemStates(detail)).toEqual(['compromised', 'compromised']);
                for (const item of detail.items as Json[]) {
                    const h = await keyItemHistory(api, key.uuid, String(item.uuid));
                    const ev = eventsOf(h, 'COMPROMISED', 'SUCCESS');
                    expect(ev.length, 'COMPROMISED event').toBeGreaterThanOrEqual(1);
                    expect(String(ev[0].message)).toMatch(/^Key compromised\. Reason: .+\.$/);
                }
            });
            await test.step('A second compromise → 422 aggregate text and a FAILED event per item', async () => {
                const res = await compromiseOwnKey(api, key, 'disclosure');
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(422);
                expect(expect422Messages(text).join(' ')).toContain(COMPROMISE_AGGREGATE);
                const detail = await getKey(api, key.uuid);
                for (const item of detail.items as Json[]) {
                    expect(eventsOf(await keyItemHistory(api, key.uuid, String(item.uuid)), 'COMPROMISED', 'FAILED').length, 'FAILED compromise event').toBeGreaterThanOrEqual(1);
                }
            });
        });

    test('API-KEY-18[ops]: a COMPROMISED key refuses sign, verify, encrypt and decrypt with 422 "Key needs to be Active and enabled."',
        meta({ id: 'API-KEY-18', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r14 (operations need ACTIVE and enabled), r19'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k18o-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            await compromiseOwnKey(api, key);
            await expectAllOperationsRefused(api, c, key);
        });

    test('API-KEY-19[state]: destroy on ACTIVE → 422 aggregate text and the key unchanged; COMPROMISED → destroy → DESTROYED_COMPROMISED with "Key destroyed."; destroy again → 422',
        meta({ id: 'API-KEY-19', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r20 (destroy from PRE_ACTIVE / DEACTIVATED / COMPROMISED only; aggregate 422 CryptographicKeyServiceImpl:1673; DESTROY "Key destroyed." CryptographicKeyWriter:683; COMPROMISED → DESTROYED_COMPROMISED), §2.1'] }),
        async ({ api }) => {
            test.setTimeout(120_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k19-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            await test.step('destroy on ACTIVE → 422, the key unchanged', async () => {
                const res = await destroyOwnKey(api, key);
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(422);
                expect(expect422Messages(text).join(' ')).toContain(DESTROY_AGGREGATE);
                const detail = await getKey(api, key.uuid);
                expect(itemStates(detail)).toEqual(['active', 'active']);
                expect(detail.items.every((i: Json) => i.enabled === true)).toBe(true);
            });
            await test.step('compromise, then destroy → DESTROYED_COMPROMISED; history DESTROY "Key destroyed."', async () => {
                expect((await compromiseOwnKey(api, key)).status()).toBeLessThan(300);
                const res = await destroyOwnKey(api, key);
                expect(res.status(), await res.text()).toBeLessThan(300);
                const detail = await getKey(api, key.uuid);
                expect(itemStates(detail)).toEqual(['destroyedcompromised', 'destroyedcompromised']);
                for (const item of detail.items as Json[]) {
                    const ev = eventsOf(await keyItemHistory(api, key.uuid, String(item.uuid)), 'DESTROY', 'SUCCESS');
                    expect(ev.length).toBeGreaterThanOrEqual(1);
                    expect(String(ev[0].message)).toBe('Key destroyed.');
                    expect(item.keyData ?? null, 'key data cleared').toBeFalsy();
                }
            });
            await test.step('destroy again → 422 invalid-state text', async () => {
                const res = await destroyOwnKey(api, key);
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(422);
                expect(expect422Messages(text).join(' ')).toContain(DESTROY_AGGREGATE);
            });
        });

    test('API-KEY-19[ops]: a destroyed key refuses to sign with 422 "Key needs to be Active and enabled." and records a SIGN FAILED event',
        meta({ id: 'API-KEY-19', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r23 (the SIGN state refusal is recorded FAILED: requireActive runs inside the lambda, COS:324)'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k19o-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            await compromiseOwnKey(api, key);
            await destroyOwnKey(api, key);
            const priv = itemRef(c, 'private', key);
            const res = await signWithItem(api, priv, crypto.randomBytes(64).toString('base64'), []);
            expect(res.status()).toBe(422);
            expect(expect422Messages(await res.text()).join(' ')).toContain('Key needs to be Active and enabled.');
            expect(eventsOf(await keyItemHistory(api, key.uuid, priv.itemUuid), 'SIGN', 'FAILED').length).toBeGreaterThanOrEqual(1);
        });

    test('API-KEY-20[state]: enabling a DESTROYED_COMPROMISED key is refused (core#420 AC: enable / disable respect the key state model); the state stays terminal',
        meta({
            id: 'API-KEY-20', prio: 'P1', issue: 'ilm#431',
            rule: [
                'core#420 AC ("Changing key state should respect key state model … same is valid for enable/disable operation on whole key"): a DESTROYED_COMPROMISED item has no legal transition, so enable must be refused',
                'platform-keys-connectors A2 r18 (today: the conditional UPDATE has no state guard — a destroyed key is re-enabled; suspected product defect, not yet confirmed or filed; parked until then), §2.1',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            // Merge item 5 (author decision after the Sonnet re-check): core#420 is the AC ticket, not a filed bug, so the row is no
            // `test.fail`. It stays a full body behind a fixme while the suspected product defect is under confirmation against the
            // acceptance criteria; then it becomes a plain test (fixed) or `@bug` + `test.fail` (filed).
            test.fixme(true, 'suspected product defect (core#420 AC, not a filed bug): a DESTROYED_COMPROMISED key is re-enabled by PATCH /v1/keys/{uuid}/enable (no state guard, platform-keys-connectors A2 r18) - confirm against the acceptance criteria first');
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k20-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            expect((await compromiseOwnKey(api, key)).status()).toBeLessThan(300);
            expect((await destroyOwnKey(api, key)).status()).toBeLessThan(300);
            await disableOwnKey(api, key);
            // The AC is asserted (the body runs once the suspected defect is decided; see the fixme above).
            const res = await api.patch(`/api/v1/keys/${key.uuid}/enable`);
            testInfo.annotations.push({ type: 'suspected-defect', description: `enable on a destroyed key answered ${res.status()}` });
            expect(res.status(), 'enable of a destroyed key is refused').toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            const detail = await getKey(api, key.uuid);
            expect(itemStates(detail)).toEqual(['destroyedcompromised', 'destroyedcompromised']);
            expect(detail.items.every((i: Json) => i.enabled === false), 'the destroyed items stay disabled').toBe(true);
        });

    test('API-KEY-20[ops]: COMPROMISED and DESTROYED_COMPROMISED keys refuse sign, verify, encrypt and decrypt each with 422 "Key needs to be Active and enabled."; re-enabled after destroy they still cannot sign',
        meta({ id: 'API-KEY-20', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r14, r18, r22; §2.1 (state × operation decision table)'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(180_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k20o-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', enabled: true });
            made.push(key);
            await compromiseOwnKey(api, key);
            await expectAllOperationsRefused(api, c, key);
            await destroyOwnKey(api, key);
            await expectAllOperationsRefused(api, c, key);
            await enableOwnKey(api, key);
            // r22: the per-item usage update has no state check either (observation); the key still cannot operate.
            const usage = await updateOwnKeyItemUsages(api, itemRef(c, 'private', key).itemUuid, ['sign', 'decrypt']);
            testInfo.annotations.push({ type: 'observation', description: `usage update on a destroyed item answered ${usage.status()}` });
            expect(usage.status()).toBeLessThan(500);
            await expectAllOperationsRefused(api, c, key);
        });
});

/** Every operation on both items answers 422 "Key needs to be Active and enabled." (§3.1 row 4). */
async function expectAllOperationsRefused(api: Parameters<typeof signWithItem>[0], c: KeyChain, key: Parameters<typeof itemRef>[2]): Promise<void> {
    const priv = itemRef(c, 'private', key!);
    const pub = itemRef(c, 'public', key!);
    const data = crypto.randomBytes(32).toString('base64');
    const calls = [
        ['sign', () => signWithItem(api, priv, data, [])],
        ['verify', () => verifyWithItem(api, pub, data, data, [])],
        ['encrypt', () => cipherWithItem(api, pub, 'encrypt', data, [])],
        ['decrypt', () => cipherWithItem(api, priv, 'decrypt', data, [])],
    ] as const;
    for (const [op, call] of calls) {
        const res = await call();
        expect(res.status(), `${op} refused`).toBe(422);
        expect(expect422Messages(await res.text()).join(' '), `${op} text`).toContain('Key needs to be Active and enabled.');
    }
}
