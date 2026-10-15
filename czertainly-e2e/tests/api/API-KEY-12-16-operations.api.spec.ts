/**
 * API-KEY-12 / 13 / 14 / 16 — item-level cryptographic operations on own keys: the operation gate (§3.1), the sign /
 * verify full factorial (§3 "S" cells), the sign / verify negatives and the RSA encrypt / decrypt round trip (ilm#431,
 * T7; platform area).
 *
 * Own objects only: every item belongs to an own key; `createOwnKey` records the key (`keys`) and each item (`keyItems`,
 * parent `key`), so the guard sends the item routes (guard-integration pass, platform G-1). Keys made in a test are
 * deleted at its end (SCP#137 cap per token).
 */
import * as crypto from 'crypto';
import { expect, test } from '../../fixtures/testFixtures';
import { encryptedFamilies, FAMILIES, Family, namesForbiddenDigest, signedFamilies, signVariants, SIGN_DATA_BYTES } from '../../utils/regression/cryptoMatrix';
import { expect422Messages } from '../../utils/regression/errorContract';
import {
    cipherOutputOf, cipherWithItem, createOwnKey, deleteOwnKey, disableOwnKey, enableOwnKey, ensureKeyChain, isSkip, itemRef, KeyChain, listEncryptAttributes, listSignAttributes,
    operationUrl, signatureAttributesFor, signatureOf, signWithItem, updateOwnKeyItemUsages, verificationOf, verifyWithItem,
} from '../../utils/regression/keyApi';
import { requestAttributesFrom } from '../../utils/regression/platformApi';
import { OwnRef, regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-KEY-12-16';

const randomData = (bytes = SIGN_DATA_BYTES): string => crypto.randomBytes(bytes).toString('base64');
const tampered = (b64: string): string => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] = buf[0] ^ 0xff;
    return buf.toString('base64');
};

/** Keys made inside a test, deleted at its end (own hard delete; SCP#137 cap per token, Sonnet F6). */
const made: OwnRef[] = [];

test.describe('API-KEY operations', { tag: tags.api }, () => {
    test.afterEach(async ({ api }) => {
        for (const key of made.splice(0)) await deleteOwnKey(api, key, SPEC);
    });

    test('API-KEY-12: the operation gate: a new key refuses to sign (not enabled), enable → signs, a removed SIGN usage → the usage refusal; the same for verify, encrypt, decrypt (§3.1 rows 1–7)',
        meta({
            id: 'API-KEY-12', prio: 'P1', issue: 'ilm#431',
            rule: [
                'platform-keys-connectors A2 r12 (new keys disabled), r14 (operations need ACTIVE and enabled and the usage: "Key needs to be Active and enabled.", "Key item \'<id>\' does not have required usage \'SIGN\'. Current usages: […]."), r16 (cache evicted on enable / disable / usages)',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(240_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const key = await createOwnKey(api, c, `k12-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048' });
            made.push(key);
            const priv = itemRef(c, 'private', key);
            const pub = itemRef(c, 'public', key);
            const data = randomData();
            const rsa = signVariants('rsa-2048')[0];
            const sig = signatureAttributesFor(await listSignAttributes(api, priv), rsa) ?? [];

            await test.step('Row 3: a new (disabled) key → 422 "Key needs to be Active and enabled."', async () => {
                const res = await signWithItem(api, priv, data, sig);
                expect(res.status()).toBe(422);
                expect(expect422Messages(await res.text()).join(' ')).toContain('Key needs to be Active and enabled.');
            });
            const signature = await test.step('Row 1: enable → sign and verify succeed', async () => {
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
            await test.step('Row 2: without the usage → "does not have required usage" (per-item usage sets: private sign / decrypt, public verify / encrypt)', async () => {
                // Private item keeps only decrypt, public only encrypt: sign / verify lose their usage (per-item PUT, CryptographyUtil rule).
                expect((await updateOwnKeyItemUsages(api, priv.itemUuid, ['decrypt'])).status()).toBeLessThan(300);
                expect((await updateOwnKeyItemUsages(api, pub.itemUuid, ['encrypt'])).status()).toBeLessThan(300);
                for (const [item, op, usage] of [[priv, 'sign', 'SIGN'], [pub, 'verify', 'VERIFY']] as const) {
                    const res = op === 'sign' ? await signWithItem(api, item, data, sig) : await verifyWithItem(api, item, data, signature, sig);
                    expect(res.status(), `${op} without ${usage}`).toBe(422);
                    expect(expect422Messages(await res.text()).join(' ')).toMatch(new RegExp(`does not have required usage '${usage}'`));
                }
                expect((await updateOwnKeyItemUsages(api, priv.itemUuid, ['sign'])).status()).toBeLessThan(300);
                expect((await updateOwnKeyItemUsages(api, pub.itemUuid, ['verify'])).status()).toBeLessThan(300);
                for (const [item, op, usage] of [[pub, 'encrypt', 'ENCRYPT'], [priv, 'decrypt', 'DECRYPT']] as const) {
                    const res = await cipherWithItem(api, item, op, data, []);
                    expect(res.status(), `${op} without ${usage}`).toBe(422);
                    expect(expect422Messages(await res.text()).join(' ')).toMatch(new RegExp(`does not have required usage '${usage}'`));
                }
                expect((await updateOwnKeyItemUsages(api, priv.itemUuid, ['sign', 'decrypt'])).status()).toBeLessThan(300);
                expect((await updateOwnKeyItemUsages(api, pub.itemUuid, ['verify', 'encrypt'])).status()).toBeLessThan(300);
            });
            await test.step('Rows 5–7: wrong item, unrelated ids, empty data', async () => {
                const wrong = await signWithItem(api, pub, data, sig);
                expect(wrong.status(), 'sign with the PUBLIC item is refused').toBeGreaterThanOrEqual(400);
                expect(wrong.status()).toBeLessThan(500);
                const mixed = await signWithItem(api, { ...priv, itemUuid: pub.itemUuid, keyUuid: api.probeUuid() }, data, sig);
                expect(mixed.status()).toBeLessThan(500);
                // Core checks the FIELD, not its content (COS:326 `request.getData() == null`, :344 `getSignatures() == null`): the body goes without it.
                const empty = await api.post(operationUrl(priv, 'sign'), { data: { signatureAttributes: sig } });
                expect(empty.status()).toBe(422);
                expect(expect422Messages(await empty.text()).join(' ')).toContain('Cannot sign empty data');
                const emptyVerify = await api.post(operationUrl(pub, 'verify'), { data: { signatureAttributes: sig, data: [{ data }] } });
                expect(emptyVerify.status()).toBe(422);
                expect(expect422Messages(await emptyVerify.text()).join(' ')).toContain('Cannot verify empty data');
            });
            await test.step('Row 3 again: disable → refused at once (cache evicted)', async () => {
                await disableOwnKey(api, key);
                const res = await signWithItem(api, priv, data, sig);
                expect(res.status()).toBe(422);
            });
        });

    for (const family of signedFamilies('scp-v2')) {
        test(`API-KEY-13[${family}]: sign on the PRIVATE item, verify on the PUBLIC item with the same attributes → true for every ${FAMILIES[family].label} variant, each within 5 s`,
            meta({ id: 'API-KEY-13', prio: 'P1', issue: 'ilm#431', phaseB: true, rule: ['platform-keys-connectors A2 r14, r15 (private signs, public verifies), r17 (v2 signatureAlgorithm: scheme + digest for RSA / ECDSA, the family option for ML-DSA / FALCON / SLH-DSA; no MD5 / SHA-1); DECK; §3 "S" cells'] }),
            async ({ api }, testInfo) => {
                test.setTimeout(240_000);
                const chain = await ensureKeyChain(api, SPEC);
                test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
                const c = chain as KeyChain;
                const key = await createOwnKey(api, c, `k13-${family}-${Date.now().toString(36)}`, SPEC, { family, enabled: true });
            made.push(key);
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

    test('API-KEY-14: sign / verify negatives: tampered data and a foreign signature verify false (200); empty data → 422; a wrong ML-DSA level → 422; wrong item / unrelated ids / FALCON-512 → refused, never 500',
        meta({ id: 'API-KEY-14', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r14 (texts), r15 (item roles), r17 ("Signature algorithm {} does not fit the signing key ({})." / unsupported combination, connector 422 PARAMETER_UNSUPPORTED; FALCON-512 has no platform algorithm)'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(240_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const a = await createOwnKey(api, c, `k14a-${Date.now().toString(36)}`, SPEC, { family: 'ec-p256', enabled: true });
            made.push(a);
            const b = await createOwnKey(api, c, `k14b-${Date.now().toString(36)}`, SPEC, { family: 'ec-p256', enabled: true });
            made.push(b);
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
                const m = await createOwnKey(api, c, `k14m-${Date.now().toString(36)}`, SPEC, { family: 'ml-dsa-44', enabled: true });
            made.push(m);
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
                const f = await createOwnKey(api, c, `k14f-${Date.now().toString(36)}`, SPEC, { family: 'falcon-1024', enabled: true });
            made.push(f);
                const defs = await listSignAttributes(api, itemRef(c, 'private', f));
                const options = (defs[0]?.content ?? []).map((o: any) => String(o.reference ?? o.data));
                expect(options.some((o) => /FALCON-?1024/i.test(o)), 'FALCON-1024 offered').toBe(true);
                expect(options.some((o) => /FALCON-?512/i.test(o)), 'FALCON-512 never offered').toBe(false);
            });
        });

    for (const family of encryptedFamilies('scp-v2')) {
        test(`API-KEY-16[${family}]: public-item encrypt → private-item decrypt returns the plaintext (PKCS1-v1_5 and OAEP) on ${FAMILIES[family].label}; null data → 422; over the RSA limit → 4xx`,
            meta({ id: 'API-KEY-16', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 r14 ("Cannot encrypt null data" / "Cannot decrypt null data"), r15 (public encrypts, private decrypts); §3 "E" cells'] }),
            async ({ api }, testInfo) => {
                test.setTimeout(180_000);
                const chain = await ensureKeyChain(api, SPEC);
                test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
                const c = chain as KeyChain;
                const key = await createOwnKey(api, c, `k16-${family}-${Date.now().toString(36)}`, SPEC, { family, enabled: true });
            made.push(key);
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
                        expect(cipherOutputOf(await d.json())).toBe(plain);
                    });
                }
                await test.step('null data → 422; plaintext over the RSA limit → 4xx', async () => {
                    // The FIELD `cipherData` missing (COS:211 `getCipherData() == null`), not a null element.
                    const n = await api.post(operationUrl(pub, 'encrypt'), { data: { cipherAttributes: [] } });
                    expect(n.status()).toBe(422);
                    expect(expect422Messages(await n.text()).join(' ')).toContain('Cannot encrypt null data');
                    const nd = await api.post(operationUrl(priv, 'decrypt'), { data: { cipherAttributes: [] } });
                    expect(nd.status()).toBe(422);
                    expect(expect422Messages(await nd.text()).join(' ')).toContain('Cannot decrypt null data');
                    const big = await cipherWithItem(api, pub, 'encrypt', randomData(1024), []);
                    expect(big.status()).toBeGreaterThanOrEqual(400);
                    expect(big.status()).toBeLessThan(500);
                });
            });
    }

    test('API-KEY-16[non-rsa]: encrypt with an ECDSA, ML-DSA, FALCON or ML-KEM key is refused with a 4xx, never 5xx',
        meta({ id: 'API-KEY-16', prio: 'P1', issue: 'ilm#431', rule: ['platform-keys-connectors A2 matrix (encrypt / decrypt on non-RSA rejected), K9 (forbidden-usage map covers ECDSA only: the provider refuses at operation time)'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(240_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            for (const family of ['ec-p256', 'ml-dsa-65', 'falcon-1024', 'ml-kem-768'] as Family[]) {
                await test.step(FAMILIES[family].label, async () => {
                    const key = await createOwnKey(api, c, `k16n-${family}-${Date.now().toString(36)}`, SPEC, { family, enabled: true });
            made.push(key);
                    const res = await cipherWithItem(api, itemRef(c, 'public', key), 'encrypt', randomData(16), []);
                    expect(res.status(), `${family}: refused`).toBeGreaterThanOrEqual(400);
                    expect(res.status(), `${family}: never 5xx`).toBeLessThan(500);
                });
            }
        });
});
