/**
 * API-KEY-09 / 10 / 11 — key creation on the software provider: what the live create-key form offers (the §3 matrix),
 * the generation matrix (one key per family), and the create negatives (ilm#431, T7; platform area).
 *
 * Own objects only: the run's token and ENABLED profile (`ensureKeyChain`), at most 14 keys on the run token (SCP#137).
 * The SCP resolves the size / curve / level options through the v2 attributes callback of `group_keySpecV2`; a
 * callback on a pre-existing connector is a write the guard refuses (B1 author decision 2), so the option lists are
 * asserted where the definitions carry them, through the create refusals of API-KEY-11 (RSA 3072 → 422) and in the UI
 * (REG-KEY-04). Every refused create is followed by a search proving no key of that name exists.
 */
import { expect, test } from '../../fixtures/testFixtures';
import {
    absentFamilies, algorithmListProblems, expectedItemUsages, FAMILIES, Family, generatedFamilies, offeredAlgorithms, offeredOptions, PROFILE_USAGES, SCP_ATTR, sameUsages,
} from '../../utils/regression/cryptoMatrix';
import { expect422Messages } from '../../utils/regression/errorContract';
import {
    createOwnKey, deleteOwnKey, ensureKeyChain, eventsOf, getKey, isSkip, itemOf, keyAlias, keyCreateBody, keyItemHistory, KeyChain, listCreateKeyAttributes, profileUrl,
} from '../../utils/regression/keyApi';
import { apiJson } from '../../utils/regression/regressionApi';
import { OwnRef, recordCreated, regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guardedApi';

const SPEC = 'API-KEY-09-11';
type Json = Record<string, any>;

/** The inventory rows named exactly `name` (read POST; the name filter first, a page scan when the filter is refused). */
async function keysNamed(api: GuardedApi, name: string): Promise<Json[]> {
    const res = await api.post('/api/v1/keys', { data: { itemsPerPage: 100, pageNumber: 1, filters: [{ fieldSource: 'property', fieldIdentifier: 'NAME', condition: 'EQUALS', value: name }] } });
    if (res.ok()) return ((await res.json()).cryptographicKeys ?? []) as Json[];
    const page = await apiJson<Json>(api, 'POST', '/api/v1/keys', { itemsPerPage: 100, pageNumber: 1, filters: [] });
    return ((page.cryptographicKeys ?? []) as Json[]).filter((k) => k.name === name);
}

/** The families API-KEY-10 generates on SCP v2 (the G cells, bounded by the per-token cap). */
const GENERATED: Family[] = generatedFamilies('scp-v2').filter((f) => f !== 'rsa-1024');

/** Keys made inside a test: deleted at its end (own hard delete + `deleted` ledger line) so the run token never holds more than a few (SCP#137, Sonnet F6). */
const made: OwnRef[] = [];

test.describe('API-KEY key creation', { tag: tags.api }, () => {
    test.afterEach(async ({ api }) => {
        for (const key of made.splice(0)) await deleteOwnKey(api, key, SPEC);
    });

    test('API-KEY-09: the create-key form of an own enabled profile offers every must-offer algorithm and none of the must-not-offer ones (SCP v2)',
        meta({
            id: 'API-KEY-09', prio: 'P1', issue: 'ilm#431',
            rule: [
                'platform-keys-connectors A2 r11 (create guard order; attributes validated against the connector schema), K5 (RSA 3072 only on PKCS#11); DECK matrix; §3 must-offer / must-not-offer cells',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const defs = await listCreateKeyAttributes(api, c.token, c.tokenProfile);
            const offered = offeredAlgorithms(defs);
            testInfo.annotations.push({ type: 'offered-algorithms', description: offered.join(', ') });
            const problems = algorithmListProblems(c.provider, offered);
            expect(problems.missing, 'must-offer algorithms present').toEqual([]);
            expect(problems.forbidden, 'must-not-offer algorithms absent').toEqual([]);

            await test.step('Size / curve / level option lists, where the definitions carry them (else resolved by the connector callback: UI REG-KEY-04, refusal API-KEY-11)', async () => {
                const sizes = offeredOptions(defs, SCP_ATTR.rsaKeySize.name);
                if (sizes.length) {
                    expect(sizes).toEqual(expect.arrayContaining(['RSA_2048', 'RSA_4096']));
                    for (const f of absentFamilies(c.provider)) if (FAMILIES[f].algorithm === 'RSA') expect(sizes, `${FAMILIES[f].label} must not be offered`).not.toContain(FAMILIES[f].option);
                } else {
                    testInfo.annotations.push({ type: 'size-options', description: 'resolved through the v2 attributes callback of group_keySpecV2 (not in the definition list)' });
                }
            });
        });

    test('API-KEY-09[never-offered]: the algorithm list offers no Unknown, AES, CRYSTALS-Dilithium or SPHINCS+ entry',
        meta({ id: 'API-KEY-09', prio: 'P1', issue: 'ilm#431', bug: 'software-cryptography-provider#50', rule: ['software-cryptography-provider#50 (the dropdown offers Unknown or deprecated algorithms); DECK algorithm slide'] }),
        async ({ api }) => {
            test.setTimeout(60_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            // Known bug SCP#50: the list carries deprecated entries today; the test turns red (passes unexpectedly) once it is fixed.
            test.fail(true, 'software-cryptography-provider#50: the create-key algorithm list offers Unknown / deprecated entries');
            const offered = offeredAlgorithms(await listCreateKeyAttributes(api, c.token, c.tokenProfile));
            expect(algorithmListProblems(c.provider, offered).neverOffered, 'entries that must never be offered').toEqual([]);
        });

    for (const family of GENERATED) {
        test(`API-KEY-10[${family}]: POST …/keys/keyPair makes a PRIVATE and a PUBLIC item, both ACTIVE and disabled, ${FAMILIES[family].label} as requested, usages per r10, CREATE in each history`,
            meta({
                id: 'API-KEY-10', prio: 'P1', issue: 'ilm#431',
                rule: [
                    'platform-keys-connectors A2 r10 (usages copied minus the forbidden ones: private no verify / encrypt / wrap, public no sign / decrypt / unwrap, ECDSA no encrypt / decrypt)',
                    'platform-keys-connectors A2 r12 (new items ACTIVE and enabled = false), r23 (CREATE event per item); K12 / OQ-10 (EC length not asserted)',
                ],
            }),
            async ({ api }) => {
                test.setTimeout(120_000);
                const chain = await ensureKeyChain(api, SPEC);
                test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
                const c = chain as KeyChain;
                const spec = FAMILIES[family];
                const key = await createOwnKey(api, c, `k10-${family}-${Date.now().toString(36)}`, SPEC, { family });
                made.push(key);
                const detail = await getKey(api, key.uuid);
                const priv = itemOf(detail, 'private');
                const pub = itemOf(detail, 'public');
                expect(priv, 'a private item').toBeTruthy();
                expect(pub, 'a public item').toBeTruthy();
                expect((detail.items ?? []).length, 'exactly two items').toBe(2);
                for (const [kind, item] of [['private', priv!], ['public', pub!]] as const) {
                    expect(String(item.state).toLowerCase(), `${kind} item state`).toBe('active');
                    expect(item.enabled, `${kind} item enabled`).toBe(false);
                    expect(String(item.keyAlgorithm).toUpperCase().replace(/[^A-Z0-9-]/g, ''), `${kind} item algorithm`).toBe(spec.algorithm.replace(/[^A-Z0-9-]/g, ''));
                    if (spec.algorithm === 'RSA') expect(Number(item.length), `${kind} item RSA size`).toBe(spec.size);
                    expect(sameUsages(item.usage ?? [], expectedItemUsages(PROFILE_USAGES, kind, spec.algorithm)), `${kind} item usages ${JSON.stringify(item.usage)}`).toBe(true);
                    const history = await keyItemHistory(api, key.uuid, String(item.uuid));
                    expect(eventsOf(history, 'CREATE', 'SUCCESS').length, `${kind} item history has CREATE`).toBeGreaterThanOrEqual(1);
                }
            });
    }

    test('API-KEY-11: key create negatives leave no key: RSA 3072 / 2047 / 4097 and an unknown curve → 422 (never 500); duplicate name → 409; duplicate alias → refused',
        meta({
            id: 'API-KEY-11', prio: 'P1', issue: 'ilm#431',
            rule: [
                'platform-keys-connectors A2 r11 (duplicate name → 409 "Existing Key with the same name already exists"; attributes validated against the schema), r13; K5 (no RSA 3072 on the SCP)',
                'software-cryptography-provider KeySpecV2Attributes ("This connector creates no <X> key"), CryptographicKeyV2ServiceImpl ("Key with alias … already exists")',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(180_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const defs = await listCreateKeyAttributes(api, c.token, c.tokenProfile);
            const url = `${profileUrl(c.token, c.tokenProfile)}/keys/keyPair`;

            const refused = async (title: string, name: string, body: Json, expectStatus: (s: number) => void, mention?: RegExp) => {
                await test.step(title, async () => {
                    const res = await api.post(url, { data: body });
                    const text = await res.text();
                    expect(res.status(), text.slice(0, 300)).toBeLessThan(500);
                    expectStatus(res.status());
                    if (mention) expect(text, `the message names it: ${text.slice(0, 200)}`).toMatch(mention);
                    testInfo.annotations.push({ type: 'refusal', description: `${title}: ${res.status()} ${text.slice(0, 120)}` });
                    expect(await keysNamed(api, name), `no key named ${name} was left behind`).toEqual([]);
                });
            };

            for (const [label, size] of [['3072', 3072], ['2047', 2047], ['4097', 4097]] as const) {
                const name = regName(`k11-rsa${label}-${Date.now().toString(36)}`);
                await refused(`RSA ${label} → 422 naming the size`, name, keyCreateBody(defs, name, { family: 'rsa-2048', sizeOverride: size }, []), (s) => expect(s).toBe(422), new RegExp(label));
            }
            {
                const name = regName(`k11-curve-${Date.now().toString(36)}`);
                await refused('Unknown curve → 422', name, keyCreateBody(defs, name, { family: 'ec-p256', sizeOverride: 'secp999r1' }, []), (s) => expect(s).toBe(422));
            }
            await test.step('Duplicate key name → 409 "Existing Key with the same name already exists"', async () => {
                const first = await createOwnKey(api, c, `k11-dup-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048' });
                made.push(first);
                const res = await api.post(url, { data: keyCreateBody(defs, first.name, { family: 'rsa-2048', alias: keyAlias(`${first.name}b`) }, []) });
                const text = await res.text();
                expect(res.status(), text.slice(0, 300)).toBe(409);
                expect(text).toContain('Existing Key with the same name already exists');
                expect((await keysNamed(api, first.name)).length, 'still exactly the first key of that name').toBeLessThanOrEqual(2);
            });
            await test.step('An alias differing only by case → the connector refuses "already exists" (the refusal code is recorded, then pinned)', async () => {
                const baseAlias = `QaAliasCase${Date.now().toString(36)}`;
                const base = await createOwnKey(api, c, `k11-alias-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048', alias: baseAlias });
                made.push(base);
                const name = regName(`k11-alias2-${Date.now().toString(36)}`);
                // The SAME alias, upper-cased (a case-only variant of the base key's provider alias, Sonnet F2).
                const res = await api.post(url, { data: keyCreateBody(defs, name, { family: 'rsa-2048', alias: baseAlias.toUpperCase() }, []) });
                const text = await res.text();
                testInfo.annotations.push({ type: 'alias-case-refusal', description: `${res.status()} ${text.slice(0, 160)}` });
                if (res.status() < 400) {
                    // Ledger before assertion: an accepted variant made a key that the run must own and remove.
                    const accepted = recordCreated('keys', { uuid: String((JSON.parse(text) as Json).uuid), name }, SPEC, 'case-variant alias accepted (observation)', { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid });
                    made.push(accepted);
                }
                expect(res.status(), 'the case-variant alias is refused (4xx)').toBeGreaterThanOrEqual(400);
                expect(res.status(), 'never 500').toBeLessThan(500);
                expect(text).toMatch(/already exists/i);
                void expect422Messages;
            });
        });

    test('API-KEY-11[aes]: a create with an algorithm the connector does not create (AES) is refused with a 4xx and leaves no key (known bug: 502 from a connector 500)',
        meta({
            id: 'API-KEY-11', prio: 'P1', issue: 'ilm#431', bug: 'software-cryptography-provider#147',
            rule: ['software-cryptography-provider#147 (an unsupported algorithm is a request error: 4xx, v2 422 PARAMETER_UNSUPPORTED; the connector callback already refuses it); software-cryptography-provider KeySpecV2Attributes ("This connector creates no <X> key")'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(180_000);
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const defs = await listCreateKeyAttributes(api, c.token, c.tokenProfile);
            const url = `${profileUrl(c.token, c.tokenProfile)}/keys/keyPair`;
            const name = regName(`k11-aes-${Date.now().toString(36)}`);
            const body = keyCreateBody(defs, name, { family: 'rsa-2048' }, []);
            body.attributes = (body.attributes as Json[]).filter((a) => a.name !== SCP_ATTR.rsaKeySize.name).map((a) =>
                a.name === SCP_ATTR.keyAlgorithm.name ? { ...a, content: [{ reference: 'AES', data: 'AES' }] } : a);
            const res = await api.post(url, { data: body });
            const text = await res.text();
            if (res.status() < 400) {
                // Ledger before assertion: an accepted create made a key that the run must own and remove.
                made.push(recordCreated('keys', { uuid: String((JSON.parse(text) as Json).uuid), name }, SPEC, 'AES create accepted (observation)', { token: c.token.uuid, tokenProfile: c.tokenProfile.uuid }));
            }
            testInfo.annotations.push({ type: 'refusal', description: `AES create: ${res.status()} ${text.slice(0, 120)}` });
            test.fail(true, 'software-cryptography-provider#147: an algorithm the connector cannot create answers 502 (connector 500) instead of a 4xx');
            expect([400, 422], text.slice(0, 300)).toContain(res.status());
            expect(await keysNamed(api, name), `no key named ${name} was left behind`).toEqual([]);
        });
});
