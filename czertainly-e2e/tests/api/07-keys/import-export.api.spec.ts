/**
 * API-KEY-22, API-KEY-23 — key import, the export gates and the export → import round trip on own keys (ilm#431, ilm#248).
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import type { AttributeDefinition } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { SCP_ATTR, signVariants } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { expect422Messages } from '../../../utils/regression/errorContract';
import { enableOwnKey, eventsOf, getKey, itemOf, keyAlias, keyCreateBody, keyItemHistory, listKeyCreateDefinitions, liveKeysNamed, recordKeyItems } from '../../../utils/regression/platform/keys';
import { createOwnToken, createOwnTokenProfile, enableOwnTokenProfile, profileUrl } from '../../../utils/regression/platform/tokens';
import { send } from '../../../utils/regression/inventory/searchApi';
import { disableKeyItemExport, exportKeyItem, importKey, itemRef, listImportKeyAttributes, listSignAttributes, signatureAttributesFor, signatureOf, signWithItem, verificationOf, verifyWithItem } from '../../../utils/regression/platform/keyOperations';
import { requestAttributesFrom, requiredCustomAttributes } from '../../../utils/regression/customAttributes';
import { ownName, runName } from '../../../utils/regression/ledger/runState';
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

/** The provider's import attributes (the key alias in the token); the material itself travels in the request's `file`. */
function importAttributesFor(defs: AttributeDefinition[], name: string): JsonObject[] {
    return requestAttributesFrom(defs, { [SCP_ATTR.keyAlias.name]: keyAlias(name) });
}

test.describe('Key import and export', { tag: tags.api }, () => {
    test('key material imports once, and a repeat and a secret key are refused',
        testMeta({ id: 'API-KEY-22', row: 'import', prio: 'P1', issue: 'ilm#431', rule: ['import gates: KEY_PAIR only on software cryptography provider v2; a key already held in full → 200 with nothing imported; secret keys refused), ilm#248 AC4 (KeyEvent.IMPORT)', 'core#2374 KeyImportRequestDto: the key file in `file` (base64), the provider attributes in importAttributes'] }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_VARIANTS_TEST_MS);
            const c = await ownKeys.chain();
            const defs = await listImportKeyAttributes(api, c);
            expect(defs.length, 'the SCP v2 profile offers import attributes').toBeGreaterThan(0);

            for (const kind of ['rsa', 'ec'] as const) {
                await test.step(`import ${kind.toUpperCase()} material → a key, ACTIVE, history IMPORT; importing it again → 200 already held`, async () => {
                    const pem = material(kind);
                    const name = ownName(`imp-${kind}`);
                    // The repeat sends the same file and attributes: core answers the key it already holds.
                    const importAttributes = importAttributesFor(defs, name);
                    const res = await importKey(api, c, { name, file: pem, importAttributes });
                    const text = await res.text();
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
                    const again = await importKey(api, c, { name: `${name}-again`, file: pem, importAttributes });
                    const againText = await again.text();
                    ownKeys.record({ status: again.status(), uuid: jsonUuid(againText), text: againText }, { name: `${name}-again`, note: `repeated ${kind} import`, parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
                    expect(again.status(), againText.slice(0, 300)).toBe(200);
                    const againBody = JSON.parse(againText) as JsonObject;
                    expect(againBody.uuid, 'the key already held is answered, nothing new imported').toBe(ref!.uuid);
                });
            }

            await test.step('a secret key → refused (SCP v2 imports KEY_PAIR only)', async () => {
                const secretName = ownName('imp-secret');
                const res = await importKey(api, c, { name: secretName, file: crypto.randomBytes(32), importAttributes: importAttributesFor(defs, secretName) }, 'secret');
                ownKeys.record({ status: res.status(), uuid: jsonUuid(await res.text()), text: '' }, { name: secretName, note: 'secret import accepted (observation)', parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
                expect(res.status()).toBeGreaterThanOrEqual(400);
                expect(res.status()).toBeLessThan(500);
            });
        });

    test('a v1 token profile refuses an import',
        testMeta({ id: 'API-KEY-22', row: 'import-v1-profile', prio: 'P1', issue: 'ilm#431', rule: ['import gates: a v1 token profile does not import keys ("Token profile <p> does not import a <t>."); ilm#248 (V1 receives no import / export capability); needs a software cryptography connector of interface v1'] }),
        async ({ api, ownKeys }) => {
            test.setTimeout(API_VARIANTS_TEST_MS);
            const { token, tokenProfile: profile } = await ownKeys.v1Chain('v1');
            const defs = await listImportKeyAttributes(api, await ownKeys.chain());
            expect(defs.length, 'the SCP v2 profile offers import attributes').toBeGreaterThan(0);
            const importName = ownName('imp-v1');
            const res = await importKey(api, { token, tokenProfile: profile }, { name: importName, file: material('rsa'), importAttributes: importAttributesFor(defs, importName) });
            const text = await res.text();
            ownKeys.record({ status: res.status(), uuid: jsonUuid(text), text }, { name: importName, note: 'imported although the v1 profile refuses import', parents: { token: token.uuid, tokenProfile: profile.uuid }, track: true });
            expect(res.status(), text.slice(0, 300)).toBeGreaterThanOrEqual(400);
            expect(res.status()).toBeLessThan(500);
            expect(text).toMatch(/does not import a/);
        });

    test('a key exported from one token and imported into another signs the same',
        testMeta({
            id: 'API-KEY-22', row: 'round-trip', prio: 'P1', issue: 'ilm#431',
            rule: [
                'export: passphrase ≥ 12, encrypted PKCS#8; import gates; ilm#248 (V2 only; FALCON-512 and pre-hash ML-DSA refused); the export format round-trips into import',
                'core KeyImportSaga: a key pair whose public key the platform holds in an active key answers that key (EXISTING), so key A leaves the inventory before the import',
            ],
        }),
        async ({ api, own, ownKeys }) => {
            test.setTimeout(API_ROUND_TRIP_TEST_MS);
            const chainA = await ownKeys.chain();
            const tokenB = await createOwnToken(api, own.spec, 'tokB', { connector: chainA.connector });
            const profileB = await createOwnTokenProfile(api, own.spec, 'tpB', { token: tokenB });
            await enableOwnTokenProfile(api, tokenB, profileB);
            const chainB = { ...chainA, token: tokenB, tokenProfile: profileB };
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
                    const publicA = itemOf(await getKey(api, keyA.uuid), 'public')?.keyData;
                    expect(publicA, `${family}: key A's public item carries its public key`).toBeTruthy();
                    await ownKeys.remove(keyA);

                    const defs = await listImportKeyAttributes(api, chainB);
                    const name = ownName(`rt-${family}-b`);
                    const imported = await importKey(api, chainB, { name, file: pem, importAttributes: importAttributesFor(defs, name), inputPassphrase: passphrase });
                    const importedText = await imported.text();
                    const keyB0 = ownKeys.record({ status: imported.status(), uuid: jsonUuid(importedText), text: importedText }, { name, note: 'imported from token A', parents: { token: tokenB.uuid, tokenProfile: profileB.uuid }, track: true });
                    expect([200, 201], importedText).toContain(imported.status());
                    expect(keyB0, `${family}: the import answered the new key`).toBeDefined();
                    const detailB = await getKey(api, keyB0!.uuid);
                    recordKeyItems(detailB, name, own.spec);
                    expect(String(itemOf(detailB, 'private')!.state).toLowerCase(), `${family}: the imported key is active`).toBe('active');
                    expect(itemOf(detailB, 'public')?.keyData, `${family}: key B holds key A's public key`).toBe(publicA);
                    await enableOwnKey(api, keyB0!);
                    const keyB = { ...keyB0!, keyItems: { privateUuid: itemOf(detailB, 'private')!.uuid, publicUuid: itemOf(detailB, 'public')!.uuid } };
                    const variant = signVariants(family)[0];
                    const sig = signatureAttributesFor(await listSignAttributes(api, itemRef(chainB, 'private', keyB)), variant);
                    expect(sig, `${family}: the sign selection of ${variant.label} is offered`).toBeDefined();
                    const data = crypto.randomBytes(64).toString('base64');
                    const signed = await signWithItem(api, itemRef(chainB, 'private', keyB), data, sig!);
                    expect(signed.status(), `${family}: the imported key signs`).toBe(200);
                    const verified = await verifyWithItem(api, itemRef(chainB, 'public', keyB), data, signatureOf(await signed.json())!, sig!);
                    expect(verificationOf(await verified.json()), `${family}: B's signature verifies with A's public key`).toBe(true);
                });
            }
        });

    test('a key exports only after every gate passes and no longer once export is disabled',
        testMeta({ id: 'API-KEY-23', prio: 'P1', issue: 'ilm#431', rule: ['CryptographicKeyExportServiceImpl gate texts and order; ExportPassphraseRequestDto ≥ 12 code points NFC; EXPORT / EXPORT_DISABLED events'] }),
        async ({ api, ownKeys }) => {
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
        async ({ api, ownKeys }) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const { token, tokenProfile } = await ownKeys.v1Chain('v1x');
            const name = ownName('k23v1');
            const defs = await listKeyCreateDefinitions(api, token, tokenProfile, 'rsa-2048');
            // A v1 item carries the provider alias as its name, so the alias is the run-prefixed key name.
            const body = keyCreateBody(defs, name, { family: 'rsa-2048', exportable: true, alias: name }, await requiredCustomAttributes(api, 'keys', runName('ca')));
            const p = await send(api, 'POST', `${profileUrl(token, tokenProfile)}/keys/keyPair`, { data: body });
            ownKeys.record({ status: p.status, uuid: (p.json as JsonObject | undefined)?.uuid, text: p.text }, { name, note: 'exportable v1 key accepted (observation)', parents: { token: token.uuid, tokenProfile: tokenProfile.uuid }, track: true });
            expect(p.status, p.text.slice(0, 300)).toBe(422);
            expect(p.text).toMatch(/does not support key export\./);
            expect(await liveKeysNamed(api, name), 'no key left').toEqual([]);
        });
});
