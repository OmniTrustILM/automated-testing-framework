/**
 * API-KEY-09, 10, 11 — Key creation on the software cryptography provider. ilm#431.
 *
 * WHAT: 1. The create-key form offers every required algorithm (and size options where the definitions carry them) and no forbidden one;
 *          the list offers no Unknown or deprecated entry (software-cryptography-provider#50: test.fail while open).
 *       2. A new key pair of each generated family (RSA, ECDSA, EdDSA, post-quantum as the provider offers them) has two items, both active
 *          and disabled, with the right algorithm, RSA size and usages, and a CREATE event per item.
 *       3. RSA 3072 (not offered on the software provider), 2047 and 4097, an unknown curve, a duplicate key name (409 "Existing Key with
 *          the same name already exists") and an alias differing only by case are refused and leave no key behind.
 *       4. An algorithm the connector cannot create (AES) is refused with a 4xx (software-cryptography-provider#147: 502 today, test.fail).
 * WHY: the attributes are validated against the connector schema before a key is created; usages are copied minus the forbidden ones
 *      (private: no verify, encrypt or wrap; public: no sign, decrypt or unwrap; ECDSA: no encrypt or decrypt). An unsupported algorithm is
 *      a request error.
 * HOW: the keys sit on the run token and token profile chain (created or reused by ensureKeyChain; skip with the named reason when it
 *      cannot be made); every key made in a test is deleted at its end (own hard delete and a `deleted` ledger line) so the run token stays
 *      under the provider's key limit (software-cryptography-provider#137); every refusal is followed by a search proving no key of that
 *      name exists, and
 *      an accepted create is recorded in the ledger before the assertion.
 */
import { expect, test } from '../../../fixtures/areas/ownKeys';
import {
    absentFamilies, algorithmListProblems, expectedItemUsages, FAMILIES, Family, generatedFamilies, offeredAlgorithms, offeredOptions, PROFILE_USAGES, SCP_ATTR, sameUsages,
} from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { eventsOf, getKey, itemOf, keyAlias, keyCreateBody, keyItemHistory, listCreateKeyAttributes } from '../../../utils/regression/platform/keys';
import { profileUrl } from '../../../utils/regression/platform/tokens';
import { lookupKey, type NamedRow } from '../../../utils/regression/ledger/uiCreates';
import { ownName } from '../../../utils/regression/ledger/runState';
import { send } from '../../../utils/regression/inventory/searchApi';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { JsonObject } from '../../../utils/regression/json';
import { uniqueSuffix } from '../../../utils/regression/text';
import { API_SHORT_TEST_MS, API_STANDARD_TEST_MS, API_VARIANTS_TEST_MS } from '../../../utils/regression/timeouts';

/** The inventory rows named exactly `name`: every page of the key list is read. */
async function keysNamed(api: GuardedApi, name: string): Promise<NamedRow[]> {
    return (await lookupKey(api)(name)).rows;
}

/** The families API-KEY-10 generates on SCP v2 (the generated cells, bounded by the per-token key limit). */
const GENERATED: Family[] = generatedFamilies('scp-v2').filter((f) => f !== 'rsa-1024');

test.describe('Key creation', { tag: tags.api }, () => {
    test('the create-key form offers every required algorithm and no forbidden one',
        testMeta({
            id: 'API-KEY-09', prio: 'P1', issue: 'ilm#431',
            rule: [
                'create guard order; attributes validated against the connector schema; RSA 3072 only on PKCS#11; the algorithm lists must offer and must not offer the expected entries',
            ],
        }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const c = await ownKeys.chain();
            const defs = await listCreateKeyAttributes(api, c.token, c.tokenProfile);
            const offered = offeredAlgorithms(defs);
            testInfo.annotations.push({ type: 'offered-algorithms', description: offered.join(', ') });
            const problems = algorithmListProblems(c.provider, offered);
            expect(problems.missing, 'must-offer algorithms present').toEqual([]);
            expect(problems.forbidden, 'must-not-offer algorithms absent').toEqual([]);

            await test.step('Size / curve / level option lists, where the definitions carry them (else resolved by the connector callback: the create form offers them, the refusal rows below send them)', async () => {
                const sizes = offeredOptions(defs, SCP_ATTR.rsaKeySize.name);
                if (sizes.length) {
                    expect(sizes).toEqual(expect.arrayContaining(['RSA_2048', 'RSA_4096']));
                    for (const f of absentFamilies(c.provider)) if (FAMILIES[f].algorithm === 'RSA') expect(sizes, `${FAMILIES[f].label} must not be offered`).not.toContain(FAMILIES[f].option);
                } else {
                    testInfo.annotations.push({ type: 'size-options', description: 'resolved through the v2 attributes callback of group_keySpecV2 (not in the definition list)' });
                }
            });
        });

    test('the algorithm list offers no unknown or deprecated entry',
        testMeta({ id: 'API-KEY-09', row: 'never-offered', prio: 'P1', issue: 'ilm#431', bug: 'software-cryptography-provider#50', rule: ['software-cryptography-provider#50 (the dropdown offers Unknown or deprecated algorithms)'] }),
        async ({ api, ownKeys }) => {
            test.setTimeout(API_SHORT_TEST_MS);
            const c = await ownKeys.chain();
            // Known bug software-cryptography-provider#50: the list carries deprecated entries today; the test turns red (passes
            // unexpectedly) once it is fixed.
            test.fail(true, 'software-cryptography-provider#50: the create-key algorithm list offers Unknown / deprecated entries');
            const offered = offeredAlgorithms(await listCreateKeyAttributes(api, c.token, c.tokenProfile));
            expect(algorithmListProblems(c.provider, offered).neverOffered, 'entries that must never be offered').toEqual([]);
        });

    for (const family of GENERATED) {
        test(`a new ${FAMILIES[family].label} key pair has two active, disabled items`,
            testMeta({
                id: 'API-KEY-10', row: family, prio: 'P1', issue: 'ilm#431',
                rule: [
                    'usages copied minus the forbidden ones: private no verify / encrypt / wrap, public no sign / decrypt / unwrap, ECDSA no encrypt / decrypt)',
                    'new items ACTIVE and enabled = false; a CREATE event per item; EC length not asserted',
                ],
            }),
            async ({ api, ownKeys }) => {
                test.setTimeout(API_STANDARD_TEST_MS);
                const c = await ownKeys.chain();
                const spec = FAMILIES[family];
                const key = await test.step('Make the key pair', async () => ownKeys.make(`k10-${family}`, { chain: c, family }));
                const { detail, priv, pub } = await test.step('Read the key: a private and a public item, exactly two', async () => {
                    const read = await getKey(api, key.uuid);
                    const privateItem = itemOf(read, 'private');
                    const publicItem = itemOf(read, 'public');
                    expect(privateItem, 'a private item').toBeTruthy();
                    expect(publicItem, 'a public item').toBeTruthy();
                    expect((read.items ?? []).length, 'exactly two items').toBe(2);
                    return { detail: read, priv: privateItem!, pub: publicItem! };
                });
                await test.step('Each item: state, algorithm, size, usages and the CREATE event', async () => {
                    for (const [kind, item] of [['private', priv], ['public', pub]] as const) {
                        expect(String(item.state).toLowerCase(), `${kind} item state`).toBe('active');
                        expect(item.enabled, `${kind} item enabled`).toBe(false);
                        expect(String(item.keyAlgorithm).toUpperCase().replace(/[^A-Z0-9-]/g, ''), `${kind} item algorithm`).toBe(spec.algorithm.replace(/[^A-Z0-9-]/g, ''));
                        if (spec.algorithm === 'RSA') expect(Number(item.length), `${kind} item RSA size`).toBe(spec.size);
                        expect(sameUsages(item.usage ?? [], expectedItemUsages(PROFILE_USAGES, kind, spec.algorithm)), `${kind} item usages ${JSON.stringify(item.usage)}`).toBe(true);
                        const history = await keyItemHistory(api, key.uuid, String(item.uuid));
                        expect(eventsOf(history, 'CREATE', 'SUCCESS').length, `${kind} item history has CREATE`).toBeGreaterThanOrEqual(1);
                    }
                    expect((detail.items ?? []).length, 'still two items').toBe(2);
                });
            });
    }

    test('invalid sizes, curves and duplicate names or aliases are refused and leave no key',
        testMeta({
            id: 'API-KEY-11', prio: 'P1', issue: 'ilm#431',
            rule: [
                'duplicate name → 409 "Existing Key with the same name already exists"; attributes validated against the schema; no RSA 3072 on the software cryptography provider',
                'software-cryptography-provider KeySpecV2Attributes ("This connector creates no <X> key"), CryptographicKeyV2ServiceImpl ("Key with alias … already exists")',
            ],
        }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_VARIANTS_TEST_MS);
            const c = await ownKeys.chain();
            const defs = await listCreateKeyAttributes(api, c.token, c.tokenProfile);
            const url = `${profileUrl(c.token, c.tokenProfile)}/keys/keyPair`;

            const refused = async (title: string, name: string, body: JsonObject, expectStatus: (s: number) => void, mention?: RegExp) => {
                await test.step(title, async () => {
                    const p = await send(api, 'POST', url, { data: body });
                    // Ledger before assertion: an accepted create made a key that the run must own and remove.
                    ownKeys.record({ status: p.status, uuid: (p.json as JsonObject)?.uuid, text: p.text }, { name, note: 'refusal probe accepted (observation)', parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
                    expect(p.status, p.text.slice(0, 300)).toBeLessThan(500);
                    expectStatus(p.status);
                    if (mention) expect(p.text, `the message names it: ${p.text.slice(0, 200)}`).toMatch(mention);
                    testInfo.annotations.push({ type: 'refusal', description: `${title}: ${p.status} ${p.text.slice(0, 120)}` });
                    expect(await keysNamed(api, name), `no key named ${name} was left behind`).toEqual([]);
                });
            };

            for (const [label, size] of [['3072', 3072], ['2047', 2047], ['4097', 4097]] as const) {
                const name = ownName(`k11-rsa${label}`);
                await refused(`RSA ${label} → 422 naming the size`, name, keyCreateBody(defs, name, { family: 'rsa-2048', sizeOverride: size }, []), (s) => expect(s, `${label}: refused with 422`).toBe(422), new RegExp(label));
            }
            {
                const name = ownName('k11-curve');
                await refused('Unknown curve → 422', name, keyCreateBody(defs, name, { family: 'ec-p256', sizeOverride: 'secp999r1' }, []), (s) => expect(s).toBe(422));
            }
            await test.step('Duplicate key name → 409 "Existing Key with the same name already exists"', async () => {
                const first = await ownKeys.make('k11-dup', { chain: c, family: 'rsa-2048' });
                const p = await send(api, 'POST', url, { data: keyCreateBody(defs, first.name, { family: 'rsa-2048', alias: keyAlias(`${first.name}b`) }, []) });
                ownKeys.record({ status: p.status, uuid: (p.json as JsonObject)?.uuid, text: p.text }, { name: first.name, note: 'duplicate-name probe accepted (observation)', parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
                expect(p.status, p.text.slice(0, 300)).toBe(409);
                expect(p.text).toContain('Existing Key with the same name already exists');
                expect((await keysNamed(api, first.name)).length, 'still exactly the first key of that name').toBeLessThanOrEqual(2);
            });
            await test.step('An alias differing only by case → the connector refuses "already exists" (the refusal code is recorded, then asserted)', async () => {
                const baseAlias = `QaAliasCase${uniqueSuffix()}`;
                await ownKeys.make('k11-alias', { chain: c, family: 'rsa-2048', alias: baseAlias });
                const name = ownName('k11-alias2');
                // The SAME alias, upper-cased (a case-only variant of the base key's provider alias).
                const p = await send(api, 'POST', url, { data: keyCreateBody(defs, name, { family: 'rsa-2048', alias: baseAlias.toUpperCase() }, []) });
                testInfo.annotations.push({ type: 'alias-case-refusal', description: `${p.status} ${p.text.slice(0, 160)}` });
                if (p.status < 400) {
                    // Ledger before assertion: an accepted variant made a key that the run must own and remove.
                    ownKeys.record({ status: p.status, uuid: (p.json as JsonObject)?.uuid, text: p.text }, { name, note: 'case-variant alias accepted (observation)', parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
                }
                expect(p.status, 'the case-variant alias is refused (4xx)').toBeGreaterThanOrEqual(400);
                expect(p.status, 'never 500').toBeLessThan(500);
                expect(p.text).toMatch(/already exists/i);
            });
        });

    test('an algorithm the connector cannot create is refused with a 4xx',
        testMeta({
            id: 'API-KEY-11', row: 'aes', prio: 'P1', issue: 'ilm#431', bug: 'software-cryptography-provider#147',
            rule: ['software-cryptography-provider#147 (an unsupported algorithm is a request error: 4xx, v2 422 PARAMETER_UNSUPPORTED; the connector callback already refuses it); software-cryptography-provider KeySpecV2Attributes ("This connector creates no <X> key")'],
        }),
        async ({ api, ownKeys }, testInfo) => {
            test.setTimeout(API_VARIANTS_TEST_MS);
            const c = await ownKeys.chain();
            const defs = await listCreateKeyAttributes(api, c.token, c.tokenProfile);
            const url = `${profileUrl(c.token, c.tokenProfile)}/keys/keyPair`;
            const name = ownName('k11-aes');
            const body = keyCreateBody(defs, name, { family: 'rsa-2048' }, []);
            body.attributes = (body.attributes as JsonObject[]).filter((a) => a.name !== SCP_ATTR.rsaKeySize.name).map((a) =>
                a.name === SCP_ATTR.keyAlgorithm.name ? { ...a, content: [{ reference: 'AES', data: 'AES' }] } : a);
            const p = await send(api, 'POST', url, { data: body });
            if (p.status < 400) {
                // Ledger before assertion: an accepted create made a key that the run must own and remove.
                ownKeys.record({ status: p.status, uuid: (p.json as JsonObject)?.uuid, text: p.text }, { name, note: 'AES create accepted (observation)', parents: { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }, track: true });
            }
            testInfo.annotations.push({ type: 'refusal', description: `AES create: ${p.status} ${p.text.slice(0, 120)}` });
            test.fail(true, 'software-cryptography-provider#147: an algorithm the connector cannot create answers 502 (connector 500) instead of a 4xx');
            expect([400, 422], p.text.slice(0, 300)).toContain(p.status);
            expect(await keysNamed(api, name), `no key named ${name} was left behind`).toEqual([]);
        });
});
