/**
 * API-KEY-17, 18, 19, 20 — enable / disable, compromise and destroy of an own key, and the operations each state refuses (ilm#431).
 * The rows that destroy a key run on a local stack only (DESTROYED_KEY_STAYS, core#2455).
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import { signVariants } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { expect422Messages } from '../../../utils/regression/errorContract';
import { cipherWithItem, itemRef, listSignAttributes, signatureAttributesFor, signWithItem, verifyWithItem } from '../../../utils/regression/platform/keyOperations';
import { compromiseOwnKey, DESTROYED_KEY_STAYS, destroyOwnKey, disableOwnKey, enableOwnKey, eventsOf, getKey, itemOf, KeyChain, KeyDetail, keyItemHistory, updateOwnKeyItemUsages } from '../../../utils/regression/platform/keys';
import { testMeta, tags } from '../../../utils/regression/tags';
import { isLocalTier } from '../../../utils/regression/tier/kind';
import type { JsonObject } from '../../../utils/regression/json';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { KeyRef } from '../../../utils/regression/ledger/ledger';
import { API_STANDARD_TEST_MS, API_VARIANTS_TEST_MS } from '../../../utils/regression/timeouts';

const COMPROMISE_AGGREGATE = 'Some key items could not be marked as compromised. Compromise is allowed only in states Pre-active, Active, or Deactivated.';
const DESTROY_AGGREGATE = 'Key items could not be destroyed because their current states do not allow destruction. Destruction is allowed only in states Pre-active, Deactivated, or Compromised.';

/** What core answers as `keyData` for an item whose material it does not hold (destroyed, or kept by the provider). */
const PROVIDER_MANAGED_KEY_DATA = 'Key material is managed by the cryptography provider and is not available in Core.';

const itemStates = (detail: KeyDetail): string[] => (detail.items ?? []).map((i) => String(i.state).toLowerCase());

test.describe('Key lifecycle', { tag: tags.api }, () => {
    test('disable and enable are idempotent and record one event per change',
        testMeta({ id: 'API-KEY-17', row: 'state', prio: 'P1', issue: 'ilm#431', rule: ['enable / disable: boolean, idempotent conditional UPDATE, event only on change (CryptographicKeyWriter); ENABLE / DISABLE events'] }),
        async ({ api, ownKeys }) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k17', { chain: c, family: 'rsa-2048', enabled: true });
            const history = async (kind: 'private' | 'public') => keyItemHistory(api, key.uuid, String(itemOf(await getKey(api, key.uuid), kind)!.uuid));

            await test.step('disable → items disabled at once', async () => {
                await disableOwnKey(api, key);
                expect((await getKey(api, key.uuid)).items!.every((i) => i.enabled === false)).toBe(true);
            });
            await test.step('enable → items enabled; a second enable and a second disable / enable pair answer 2xx and add no event', async () => {
                await enableOwnKey(api, key);
                expect((await getKey(api, key.uuid)).items!.every((i) => i.enabled === true)).toBe(true);
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

    test('a disabled key refuses to sign at once, and enabled again it signs',
        testMeta({ id: 'API-KEY-17', row: 'ops', prio: 'P1', issue: 'ilm#431', rule: ['the key-item cache is evicted on enable / disable: a disabled key never signs from a stale cache'] }),
        async ({ api, ownKeys }) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k17o', { chain: c, family: 'rsa-2048', enabled: true });
            const priv = itemRef(c, 'private', key);
            const sig = signatureAttributesFor(await listSignAttributes(api, priv), signVariants('rsa-2048')[0]);
            expect(sig, 'the RSA PKCS#1 SHA-256 sign selection is offered').toBeDefined();
            const data = crypto.randomBytes(64).toString('base64');
            expect((await signWithItem(api, priv, data, sig!)).status()).toBe(200);
            await disableOwnKey(api, key);
            const refused = await signWithItem(api, priv, data, sig!);
            expect(refused.status()).toBe(422);
            expect(expect422Messages(await refused.text()).join(' ')).toContain('Key needs to be Active and enabled.');
            await enableOwnKey(api, key);
            expect((await signWithItem(api, priv, data, sig!)).status()).toBe(200);
        });

    test('an active key can be compromised once, and a second compromise is refused',
        testMeta({ id: 'API-KEY-18', row: 'state', prio: 'P1', issue: 'ilm#431', rule: ['compromise from PRE_ACTIVE / ACTIVE / DEACTIVATED; aggregate 422 CryptographicKeyServiceImpl; "Key compromised. Reason: <x>." CryptographicKeyWriter'] }),
        async ({ api, ownKeys }) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k18', { chain: c, family: 'rsa-2048', enabled: true });
            await test.step('PATCH …/compromise {reason} → every item COMPROMISED; history COMPROMISED "Key compromised. Reason: …."', async () => {
                const res = await compromiseOwnKey(api, key, 'disclosure');
                expect(res.status(), await res.text()).toBeLessThan(300);
                const detail = await getKey(api, key.uuid);
                expect(itemStates(detail)).toEqual(['compromised', 'compromised']);
                for (const item of detail.items as JsonObject[]) {
                    const h = await keyItemHistory(api, key.uuid, String(item.uuid));
                    const ev = eventsOf(h, 'COMPROMISED', 'SUCCESS');
                    expect(ev.length, 'COMPROMISED event').toBeGreaterThanOrEqual(1);
                    expect(String(ev[0].message), 'compromise history message').toMatch(/^Key compromised\. Reason: .+\.$/);
                }
            });
            await test.step('A second compromise → 422 aggregate text and a FAILED event per item', async () => {
                const res = await compromiseOwnKey(api, key, 'disclosure');
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(422);
                expect(expect422Messages(text).join(' ')).toContain(COMPROMISE_AGGREGATE);
                const detail = await getKey(api, key.uuid);
                for (const item of detail.items as JsonObject[]) {
                    expect(eventsOf(await keyItemHistory(api, key.uuid, String(item.uuid)), 'COMPROMISED', 'FAILED').length, 'FAILED compromise event').toBeGreaterThanOrEqual(1);
                }
            });
        });

    test('a compromised key refuses sign, verify, encrypt and decrypt',
        testMeta({ id: 'API-KEY-18', row: 'ops', prio: 'P1', issue: 'ilm#431', rule: ['key operations need an ACTIVE and enabled key'] }),
        async ({ api, ownKeys }) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k18o', { chain: c, family: 'rsa-2048', enabled: true });
            await compromiseOwnKey(api, key);
            await expectAllOperationsRefused(api, c, key);
        });

    test('only a compromised key can be destroyed, and only once',
        testMeta({
            id: 'API-KEY-19', row: 'state', prio: 'P1', issue: 'ilm#431',
            rule: [
                'destroy from PRE_ACTIVE / DEACTIVATED / COMPROMISED only; aggregate 422 CryptographicKeyServiceImpl; DESTROY "Key destroyed." CryptographicKeyWriter; COMPROMISED → DESTROYED_COMPROMISED',
                'core CryptographicKeyDtoMapper: an item without key data answers the PROVIDER_MANAGED_KEY_DATA text, never material',
            ],
        }),
        async ({ api, ownKeys }) => {
            test.skip(!isLocalTier(), DESTROYED_KEY_STAYS);
            test.setTimeout(API_STANDARD_TEST_MS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k19', { chain: c, family: 'rsa-2048', enabled: true });
            await test.step('destroy on ACTIVE → 422, the key unchanged', async () => {
                const res = await destroyOwnKey(api, key);
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(422);
                expect(expect422Messages(text).join(' ')).toContain(DESTROY_AGGREGATE);
                const detail = await getKey(api, key.uuid);
                expect(itemStates(detail)).toEqual(['active', 'active']);
                expect(detail.items!.every((i) => i.enabled === true)).toBe(true);
            });
            await test.step('compromise, then destroy → DESTROYED_COMPROMISED; history DESTROY "Key destroyed."', async () => {
                expect((await compromiseOwnKey(api, key)).status()).toBeLessThan(300);
                const res = await destroyOwnKey(api, key);
                expect(res.status(), await res.text()).toBeLessThan(300);
                const detail = await getKey(api, key.uuid);
                expect(itemStates(detail)).toEqual(['destroyedcompromised', 'destroyedcompromised']);
                for (const item of detail.items as JsonObject[]) {
                    const ev = eventsOf(await keyItemHistory(api, key.uuid, String(item.uuid)), 'DESTROY', 'SUCCESS');
                    expect(ev.length, 'a DESTROY event per item').toBeGreaterThanOrEqual(1);
                    expect(String(ev[0].message), 'destroy history message').toBe('Key destroyed.');
                    expect([null, '', PROVIDER_MANAGED_KEY_DATA], 'key data cleared').toContain(item.keyData ?? null);
                }
            });
            await test.step('destroy again → 422 invalid-state text', async () => {
                const res = await destroyOwnKey(api, key);
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(422);
                expect(expect422Messages(text).join(' ')).toContain(DESTROY_AGGREGATE);
            });
        });

    test('a destroyed key refuses to sign and records a failed sign event',
        testMeta({ id: 'API-KEY-19', row: 'ops', prio: 'P1', issue: 'ilm#431', rule: ['the SIGN state refusal is recorded FAILED: requireActive runs inside the recorded lambda of the operation service'] }),
        async ({ api, ownKeys }) => {
            test.skip(!isLocalTier(), DESTROYED_KEY_STAYS);
            test.setTimeout(API_STANDARD_TEST_MS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k19o', { chain: c, family: 'rsa-2048', enabled: true });
            await compromiseOwnKey(api, key);
            await destroyOwnKey(api, key);
            const priv = itemRef(c, 'private', key);
            const res = await signWithItem(api, priv, crypto.randomBytes(64).toString('base64'), []);
            expect(res.status()).toBe(422);
            expect(expect422Messages(await res.text()).join(' ')).toContain('Key needs to be Active and enabled.');
            expect(eventsOf(await keyItemHistory(api, key.uuid, priv.itemUuid), 'SIGN', 'FAILED').length).toBeGreaterThanOrEqual(1);
        });

    test('enabling a destroyed key is refused and its state stays terminal',
        testMeta({
            id: 'API-KEY-20', row: 'state', prio: 'P1', issue: 'ilm#431',
            rule: [
                'core#420 AC ("Changing key state should respect key state model … same is valid for enable/disable operation on whole key"): a DESTROYED_COMPROMISED item has no legal transition, so enable must be refused',
                'today the conditional UPDATE has no state guard — a destroyed key is re-enabled; suspected product defect, not yet confirmed or filed',
            ],
        }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            test.skip(!isLocalTier(), DESTROYED_KEY_STAYS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k20', { chain: c, family: 'rsa-2048', enabled: true });
            expect((await compromiseOwnKey(api, key)).status()).toBeLessThan(300);
            expect((await destroyOwnKey(api, key)).status()).toBeLessThan(300);
            await disableOwnKey(api, key);
            test.fail(true, 'PATCH /v1/keys/{uuid}/enable re-enables a DESTROYED_COMPROMISED key (no state guard; core#420 acceptance criteria)');
            const res = await api.patch(`/api/v1/keys/${key.uuid}/enable`);
            testInfo.annotations.push({ type: 'suspected-defect', description: `enable on a destroyed key answered ${res.status()}` });
            expect(res.status(), 'enable of a destroyed key is refused').toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            const detail = await getKey(api, key.uuid);
            expect(itemStates(detail)).toEqual(['destroyedcompromised', 'destroyedcompromised']);
            expect(detail.items!.every((i) => i.enabled === false), 'the destroyed items stay disabled').toBe(true);
        });

    test('compromised and destroyed keys refuse every operation, even after enable',
        testMeta({ id: 'API-KEY-20', row: 'ops', prio: 'P1', issue: 'ilm#431', rule: ['state × operation decision table of the key lifecycle'] }),
        async ({ api, ownKeys }, testInfo) => {
            test.skip(!isLocalTier(), DESTROYED_KEY_STAYS);
            test.setTimeout(API_VARIANTS_TEST_MS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k20o', { chain: c, family: 'rsa-2048', enabled: true });
            await compromiseOwnKey(api, key);
            await expectAllOperationsRefused(api, c, key);
            await destroyOwnKey(api, key);
            await expectAllOperationsRefused(api, c, key);
            await enableOwnKey(api, key);
            // The per-item usage update has no state check either (observation); the key still cannot operate.
            const usage = await updateOwnKeyItemUsages(api, itemRef(c, 'private', key).itemUuid, ['sign', 'decrypt']);
            testInfo.annotations.push({ type: 'observation', description: `usage update on a destroyed item answered ${usage.status()}` });
            expect(usage.status()).toBeLessThan(500);
            await expectAllOperationsRefused(api, c, key);
        });
});

/** Every operation on both items answers 422 "Key needs to be Active and enabled." (a destroyed or compromised key). */
async function expectAllOperationsRefused(api: GuardedApi, c: KeyChain, key: KeyRef): Promise<void> {
    const priv = itemRef(c, 'private', key);
    const pub = itemRef(c, 'public', key);
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
