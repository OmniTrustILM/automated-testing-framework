/**
 * API-KEY-01, API-KEY-07 — An own token on the v2 software provider and an own token profile. ilm#431.
 *
 * WHAT: 1. POST /v1/tokens (a v2 record, no kind) → 200; the detail shows the name and connectorUuid as sent, no kind and a v2 status word
 *          (never a v1 activation word); after the first key exists a reload (PATCH) reports Connected; the token is in the list and names
 *          its connector.
 *       2. A token profile created with sign, verify, encrypt and decrypt is disabled and stores the usages as submitted; enable (twice,
 *          idempotent), disable and a PUT of the usages [sign, verify] change the stored state.
 * WHY: token create starts at status UNKNOWN and is refreshed from the connector; the detail and the reload persist the connector status.
 *      The v2 vocabulary is CONNECTED, DISCONNECTED, WARNING and UNKNOWN only; the software provider v2 creates the token lazily (no
 *      activation step) and the
 *      interface version is kept for the life of the object. A profile's enabled flag defaults to false and gates key creation only; usages
 *      round trip as JSONB.
 * HOW: own token, profile and key (run-prefixed names, recorded in the ledger by the helpers). The first test also seeds the run's shared
 *      key chain when no spec has made one yet. Without a connected v2 software cryptography connector (REG_CRYPTO_CONNECTOR_V2) both tests
 *      skip by name.
 */
import { expect, test } from '../../../fixtures/areas/ownKeys';
import { PROFILE_USAGES, sameUsages } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { createOwnKey } from '../../../utils/regression/platform/keys';
import { createOwnToken, createOwnTokenProfile, disableOwnTokenProfile, enableOwnTokenProfile, getOwnToken, getTokenProfile, reloadOwnToken, tokenStatusOf, updateOwnTokenProfileUsages, V1_ONLY_TOKEN_STATUSES, V2_TOKEN_STATUSES } from '../../../utils/regression/platform/tokens';
import { apiJson } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { JsonObject } from '../../../utils/regression/json';
import { API_OWN_OBJECTS_TEST_MS, API_STANDARD_TEST_MS } from '../../../utils/regression/timeouts';

test.describe('Tokens and token profiles', { tag: tags.api }, () => {
    test('an own v2 software token is stored as sent, shows a v2 status and is listed',
        testMeta({
            id: 'API-KEY-01', prio: 'P1', issue: 'ilm#431',
            rule: [
                'token create: initial status UNKNOWN, refreshed from the connector; detail GET and PATCH reload persist the connector status',
                'v2 status vocabulary CONNECTED / DISCONNECTED / WARNING / UNKNOWN only; software-cryptography-provider v2 creates the token lazily: no activation step; the interface version is kept for the life of the object',
            ],
        }),
        async ({ api, own, ownKeys }, testInfo) => {
            test.setTimeout(API_STANDARD_TEST_MS);
            const connector = await ownKeys.connector(2);

            const token = await test.step('POST /v1/tokens (v2 record, no kind) → 200, recorded', async () => createOwnToken(api, own.spec, 'tok', { connector }));

            const detail = await test.step('Detail: name and connectorUuid as sent, no kind, a v2 status word', async () => {
                const d = await getOwnToken(api, token);
                expect(d.name).toBe(token.name);
                expect(d.connectorUuid).toBe(connector.uuid);
                expect(d.kind ?? null, 'a v2 token carries no kind').toBeNull();
                const status = tokenStatusOf(d);
                testInfo.annotations.push({ type: 'token-status-after-create', description: String(status) });
                expect(V1_ONLY_TOKEN_STATUSES, `status ${status} is never a v1 activation word`).not.toContain(status);
                expect(V2_TOKEN_STATUSES, `status ${status} is a v2 word`).toContain(status);
                return d;
            });

            await test.step('After the first key exists, PATCH /v1/tokens/{uuid} (reload) reports Connected', async () => {
                const profile = await createOwnTokenProfile(api, own.spec, 'tp', { token, usages: PROFILE_USAGES });
                await enableOwnTokenProfile(api, token, profile);
                const key = await createOwnKey(api, own.spec, 'key', { chain: { token, tokenProfile: profile }, family: 'rsa-2048' });
                const reloaded = await reloadOwnToken(api, token);
                expect(tokenStatusOf(reloaded), 'status after the first key and a reload').toBe('Connected');
                // The run's shared key chain, when no spec made one yet.
                ownKeys.shareAsRunChain({ token, tokenProfile: profile, key: { uuid: key.uuid, name: key.name, kind: 'own', keyItems: key.keyItems } });
            });

            await test.step('The token is in the list', async () => {
                const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/tokens');
                expect(rows.map((r) => String(r.uuid))).toContain(token.uuid);
                expect(detail.connectorName, 'the list / detail name the connector').toBe(connector.name);
            });
        });

    test('a token profile is created disabled with its usages, and enable, disable and usages work',
        testMeta({
            id: 'API-KEY-07', prio: 'P1', issue: 'ilm#431',
            rule: [
                'AddTokenProfileRequestDto: enabled defaults to false; usages stored as submitted, JSONB round trip; TokenProfileWriter',
                'the enabled flag gates key creation only; enable / disable endpoints',
            ],
        }),
        async ({ api, own, ownKeys }) => {
            test.setTimeout(API_OWN_OBJECTS_TEST_MS);
            const connector = await ownKeys.connector(2);
            const token = ownKeys.runToken() ?? (await createOwnToken(api, own.spec, 'tok', { connector }));

            const profile = await test.step('POST …/tokenProfiles with sign, verify, encrypt, decrypt → enabled false, usages as submitted', async () => {
                const p = await createOwnTokenProfile(api, own.spec, 'tp07', { token, usages: PROFILE_USAGES, enabled: false });
                const d = await getTokenProfile(api, token, p);
                expect(d.enabled).toBe(false);
                expect(sameUsages(d.usages ?? [], PROFILE_USAGES), `usages ${JSON.stringify(d.usages)} equal the submitted set`).toBe(true);
                return p;
            });

            await test.step('PATCH …/enable → enabled true; a second enable is idempotent', async () => {
                await enableOwnTokenProfile(api, token, profile);
                expect((await getTokenProfile(api, token, profile)).enabled).toBe(true);
                await enableOwnTokenProfile(api, token, profile);
                expect((await getTokenProfile(api, token, profile)).enabled).toBe(true);
            });

            await test.step('PATCH …/disable → enabled false', async () => {
                await disableOwnTokenProfile(api, token, profile);
                expect((await getTokenProfile(api, token, profile)).enabled).toBe(false);
            });

            await test.step('PUT …/usages [sign, verify] → the stored usages change', async () => {
                await updateOwnTokenProfileUsages(api, token, profile, ['sign', 'verify']);
                const d = await getTokenProfile(api, token, profile);
                expect(sameUsages(d.usages ?? [], ['sign', 'verify']), `usages ${JSON.stringify(d.usages)}`).toBe(true);
            });
        });
});
