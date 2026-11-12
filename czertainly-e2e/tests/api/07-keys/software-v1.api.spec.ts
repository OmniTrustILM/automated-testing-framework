/**
 * API-KEY-27 — A key on the software cryptography provider v1 signs and verifies. ilm#431.
 *
 * WHAT: 1. An own token of kind SOFT on the v1 connector is created and, when the connector reports it as deactivated, activated with the
 *          code it was created with; its status is a v1 word.
 *       2. An own token profile is enabled and an own RSA-2048 key pair is created on it: a private and a public item, both ACTIVE; the
 *          key is enabled.
 *       3. The private item signs random data (200 with a signature), the public item verifies it (true), and verifies tampered data
 *          (false).
 *       4. The key is deleted at the end of the test.
 * WHY: the positive v1 path was covered only by the smoke test; the algorithm matrix lists the v1 provider (generate, sign, verify and RSA
 *      encrypt for RSA-2048) but no row made a v1 key, and the v1 import and export rows only check refusals.
 * HOW: the row declares the `crypto-v1` need, decided from the connector list before anything is written; every object is an own object
 *      recorded in the ledger from the create answer, the key is deleted by the test's own fixture, the profile and token by the run-end
 *      teardown. Env: REG_CRYPTO_CONNECTOR_V1 (the connector to use).
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import { signVariants } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { enableOwnKey, getKey, itemOf } from '../../../utils/regression/platform/keys';
import { itemRef, listSignAttributes, signatureAttributesFor, signatureOf, signWithItem, verificationOf, verifyWithItem } from '../../../utils/regression/platform/keyOperations';
import { activateOwnToken, activationCode, createOwnToken, createOwnTokenProfile, enableOwnTokenProfile, getOwnToken, tokenStatusOf, V2_TOKEN_STATUSES } from '../../../utils/regression/platform/tokens';
import { testMeta, tags } from '../../../utils/regression/tags';
import { API_ROUND_TRIP_TEST_MS } from '../../../utils/regression/timeouts';

test.describe('Software cryptography v1 key', { tag: tags.api }, () => {
    test('an own v1 token, profile and key sign and verify, and the key is deleted',
        testMeta({
            id: 'API-KEY-27', prio: 'P1', issue: 'ilm#431', needs: 'crypto-v1',
            rule: ['software cryptography provider v1 (kind SOFT): token activation, key pair generation, sign and verify for RSA-2048; ilm#248: the v1 record has no import or export capability'],
        }),
        async ({ api, own, ownKeys }, testInfo) => {
            test.setTimeout(API_ROUND_TRIP_TEST_MS);
            const v1 = await ownKeys.connector(1);
            const code = activationCode();
            const token = await createOwnToken(api, own.spec, 'tokv1', { connector: v1, kind: 'SOFT', code });

            await test.step('the token is active (activated with its own code when the connector reports it deactivated)', async () => {
                let status = tokenStatusOf(await getOwnToken(api, token));
                if (status === 'Deactivated') {
                    await activateOwnToken(api, token, code);
                    status = tokenStatusOf(await getOwnToken(api, token));
                }
                testInfo.annotations.push({ type: 'token-status', description: `v1 token status ${String(status)}` });
                expect([...V2_TOKEN_STATUSES, 'Activated'], 'a token status of the platform vocabulary').toContain(status);
                expect(status, 'the token is not deactivated').not.toBe('Deactivated');
            });
            const profile = await createOwnTokenProfile(api, own.spec, 'tpv1', { token });
            await enableOwnTokenProfile(api, token, profile);
            const key = await ownKeys.make('k27', { chain: { token, tokenProfile: profile }, family: 'rsa-2048', enabled: true });

            await test.step('the key has an active private and an active public item and is enabled', async () => {
                const detail = await getKey(api, key.uuid);
                for (const kind of ['private', 'public'] as const) expect(String(itemOf(detail, kind)?.state).toLowerCase(), `${kind} item state`).toBe('active');
                if (detail.enabled !== true) await enableOwnKey(api, key);
                expect((await getKey(api, key.uuid)).enabled, 'the key is enabled').toBe(true);
            });
            await test.step('the private item signs and the public item verifies, and refuses tampered data', async () => {
                const chain = { connector: v1, provider: 'scp-v1' as const, token, tokenProfile: profile, key };
                const priv = itemRef(chain, 'private', key);
                const pub = itemRef(chain, 'public', key);
                const attributes = signatureAttributesFor(await listSignAttributes(api, priv), signVariants('rsa-2048')[0]);
                expect(attributes, 'the v1 connector offers the RSA-2048 signature algorithm').toBeDefined();
                const data = crypto.randomBytes(64);
                const signed = await signWithItem(api, priv, data.toString('base64'), attributes!);
                expect(signed.status(), await signed.text()).toBe(200);
                const signature = signatureOf(await signed.json());
                expect(signature, 'the answer carries a signature').toBeTruthy();
                const ok = await verifyWithItem(api, pub, data.toString('base64'), signature!, attributes!);
                expect(ok.status(), await ok.text()).toBe(200);
                expect(verificationOf(await ok.json()), 'the signature verifies').toBe(true);
                const tampered = Buffer.from(data);
                tampered[0] ^= 0xff;
                const bad = await verifyWithItem(api, pub, tampered.toString('base64'), signature!, attributes!);
                expect(bad.status(), await bad.text()).toBe(200);
                expect(verificationOf(await bad.json()), 'tampered data does not verify').toBe(false);
            });
        });
});
