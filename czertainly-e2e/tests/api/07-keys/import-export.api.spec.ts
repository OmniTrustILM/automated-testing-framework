/**
 * API-KEY-22, API-KEY-23 — Key import and export on the v2 software provider. ilm#431.
 *
 * WHAT: 1. RSA and EC material made by the runner imports into an own profile: a key with ACTIVE items and an IMPORT history event;
 *          importing it again → 200 and the key already held is answered; a secret key is refused (4xx).
 *       2. A v1 token profile refuses an import ("Token profile <p> does not import a <t>."); an exportable key on a v1 profile is refused
 *          422 "…does not support key export." and leaves no key.
 *       3. A key exported from one token and imported into a second own token signs the same: RSA, ECDSA, ML-DSA and Falcon; B's signature
 *          verifies with A's public item.
 *       4. Export passes only through its gates: the public item, a key not created as exportable, a disabled key, a passphrase of 11 code
 *          points are each refused with 422 and their texts; 12 code points → 200 octet-stream with an encrypted PKCS#8 and an EXPORT
 *          event; after export/disable the next export is refused (EXPORT_DISABLED).
 * WHY: the import gates are KEY_PAIR only on the software provider v2 (ilm#248: v1 receives no import or export capability; AC4 key event
 *      IMPORT); the export format must round-trip into import. The export passphrase is at least 12 code points (NFC) and the gate order is
 *      fixed (CryptographicKeyExportServiceImpl).
 * HOW: the material is generated in memory and never logged; every key is recorded in the ledger before the first assertion and deleted at
 *      the end of its test (own hard delete) so the run token stays under the provider's key limit (software-cryptography-provider#137).
 *      The v1 rows skip without a connected v1 software cryptography connector (REG_CRYPTO_CONNECTOR_V1).
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import type { AttributeDefinition } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { signVariants } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { expect422Messages } from '../../../utils/regression/errorContract';
import { enableOwnKey, eventsOf, getKey, itemOf, keyItemHistory } from '../../../utils/regression/platform/keys';
import { createOwnToken, createOwnTokenProfile, enableOwnTokenProfile } from '../../../utils/regression/platform/tokens';
import { disableKeyItemExport, exportKeyItem, importKey, itemRef, listImportKeyAttributes, listSignAttributes, signatureAttributesFor, signatureOf, signWithItem, verificationOf, verifyWithItem } from '../../../utils/regression/platform/keyOperations';
import { requestAttributesFrom } from '../../../utils/regression/customAttributes';
import { ownName } from '../../../utils/regression/ledger/runState';
import { lookupKey } from '../../../utils/regression/ledger/uiCreates';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { JsonObject } from '../../../utils/regression/json';
import { API_ROUND_TRIP_TEST_MS, API_STANDARD_TEST_MS, API_VARIANTS_TEST_MS } from '../../../utils/regression/timeouts';

/** The uuid of a JSON answer, or undefined when the text is no JSON object with one. */
function jsonUuid(text: string): unknown {
    try {
        return (JSON.parse(text) as JsonObject).uuid;
    } catch {
        return undefined;
    }
}

/** Runner-generated private key material (PKCS#8 PEM), in memory only. */
function material(kind: 'rsa' | 'ec'): string {
    const pair = kind === 'rsa' ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) : crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** The import attributes for a PEM: every file / text / string data attribute whose name says key / material / pem / private gets it. */
function importAttributesFor(defs: AttributeDefinition[], pem: string): JsonObject[] {
    const values: Record<string, unknown> = {};
    for (const d of defs) {
        if (!/key|material|pem|private|content/i.test(d.name)) continue;
        values[d.name] = d.contentType === 'file'
            ? { content: Buffer.from(pem).toString('base64'), fileName: 'key.pem', mimeType: 'application/x-pem-file' }
            : pem;
    }
    return requestAttributesFrom(defs, values, pem);
}

test.describe('Key import and export', { tag: tags.api }, () => {
    test('key material imports once, and a repeat and a secret key are refused',
        testMeta({ id: 'API-KEY-22', row: 'import', prio: 'P1', issue: 'ilm#431', rule: ['import gates: KEY_PAIR only on software cryptography provider v2; a key already held in full → 200 with nothing imported; secret keys refused), ilm#248 AC4 (KeyEvent.IMPORT)'] }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_VARIANTS_TEST_MS);
            const c = await ownKeys.chain();
            const defs = await listImportKeyAttributes(api, c);
            expect(defs.length, 'the SCP v2 profile offers import attributes').toBeGreaterThan(0);

            for (const kind of ['rsa', 'ec'] as const) {
                await test.step(`import ${kind.toUpperCase()} material → a key, ACTIVE, history IMPORT; importing it again → 200 already held`, async () => {
                    const pem = material(kind);
                    const name = ownName(`imp-${kind}`);
                    const res = await importKey(api, c, { name, importAttributes: importAttributesFor(defs, pem) });
                    const text = await res.text();
                    // Ledger before assertion: the import made a key that the run must own and remove.
                    const ref = ownKeys.record({ status: res.status(), uuid: jsonUuid(text), text }, { name, note: `imported ${kind} key`, parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
                    expect([200, 201], text.slice(0, 300)).toContain(res.status());
                    expect(ref, 'the import answered the new key').toBeDefined();
                    const detail = await getKey(api, ref!.uuid);
                    const states = (detail.items ?? []).map((i: JsonObject) => String(i.state).toLowerCase());
                    testInfo.annotations.push({ type: 'import-states', description: `${kind}: ${states.join(', ')}` });
                    expect(states.length, `${kind}: the import made at least one item`).toBeGreaterThanOrEqual(1);
                    expect(states.every((s: string) => s === 'active' || s === 'deactivated'), 'ACTIVE (or quarantined DEACTIVATED)').toBe(true);
                    for (const item of detail.items as JsonObject[]) {
                        expect(eventsOf(await keyItemHistory(api, ref!.uuid, String(item.uuid)), 'IMPORT').length, 'IMPORT event').toBeGreaterThanOrEqual(1);
                    }
                    const again = await importKey(api, c, { name: `${name}-again`, importAttributes: importAttributesFor(defs, pem) });
                    const againText = await again.text();
                    // Ledger before assertion: an import that made a new key must be owned (a key already held is on the ledger).
                    ownKeys.record({ status: again.status(), uuid: jsonUuid(againText), text: againText }, { name: `${name}-again`, note: `repeated ${kind} import`, parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
                    expect(again.status(), againText.slice(0, 300)).toBe(200);
                    const againBody = JSON.parse(againText) as JsonObject;
                    expect(String(againBody.uuid ?? ref!.uuid), 'the key already held is answered, nothing new imported').toBe(ref!.uuid);
                });
            }

            await test.step('a secret key → refused (SCP v2 imports KEY_PAIR only)', async () => {
                const secretName = ownName('imp-secret');
                const res = await importKey(api, c, { name: secretName, importAttributes: importAttributesFor(defs, crypto.randomBytes(32).toString('base64')) }, 'secret');
                // Ledger before assertion: an accepted secret import made a key that the run must own and remove.
                ownKeys.record({ status: res.status(), uuid: jsonUuid(await res.text()), text: '' }, { name: secretName, note: 'secret import accepted (observation)', parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
                expect(res.status()).toBeGreaterThanOrEqual(400);
                expect(res.status()).toBeLessThan(500);
            });
        });

    test('a v1 token profile refuses an import',
        testMeta({ id: 'API-KEY-22', row: 'import-v1-profile', prio: 'P1', issue: 'ilm#431', rule: ['import gates: a v1 token profile does not import keys ("Token profile <p> does not import a <t>."); ilm#248 (V1 receives no import / export capability); needs a software cryptography connector of interface v1'] }),
        async ({ api, own, ownKeys }) => {
            test.setTimeout(API_VARIANTS_TEST_MS);
            const v1 = await ownKeys.connector(1);
            const defs = await listImportKeyAttributes(api, await ownKeys.chain());
            expect(defs.length, 'the SCP v2 profile offers import attributes').toBeGreaterThan(0);
            const token = await createOwnToken(api, own.spec, 'tokv1', { connector: v1, kind: 'SOFT' });
            const profile = await createOwnTokenProfile(api, own.spec, 'tpv1', { token });
            await enableOwnTokenProfile(api, token, profile);
            const importName = ownName('imp-v1');
            const res = await importKey(api, { token, tokenProfile: profile }, { name: importName, importAttributes: importAttributesFor(defs, material('rsa')) });
            const text = await res.text();
            // Ledger first: a refusal that wrongly succeeds imported an own key.
            ownKeys.record({ status: res.status(), uuid: jsonUuid(text), text }, { name: importName, note: 'imported although the v1 profile refuses import', parents: { token: token.uuid, tokenProfile: profile.uuid }, track: true });
            expect(res.status(), text.slice(0, 300)).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            expect(text).toMatch(/does not import a/);
        });

    test('a key exported from one token and imported into another signs the same',
        testMeta({ id: 'API-KEY-22', row: 'round-trip', prio: 'P1', issue: 'ilm#431', rule: ['export: passphrase ≥ 12, encrypted PKCS#8; import gates; ilm#248 (V2 only; FALCON-512 and pre-hash ML-DSA refused); the export format round-trips into import'] }),
        async ({ api, own, ownKeys }, testInfo) => {
            test.setTimeout(API_ROUND_TRIP_TEST_MS);
            const chainA = await ownKeys.chain();
            const tokenB = await createOwnToken(api, own.spec, 'tokB', { connector: chainA.connector });
            const profileB = await createOwnTokenProfile(api, own.spec, 'tpB', { token: tokenB });
            await enableOwnTokenProfile(api, tokenB, profileB);
            const chainB = { token: tokenB, tokenProfile: profileB };
            const passphrase = `Qa-${crypto.randomBytes(9).toString('base64url')}`;
            for (const family of ['rsa-2048', 'ec-p256', 'ml-dsa-65', 'falcon-1024'] as const) {
                await test.step(family, async () => {
                    const keyA = await ownKeys.make(`rt-${family}`, { chain: chainA, family, enabled: true, exportable: true });
                    const privA = itemRef(chainA, 'private', keyA);
                    const exported = await exportKeyItem(api, keyA.uuid, privA.itemUuid, passphrase);
                    expect(exported.status(), await exported.text()).toBe(200);
                    expect(exported.headers()['content-type'] ?? '', `${family}: the export is an octet stream`).toContain('application/octet-stream');
                    const pem = (await exported.body()).toString('utf8');
                    expect(pem, `${family}: the export is an encrypted PKCS#8`).toMatch(/^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
                    const defs = await listImportKeyAttributes(api, chainB);
                    const name = ownName(`rt-${family}-b`);
                    const imported = await importKey(api, chainB, { name, importAttributes: importAttributesFor(defs, pem), inputPassphrase: passphrase });
                    const importedText = await imported.text();
                    // Ledger before assertion: the import made a key that the run must own.
                    const keyB0 = ownKeys.record({ status: imported.status(), uuid: jsonUuid(importedText), text: importedText }, { name, note: 'imported from token A', parents: { token: tokenB.uuid, tokenProfile: profileB.uuid } });
                    expect([200, 201], importedText).toContain(imported.status());
                    expect(keyB0, `${family}: the import answered the new key`).toBeDefined();
                    const keyB = keyB0!;
                    const detailB = await getKey(api, keyB.uuid);
                    expect(String(itemOf(detailB, 'private')!.state).toLowerCase(), `${family}: the imported key is active`).toBe('active');
                    await enableOwnKey(api, keyB);
                    const refB = { ...keyB, keyItems: { privateUuid: itemOf(detailB, 'private')!.uuid, publicUuid: itemOf(detailB, 'public')!.uuid } };
                    const variant = signVariants(family)[0];
                    const sig = signatureAttributesFor(await listSignAttributes(api, itemRef({ ...chainA, ...chainB }, 'private', refB)), variant) ?? [];
                    const data = crypto.randomBytes(64).toString('base64');
                    const signed = await signWithItem(api, itemRef({ ...chainA, ...chainB }, 'private', refB), data, sig);
                    expect(signed.status(), `${family}: the imported key signs`).toBe(200);
                    const verified = await verifyWithItem(api, itemRef(chainA, 'public', keyA), data, signatureOf(await signed.json())!, sig);
                    expect(verificationOf(await verified.json()), `${family}: B's signature verifies with A's public item`).toBe(true);
                });
            }
        });

    test('a key exports only after every gate passes and no longer once export is disabled',
        testMeta({ id: 'API-KEY-23', prio: 'P1', issue: 'ilm#431', rule: ['CryptographicKeyExportServiceImpl gate texts and order; ExportPassphraseRequestDto ≥ 12 code points NFC; EXPORT / EXPORT_DISABLED events'] }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_VARIANTS_TEST_MS);
            const c = await ownKeys.chain();
            const exportable = await ownKeys.make('k23', { chain: c, family: 'rsa-2048', enabled: false, exportable: true });
            const plain = await ownKeys.make('k23p', { chain: c, family: 'rsa-2048', enabled: true, exportable: false });
            const pass12 = 'Qa-passphrase';
            const expect422 = async (res: Awaited<ReturnType<typeof exportKeyItem>>, text: string | RegExp) => {
                expect(res.status()).toBe(422);
                expect(expect422Messages(await res.text()).join(' ')).toMatch(text);
            };
            await test.step('gate 1: the PUBLIC item → "only private and secret keys are exported."', async () => {
                await expect422(await exportKeyItem(api, exportable.uuid, exportable.keyItems!.publicUuid!, pass12), /only private and secret keys are exported\./);
            });
            await test.step('gate 2: not created as exportable → "was not created or imported as exportable."', async () => {
                await expect422(await exportKeyItem(api, plain.uuid, plain.keyItems!.privateUuid!, pass12), /was not created or imported as exportable\./);
            });
            await test.step('gate 3: disabled → "must be active and enabled to be exported."', async () => {
                await expect422(await exportKeyItem(api, exportable.uuid, exportable.keyItems!.privateUuid!, pass12), /must be active and enabled to be exported\./);
                await enableOwnKey(api, exportable);
            });
            await test.step('gate 0: 11 code points → 422; 12 → 200 octet-stream, encrypted PKCS#8, history EXPORT', async () => {
                const short = await exportKeyItem(api, exportable.uuid, exportable.keyItems!.privateUuid!, 'Qa-passphra');
                expect(short.status()).toBe(422);
                const ok = await exportKeyItem(api, exportable.uuid, exportable.keyItems!.privateUuid!, pass12);
                expect(ok.status(), await ok.text()).toBe(200);
                expect(ok.headers()['content-type'] ?? '').toContain('application/octet-stream');
                expect((await ok.body()).toString('utf8')).toMatch(/^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
                expect(eventsOf(await keyItemHistory(api, exportable.uuid, exportable.keyItems!.privateUuid!), 'EXPORT', 'SUCCESS').length).toBeGreaterThanOrEqual(1);
            });
            await test.step('export/disable → EXPORT_DISABLED, the next export refused', async () => {
                const off = await disableKeyItemExport(api, exportable.uuid, exportable.keyItems!.privateUuid!);
                expect(off.status(), await off.text()).toBeLessThan(300);
                expect(eventsOf(await keyItemHistory(api, exportable.uuid, exportable.keyItems!.privateUuid!), 'EXPORT_DISABLED').length).toBeGreaterThanOrEqual(1);
                const res = await exportKeyItem(api, exportable.uuid, exportable.keyItems!.privateUuid!, pass12);
                expect(res.status()).toBe(422);
            });
        });

    test('an exportable key on a v1 profile is refused and leaves no key',
        testMeta({ id: 'API-KEY-23', row: 'create-gate', prio: 'P1', issue: 'ilm#431', rule: ['CryptographicKeyServiceImpl: exportable requested but the connector lacks KEY_EXPORT), ilm#248 (V1 receives no import / export capability)'] }),
        async ({ api, own, ownKeys }) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const v1 = await ownKeys.connector(1);
            const token = await createOwnToken(api, own.spec, 'tokv1x', { connector: v1, kind: 'SOFT' });
            const profile = await createOwnTokenProfile(api, own.spec, 'tpv1x', { token });
            await enableOwnTokenProfile(api, token, profile);
            const name = ownName('k23v1');
            let refused: { status: number; text: string } | undefined;
            try {
                await ownKeys.make(name, { chain: { token, tokenProfile: profile }, family: 'rsa-2048', exportable: true, name });
            } catch (e) {
                const m = /→ (\d{3}) (.*)$/s.exec(String(e));
                refused = m ? { status: Number(m[1]), text: m[2] } : { status: 0, text: String(e) };
            }
            expect(refused, 'the create is refused').toBeTruthy();
            expect(refused!.status).toBe(422);
            expect(refused!.text).toMatch(/does not support key export\./);
            expect((await lookupKey(api)(name)).rows, 'no key left').toEqual([]);
        });
});
