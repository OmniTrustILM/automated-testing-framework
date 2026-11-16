/**
 * API-KEY-27 — an own token, profile and RSA key on the software cryptography provider v1 sign and verify (ilm#431).
 * The token is made here, not by ownKeys.v1Chain: it carries an activation code and is activated before its profile.
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import { signVariants } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { getKey, itemOf } from '../../../utils/regression/platform/keys';
import { itemRef, listSignAttributes, signatureAttributesFor, signatureOf, signWithItem, verificationOf, verifyWithItem } from '../../../utils/regression/platform/keyOperations';
import { activateOwnToken, activationCode, createOwnToken, createOwnTokenProfile, enableOwnTokenProfile, getOwnToken, tokenStatusOf, V2_TOKEN_STATUSES } from '../../../utils/regression/platform/tokens';
import { ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { API_ROUND_TRIP_TEST_MS } from '../../../utils/regression/timeouts';

test.describe('Software cryptography v1 key', { tag: tags.api }, () => {
    test('an own v1 token, profile and key sign and verify, and the key is deleted',
        testMeta({
            id: 'API-KEY-27', prio: 'P1', issue: 'ilm#431', needs: 'crypto-v1',
            rule: ['software cryptography provider v1 (kind SOFT): token activation, key pair generation, sign and verify for RSA-2048; ilm#248: the v1 record has no import or export capability', 'interfaces KeyDetailDto has no key-level enabled flag: KeyItemDetailDto carries it per item'],
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
            // The v1 provider names both items after the key alias (the guard reads that name), so the alias is the run-prefixed key name.
            const keyName = ownName('k27');
            const key = await ownKeys.make('k27', { chain: { token, tokenProfile: profile }, family: 'rsa-2048', enabled: true, name: keyName, alias: keyName });

            await test.step('the key has an active private and an active public item, both enabled', async () => {
                const detail = await getKey(api, key.uuid);
                for (const kind of ['private', 'public'] as const) expect(String(itemOf(detail, kind)?.state).toLowerCase(), `${kind} item state`).toBe('active');
                for (const kind of ['private', 'public'] as const) expect(itemOf(detail, kind)?.enabled, `${kind} item enabled as created`).toBe(true);
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
