/**
 * API-KEY-12, 13, 14, 16 — Item operations on own keys. ilm#431.
 *
 * WHAT: 1. The operation gate: a new (disabled) key refuses to sign ("Key needs to be Active and enabled."); once enabled, sign, verify,
 *          encrypt and decrypt succeed; an item without the matching usage is refused ("Key item '<id>' does not have required usage
 *          '<USAGE>'"); a wrong item, unrelated ids and empty data are refused ("Cannot sign empty data", "Cannot verify empty data");
 *          disabling refuses again at once.
 *       2. Every sign and verify variant of each signing family (RSA, ECDSA, ML-DSA, Falcon, SLH-DSA) signs and verifies within 5 s; the
 *          sign list has no MD5 or SHA-1.
 *       3. Tampered data and a signature of another key verify as false (both 200); an ML-DSA-44 key with an ML-DSA-65 algorithm → 422,
 *          never 500; unrelated ids → 422 "Token, token profile, key and key item in the request are not associated."; only FALCON-1024 is
 *          offered.
 *       4. RSA encrypt and decrypt round trip with each offered scheme; null data → 422 "Cannot encrypt|decrypt null data"; a plaintext
 *          over the RSA limit → 4xx; encrypting with a non-RSA key (ECDSA, ML-DSA, Falcon, ML-KEM) is refused with a 4xx.
 * WHY: operations need an active, enabled key and the matching usage per item (private: sign and decrypt, public: verify and encrypt); the
 *      key-item cache is evicted on enable, disable and usage changes, so a disabled key never signs from a stale cache. v2
 *      signatureAlgorithm is scheme plus
 *      digest for RSA and ECDSA and the family option for post-quantum keys. A refusal is a 4xx and never a 5xx.
 * HOW: every item belongs to an own key on the run token chain, recorded in the ledger with its items (skip with the named reason when the
 *      chain cannot be made); keys made in a test are deleted at its end (own hard delete; software-cryptography-provider#137: key limit
 *      per token).
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import { encryptedFamilies, FAMILIES, Family, namesForbiddenDigest, signedFamilies, signVariants, SIGN_DATA_BYTES } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { expect422Messages } from '../../../utils/regression/errorContract';
import { cipherOutputOf, cipherWithItem, itemRef, listEncryptAttributes, listSignAttributes, operationUrl, signatureAttributesFor, signatureOf, signWithItem, verificationOf, verifyWithItem } from '../../../utils/regression/platform/keyOperations';
import { disableOwnKey, enableOwnKey, updateOwnKeyItemUsages } from '../../../utils/regression/platform/keys';
import { requestAttributesFrom } from '../../../utils/regression/customAttributes';
import { send } from '../../../utils/regression/inventory/searchApi';
import { testMeta, tags } from '../../../utils/regression/tags';
import { API_MATRIX_TEST_MS, API_VARIANTS_TEST_MS } from '../../../utils/regression/timeouts';

const randomData = (bytes = SIGN_DATA_BYTES): string => crypto.randomBytes(bytes).toString('base64');
const tampered = (b64: string): string => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] = buf[0] ^ 0xff;
    return buf.toString('base64');
};

test.describe('Key operations', { tag: tags.api }, () => {
    test('an operation needs an enabled key with the matching usage',
        testMeta({
            id: 'API-KEY-12', prio: 'P1', issue: 'ilm#431',
            rule: [
                'new keys are disabled; operations need ACTIVE and enabled and the usage: "Key needs to be Active and enabled.", "Key item \'<id>\' does not have required usage \'SIGN\'. Current usages: […]."; the cache is evicted on enable / disable / usages',
            ],
        }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_MATRIX_TEST_MS);
            const c = await ownKeys.chain();
            const key = await ownKeys.make('k12', { chain: c, family: 'rsa-2048' });
            const priv = itemRef(c, 'private', key);
            const pub = itemRef(c, 'public', key);
            const data = randomData();
            const rsa = signVariants('rsa-2048')[0];
            const sig = signatureAttributesFor(await listSignAttributes(api, priv), rsa) ?? [];

            await test.step('a new (disabled) key → 422 "Key needs to be Active and enabled."', async () => {
                const res = await signWithItem(api, priv, data, sig);
                expect(res.status()).toBe(422);
                expect(expect422Messages(await res.text()).join(' ')).toContain('Key needs to be Active and enabled.');
            });
            const signature = await test.step('enable → sign and verify succeed', async () => {
                await enableOwnKey(api, key);
                const s = await signWithItem(api, priv, data, sig);
                expect(s.status(), await s.text()).toBe(200);
                const value = signatureOf(await s.json());
                expect(value).toBeTruthy();
                const v = await verifyWithItem(api, pub, data, value!, sig);
                expect(v.status()).toBe(200);
                expect(verificationOf(await v.json())).toBe(true);
                const e = await cipherWithItem(api, pub, 'encrypt', data, requestAttributesFrom(await listEncryptAttributes(api, pub)));
                expect(e.status(), await e.text()).toBe(200);
                const d = await cipherWithItem(api, priv, 'decrypt', cipherOutputOf(await e.json())!, []);
                expect(d.status(), await d.text()).toBe(200);
                return value!;
            });
            await test.step('without the usage → "does not have required usage" (per-item usage sets: private sign / decrypt, public verify / encrypt)', async () => {
                // Private item keeps only decrypt, public only encrypt: sign / verify lose their usage (per-item PUT).
                expect((await updateOwnKeyItemUsages(api, priv.itemUuid, ['decrypt'])).status()).toBeLessThan(300);
                expect((await updateOwnKeyItemUsages(api, pub.itemUuid, ['encrypt'])).status()).toBeLessThan(300);
                for (const [item, op, usage] of [[priv, 'sign', 'SIGN'], [pub, 'verify', 'VERIFY']] as const) {
                    const res = op === 'sign' ? await signWithItem(api, item, data, sig) : await verifyWithItem(api, item, data, signature, sig);
                    expect(res.status(), `${op} without ${usage}`).toBe(422);
                    expect(expect422Messages(await res.text()).join(' '), `${op} without ${usage}: the text names the missing usage`).toMatch(new RegExp(`does not have required usage '${usage}'`));
                }
                expect((await updateOwnKeyItemUsages(api, priv.itemUuid, ['sign'])).status()).toBeLessThan(300);
                expect((await updateOwnKeyItemUsages(api, pub.itemUuid, ['verify'])).status()).toBeLessThan(300);
                for (const [item, op, usage] of [[pub, 'encrypt', 'ENCRYPT'], [priv, 'decrypt', 'DECRYPT']] as const) {
                    const res = await cipherWithItem(api, item, op, data, []);
                    expect(res.status(), `${op} without ${usage}`).toBe(422);
                    expect(expect422Messages(await res.text()).join(' '), `${op} without ${usage}: the text names the missing usage`).toMatch(new RegExp(`does not have required usage '${usage}'`));
                }
                expect((await updateOwnKeyItemUsages(api, priv.itemUuid, ['sign', 'decrypt'])).status()).toBeLessThan(300);
                expect((await updateOwnKeyItemUsages(api, pub.itemUuid, ['verify', 'encrypt'])).status()).toBeLessThan(300);
            });
            await test.step('wrong item, unrelated ids, empty data', async () => {
                const wrong = await signWithItem(api, pub, data, sig);
                expect(wrong.status(), 'sign with the PUBLIC item is refused').toBeGreaterThanOrEqual(400);
                expect(wrong.status()).toBeLessThan(500);
                const mixed = await signWithItem(api, { ...priv, itemUuid: pub.itemUuid, keyUuid: api.probeUuid() }, data, sig);
                expect(mixed.status()).toBeLessThan(500);
                // Core checks the FIELD, not its content (`request.getData() == null`): the body goes without it.
                const empty = await send(api, 'POST', operationUrl(priv, 'sign'), { data: { signatureAttributes: sig } });
                expect(empty.status, empty.text.slice(0, 300)).toBe(422);
                expect(expect422Messages(empty.text).join(' ')).toContain('Cannot sign empty data');
                const emptyVerify = await send(api, 'POST', operationUrl(pub, 'verify'), { data: { signatureAttributes: sig, data: [{ data }] } });
                expect(emptyVerify.status, emptyVerify.text.slice(0, 300)).toBe(422);
                expect(expect422Messages(emptyVerify.text).join(' ')).toContain('Cannot verify empty data');
            });
            await test.step('disable again → refused at once (cache evicted)', async () => {
                await disableOwnKey(api, key);
                const res = await signWithItem(api, priv, data, sig);
                expect(res.status()).toBe(422);
            });
        });

    for (const family of signedFamilies('scp-v2')) {
        test(`each ${FAMILIES[family].label} signature variant signs and verifies`,
            testMeta({ id: 'API-KEY-13', row: family, prio: 'P1', issue: 'ilm#431', phaseB: true, rule: ['private key signs, public key verifies; v2 signatureAlgorithm: scheme + digest for RSA / ECDSA, the family option for ML-DSA / FALCON / SLH-DSA; no MD5 / SHA-1'] }),
            async ({ api, ownKeys }, testInfo) => {
                test.setTimeout(API_MATRIX_TEST_MS);
                const c = await ownKeys.chain();
                const key = await ownKeys.make(`k13-${family}`, { chain: c, family, enabled: true });
                const priv = itemRef(c, 'private', key);
                const pub = itemRef(c, 'public', key);
                const defs = await listSignAttributes(api, priv);
                expect(namesForbiddenDigest((defs[0]?.content ?? []) as any[]), 'no MD5 / SHA-1 in a v2 sign list').toEqual([]);
                const data = randomData();
                for (const variant of signVariants(family)) {
                    await test.step(variant.label, async () => {
                        const sig = signatureAttributesFor(defs, variant);
                        if (!sig) {
                            testInfo.annotations.push({ type: 'not-offered', description: `${variant.label}: no signatureAlgorithm option on this key` });
                            return;
                        }
                        const started = Date.now();
                        const s = await signWithItem(api, priv, data, sig);
                        expect(s.status(), await s.text()).toBe(200);
                        const value = signatureOf(await s.json())!;
                        const v = await verifyWithItem(api, pub, data, value, sig);
                        expect(v.status(), await v.text()).toBe(200);
                        expect(verificationOf(await v.json()), `${variant.label} verifies`).toBe(true);
                        expect(Date.now() - started, `${variant.label} round trip within 5 s`).toBeLessThan(5_000);
                    });
                }
            });
    }

    test('wrong data, signatures, levels and items fail verification or are refused, never 5xx',
        testMeta({ id: 'API-KEY-14', prio: 'P1', issue: 'ilm#431', rule: ['error texts; item roles; ("Signature algorithm {} does not fit the signing key ({})." / unsupported combination, connector 422 PARAMETER_UNSUPPORTED; FALCON-512 has no platform algorithm)'] }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_MATRIX_TEST_MS);
            const c = await ownKeys.chain();
            const a = await ownKeys.make('k14a', { chain: c, family: 'ec-p256', enabled: true });
            const b = await ownKeys.make('k14b', { chain: c, family: 'ec-p256', enabled: true });
            const data = randomData();
            const variant = signVariants('ec-p256')[0];
            const sig = signatureAttributesFor(await listSignAttributes(api, itemRef(c, 'private', a)), variant)!;
            const sA = await signWithItem(api, itemRef(c, 'private', a), data, sig);
            const signatureA = signatureOf(await sA.json())!;
            await test.step('Tampered data → false; a signature of another key → false (both 200)', async () => {
                const t = await verifyWithItem(api, itemRef(c, 'public', a), tampered(data), signatureA, sig);
                expect(t.status()).toBe(200);
                expect(verificationOf(await t.json())).toBe(false);
                const f = await verifyWithItem(api, itemRef(c, 'public', b), data, signatureA, sig);
                expect(f.status()).toBe(200);
                expect(verificationOf(await f.json())).toBe(false);
            });
            await test.step('ML-DSA-44 key with an ML-DSA-65 algorithm → 422 (not 500)', async () => {
                const m = await ownKeys.make('k14m', { chain: c, family: 'ml-dsa-44', enabled: true });
                const wrong = signatureAttributesFor(await listSignAttributes(api, itemRef(c, 'private', m)), { family: 'ml-dsa-65', label: 'ML-DSA-65' })
                    ?? [{ name: 'signatureAlgorithm', version: 'v2', contentType: 'string', content: [{ reference: 'ML-DSA-65', data: 'ML-DSA-65' }] }];
                const res = await signWithItem(api, itemRef(c, 'private', m), data, wrong);
                expect(res.status()).toBe(422);
                expect(await res.text()).toMatch(/does not fit the signing key|not supported|unavailable/i);
            });
            await test.step('Unrelated ids → 422 "Token, token profile, key and key item in the request are not associated."', async () => {
                const res = await signWithItem(api, { ...itemRef(c, 'private', a), keyUuid: b.uuid }, data, sig);
                expect(res.status()).toBe(422);
                expect(expect422Messages(await res.text()).join(' ')).toContain('Token, token profile, key and key item in the request are not associated.');
            });
            await test.step('FALCON: the only platform algorithm is FALCON-1024 (a FALCON-512 key is not offered on v2; a FALCON-1024 key signs)', async () => {
                const f = await ownKeys.make('k14f', { chain: c, family: 'falcon-1024', enabled: true });
                const defs = await listSignAttributes(api, itemRef(c, 'private', f));
                const options = (defs[0]?.content ?? []).map((o: any) => String(o.reference ?? o.data));
                expect(options.some((o) => /FALCON-?1024/i.test(o)), 'FALCON-1024 offered').toBe(true);
                expect(options.some((o) => /FALCON-?512/i.test(o)), 'FALCON-512 never offered').toBe(false);
            });
        });

    for (const family of encryptedFamilies('scp-v2')) {
        test(`${FAMILIES[family].label} encrypt and decrypt round trip, and invalid data is refused`,
            testMeta({ id: 'API-KEY-16', row: family, prio: 'P1', issue: 'ilm#431', rule: ['"Cannot encrypt null data" / "Cannot decrypt null data"; the public key encrypts, the private key decrypts'] }),
            async ({ api, ownKeys }, testInfo) => {
                test.setTimeout(API_VARIANTS_TEST_MS);
                const c = await ownKeys.chain();
                const key = await ownKeys.make(`k16-${family}`, { chain: c, family, enabled: true });
                const pub = itemRef(c, 'public', key);
                const priv = itemRef(c, 'private', key);
                const defs = await listEncryptAttributes(api, pub);
                const plain = randomData(32);
                const schemes = (defs[0]?.content ?? []).filter((o: any) => /PKCS1|OAEP/i.test(String(o.reference ?? o.data)));
                for (const scheme of schemes.length ? schemes : [undefined]) {
                    await test.step(`round trip ${scheme ? String((scheme as any).reference ?? (scheme as any).data) : 'default'}`, async () => {
                        const attrs = scheme ? [{ name: defs[0].name, uuid: defs[0].uuid, version: 'v2', contentType: defs[0].contentType ?? 'string', content: [scheme] }] : [];
                        const e = await cipherWithItem(api, pub, 'encrypt', plain, attrs);
                        expect(e.status(), await e.text()).toBe(200);
                        const d = await cipherWithItem(api, priv, 'decrypt', cipherOutputOf(await e.json())!, attrs);
                        expect(d.status(), await d.text()).toBe(200);
                        expect(cipherOutputOf(await d.json()), 'the decrypted data equals the plain data').toBe(plain);
                    });
                }
                await test.step('null data → 422; plaintext over the RSA limit → 4xx', async () => {
                    // The FIELD `cipherData` missing (`getCipherData() == null`), not a null element.
                    const n = await send(api, 'POST', operationUrl(pub, 'encrypt'), { data: { cipherAttributes: [] } });
                    expect(n.status, n.text.slice(0, 300)).toBe(422);
                    expect(expect422Messages(n.text).join(' ')).toContain('Cannot encrypt null data');
                    const nd = await send(api, 'POST', operationUrl(priv, 'decrypt'), { data: { cipherAttributes: [] } });
                    expect(nd.status, nd.text.slice(0, 300)).toBe(422);
                    expect(expect422Messages(nd.text).join(' ')).toContain('Cannot decrypt null data');
                    const big = await cipherWithItem(api, pub, 'encrypt', randomData(1024), []);
                    expect(big.status()).toBeGreaterThanOrEqual(400);
                    expect(big.status()).toBeLessThan(500);
                });
            });
    }

    test('encrypting with a key that is not RSA is refused with a 4xx',
        testMeta({ id: 'API-KEY-16', row: 'non-rsa', prio: 'P1', issue: 'ilm#431', rule: ['the key algorithm cases: encrypt / decrypt on non-RSA rejected; the forbidden-usage map covers ECDSA only: the provider refuses at operation time)'] }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_MATRIX_TEST_MS);
            const c = await ownKeys.chain();
            for (const family of ['ec-p256', 'ml-dsa-65', 'falcon-1024', 'ml-kem-768'] as Family[]) {
                await test.step(FAMILIES[family].label, async () => {
                    const key = await ownKeys.make(`k16n-${family}`, { chain: c, family, enabled: true });
                    const res = await cipherWithItem(api, itemRef(c, 'public', key), 'encrypt', randomData(16), []);
                    expect(res.status(), `${family}: refused`).toBeGreaterThanOrEqual(400);
                    expect(res.status(), `${family}: never 5xx`).toBeLessThan(500);
                });
            }
        });
});
