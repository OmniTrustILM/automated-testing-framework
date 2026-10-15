/**
 * API-KEY-01 / API-KEY-07 — own token (software provider, interface v2) and own token profile (ilm#431, T7; platform area).
 *
 * Shared tier, own objects only: the token and the profile are created through the guarded `api` fixture and recorded
 * before any assertion; nothing pre-existing is touched (the connector is only referenced). The run-end teardown deletes
 * the key, the profile and the token (DELETE_ORDER steps 5 and 10). Without a connected software cryptography connector
 * of interface v2 the tests skip with the named reason (deploy gate, never a pass).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { PROFILE_USAGES, sameUsages } from '../../utils/regression/cryptoMatrix';
import {
    createOwnKey, createOwnToken, createOwnTokenProfile, disableOwnTokenProfile, enableOwnTokenProfile, findCryptoConnector, getOwnToken, getTokenProfile, reloadOwnToken,
    tokenStatusOf, updateOwnTokenProfileUsages, V1_ONLY_TOKEN_STATUSES, V2_TOKEN_STATUSES,
} from '../../utils/regression/keyApi';
import { apiJson } from '../../utils/regression/regressionApi';
import { readState, updateState } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-KEY-01-08';
type Json = Record<string, any>;

test.describe('API-KEY tokens and token profiles', { tag: tags.api }, () => {
    test('API-KEY-01: an own token on the software provider (interface v2): no kind, name and connector as sent, a v2 status word, Connected after the first key, listed',
        meta({
            id: 'API-KEY-01', prio: 'P1', issue: 'ilm#431',
            rule: [
                'platform-keys-connectors A2 r1 (token create: initial status UNKNOWN, refreshed from the connector), r2 (detail GET and PATCH reload persist the connector status)',
                'platform-keys-connectors A2 r4 (v2 status vocabulary CONNECTED / DISCONNECTED / WARNING / UNKNOWN only; SCP v2 creates the token lazily: no activation step); DECK (interface version for life)',
            ],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(120_000);
            const connector = await findCryptoConnector(api, 2);
            test.skip(!connector, 'no connected software cryptography connector of interface v2 is registered on this tier (REG_CRYPTO_CONNECTOR_V2)');

            const token = await test.step('POST /v1/tokens (v2 record, no kind) → 200, recorded', async () => createOwnToken(api, connector!, `tok-${Date.now().toString(36)}`, SPEC));

            const detail = await test.step('Detail: name and connectorUuid as sent, no kind, a v2 status word', async () => {
                const d = await getOwnToken(api, token);
                expect(d.name).toBe(token.name);
                expect(d.connectorUuid).toBe(connector!.uuid);
                expect(d.kind ?? null, 'a v2 token carries no kind').toBeNull();
                const status = tokenStatusOf(d);
                testInfo.annotations.push({ type: 'token-status-after-create', description: String(status) });
                expect(V1_ONLY_TOKEN_STATUSES, `status ${status} is never a v1 activation word`).not.toContain(status);
                expect(V2_TOKEN_STATUSES, `status ${status} is a v2 word`).toContain(status);
                return d;
            });

            await test.step('After the first key exists, PATCH /v1/tokens/{uuid} (reload) reports Connected', async () => {
                const profile = await createOwnTokenProfile(api, token, `tp-${Date.now().toString(36)}`, SPEC, { usages: PROFILE_USAGES });
                await enableOwnTokenProfile(api, token, profile);
                const key = await createOwnKey(api, { token, tokenProfile: profile }, `key-${Date.now().toString(36)}`, SPEC, { family: 'rsa-2048' });
                const reloaded = await reloadOwnToken(api, token);
                expect(tokenStatusOf(reloaded), 'status after the first key and a reload').toBe('Connected');
                // The run's shared chain (ensure:key-chain) when no spec made one yet.
                const state = readState();
                if (!state.token) updateState({ token, tokenProfile: profile, key: { uuid: key.uuid, name: key.name, kind: 'own', keyItems: key.keyItems } });
            });

            await test.step('The token is in the list', async () => {
                const rows = await apiJson<Json[]>(api, 'GET', '/api/v1/tokens');
                expect(rows.map((r) => String(r.uuid))).toContain(token.uuid);
                expect(detail.connectorName, 'the list / detail name the connector').toBe(connector!.name);
            });
        });

    test('API-KEY-07: a token profile is created disabled with its usages as submitted; enable is idempotent, disable works, PUT usages changes the stored set',
        meta({
            id: 'API-KEY-07', prio: 'P1', issue: 'ilm#431',
            rule: [
                'platform-keys-connectors A2 r7 (AddTokenProfileRequestDto: enabled defaults to false; usages stored as submitted, JSONB round trip; TokenProfileWriter:68-70)',
                'platform-keys-connectors A2 r8 (the enabled flag gates key creation only; enable / disable endpoints)',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const connector = await findCryptoConnector(api, 2);
            test.skip(!connector, 'no connected software cryptography connector of interface v2 is registered on this tier (REG_CRYPTO_CONNECTOR_V2)');
            const token = readState().token ?? (await createOwnToken(api, connector!, `tok-${Date.now().toString(36)}`, SPEC));

            const profile = await test.step('POST …/tokenProfiles with sign, verify, encrypt, decrypt → enabled false, usages as submitted', async () => {
                const p = await createOwnTokenProfile(api, token, `tp07-${Date.now().toString(36)}`, SPEC, { usages: PROFILE_USAGES, enabled: false });
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
