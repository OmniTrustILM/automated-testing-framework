/**
 * API-KEY-25 / 26 — edge rows of the key area (ilm#431, T7; platform area).
 *
 * API-KEY-25 (`ensure:token-key-cert`): a certificate requested on the run's RA profile with the run's token key
 * (`keyUuid` + `tokenProfileUuid`, CSR built by the platform from `csrAttributes`) reaches `issued`; its public key is
 * the key's PUBLIC item. Today the certificate detail answers 500 for an RSA / ECDSA CSR on a v2 token (core#2508):
 * the test is `test.fail()` with the bug tag and turns red when the bug is fixed (verify live, Phase 8). The CA gate
 * (no healthy CA with a copyable RA profile) skips with the named reason.
 *
 * API-KEY-26 (`@needs:pkcs11`): the PKCS#11 matrix on a SoftHSM-backed token. The token needs a vault-backed PIN
 * secret (REG-SEC chain, B5), so the row is `test.fixme` with its full body; the preflight skips without the connector.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { AttributeDefinition, FAMILIES, Family, signVariants } from '../../utils/regression/cryptoMatrix';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import {
    cipherOutputOf, cipherWithItem, createOwnKey, createOwnToken, createOwnTokenProfile, enableOwnTokenProfile, ensureKeyChain, getKey, isSkip, itemOf, itemRef, KeyChain,
    listCreateKeyAttributes, listEncryptAttributes, listSignAttributes, signatureAttributesFor, signatureOf, signWithItem, verificationOf, verifyWithItem,
} from '../../utils/regression/keyApi';
import { requestAttributesFrom } from '../../utils/regression/platformApi';
import { sha256FingerprintOfPem } from '../../utils/regression/pki';
import { apiJson, ensureRaProfileOrSkip } from '../../utils/regression/regressionApi';
import { recordCreated, regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { offeredAlgorithms } from '../../utils/regression/cryptoMatrix';
import { connectorVersion } from '../../utils/regression/connectorApi';

const SPEC = 'API-KEY-24-29';
type Json = Record<string, any>;

/** The CSR attributes of the platform-built request: the common name goes into the attribute named like `commonName` / `cn`. */
async function csrAttributesFor(api: GuardedApi, commonName: string): Promise<Json[]> {
    const defs = await apiJson<AttributeDefinition[]>(api, 'GET', '/api/v1/certificates/csr/attributes');
    const values: Record<string, unknown> = {};
    for (const d of defs) if (/commonName|^cn$|common_name/i.test(String(d.name))) values[d.name] = commonName;
    return requestAttributesFrom(defs, values, commonName);
}

test.describe('API-KEY edge rows', { tag: tags.api }, () => {
    test('API-KEY-25: a certificate issued on the run RA profile from the run token key (keyUuid) is issued and carries the key\'s public key (core#2508: detail 500 on a v2 token today)',
        meta({
            id: 'API-KEY-25', prio: 'P1', issue: 'ilm#431', bug: 'core#2508', phaseB: true,
            rule: ['platform-keys-connectors A2 r17 (platform-built request on a v2 token), K8; core#2508 (certificate detail 500 for an RSA / ECDSA CSR on a v2 token); cert-lifecycle L§9.2 RAP-10 (issue from a platform key)'],
        }),
        async ({ api }, testInfo) => {
            test.setTimeout(240_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const chain = await ensureKeyChain(api, SPEC);
            test.skip(isSkip(chain), isSkip(chain) ? chain.skip : '');
            const c = chain as KeyChain;
            const commonName = regName(`tkc-${Date.now().toString(36)}`);
            const body = await apiJson<Json>(api, 'POST', `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/certificates`, {
                keyUuid: c.key.uuid,
                tokenProfileUuid: c.tokenProfile.uuid,
                csrAttributes: await csrAttributesFor(api, commonName),
                signatureAttributes: [],
                issueAttributes: [],
                customAttributes: [],
            });
            const certificate = recordCreated('certificates', { uuid: String(body.uuid), name: commonName }, SPEC, 'issued from the run token key', { authority: ra.authorityUuid, raProfile: ra.uuid, key: c.key.uuid });
            testInfo.annotations.push({ type: 'certificate-uuid', description: certificate.uuid });
            // Known bug on a v2 token, right before the failing step: the detail read (the wait polls it) answers 500 today.
            test.fail(c.connector.version === 2, 'core#2508: certificate detail answers 500 for an RSA / ECDSA CSR issued from a key on a v2 token');
            await waitForCertificateState(api, certificate.uuid, 'issued', 180_000);
            const detail = await apiJson<Json>(api, 'GET', `/api/v1/certificates/${certificate.uuid}`);
            expect(String(detail.state).toLowerCase()).toBe('issued');
            expect(detail.key?.uuid, 'the certificate is linked to the run key').toBe(c.key.uuid);
            const keyDetail = await getKey(api, c.key.uuid);
            const pub = itemOf(keyDetail, 'public');
            expect(pub, 'the key has a public item').toBeTruthy();
            expect(String(detail.publicKeyAlgorithm ?? detail.keyAlgorithm ?? '').toUpperCase()).toContain(String(pub!.keyAlgorithm).toUpperCase().slice(0, 3));
            if (detail.certificateContent) testInfo.annotations.push({ type: 'certificate-fingerprint', description: sha256FingerprintOfPem(String(detail.certificateContent)) });
        });

    test.fixme('API-KEY-26: PKCS#11 (SoftHSM): RSA 2048 / 3072 / 4096 and EC P-256 / 384 / 521 generate and sign / verify; ML-DSA and FALCON absent; PKCS1-v1_5 encrypt round trip; OAEP-SHA-256 refused on SoftHSM (P11#107); no import / export surface',
        meta({ id: 'API-KEY-26', prio: 'P1', issue: 'ilm#431', needs: 'pkcs11', bug: 'pkcs11-cryptography-provider#107', rule: ['platform-keys-connectors A2 matrix (PKCS#11 column), K5 (RSA 3072 only on PKCS#11; SoftHSM: RSA and ECDSA only, ilm#415 B1), r25 (P11 declares STATELESS only: no import / export); pkcs11-cryptography-provider#107'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(600_000);
            testInfo.annotations.push({ type: 'fixme', description: 'the PKCS#11 token chain (a vault-backed PIN secret, REG-SEC-08 / REG-KEY-12) does not exist yet — runs once it does' });
            const rows = await apiJson<Json[]>(api, 'GET', '/api/v1/connectors');
            const wanted = process.env.REG_PKCS11_CONNECTOR || 'PKCS11-Cryptography-Provider';
            const p11 = rows.find((r) => r.name === wanted && r.status === 'connected');
            test.skip(!p11, `no connected PKCS#11 cryptography connector (${wanted}) on this tier (REG_PKCS11_CONNECTOR)`);
            const v = await connectorVersion(api, String(p11!.uuid));
            const connector = { uuid: String(p11!.uuid), name: String(p11!.name), version: (v.version ?? 2) as 1 | 2 };
            const token = await createOwnToken(api, connector, `p11-${Date.now().toString(36)}`, SPEC);
            const profile = await createOwnTokenProfile(api, token, `p11tp-${Date.now().toString(36)}`, SPEC);
            await enableOwnTokenProfile(api, token, profile);
            const chain: KeyChain = { connector, provider: 'pkcs11', token, tokenProfile: profile, key: { uuid: '', name: '', kind: 'own' } };
            const offered = offeredAlgorithms(await listCreateKeyAttributes(api, token, profile));
            expect(offered).toEqual(expect.arrayContaining(['RSA', 'ECDSA']));
            expect(offered).not.toContain('FALCON');
            expect(offered, 'SoftHSM reports no ML-DSA').not.toContain('ML-DSA');
            test.fail(true, 'pkcs11-cryptography-provider#107: SoftHSM refuses OAEP with SHA-2');
            for (const family of ['rsa-2048', 'rsa-3072', 'rsa-4096', 'ec-p256', 'ec-p384', 'ec-p521'] as Family[]) {
                await test.step(FAMILIES[family].label, async () => {
                    const key = await createOwnKey(api, chain, `p11-${family}-${Date.now().toString(36)}`, SPEC, { family, enabled: true });
                    const priv = itemRef(chain, 'private', key);
                    const pub = itemRef(chain, 'public', key);
                    const sig = signatureAttributesFor(await listSignAttributes(api, priv), signVariants(family)[0]) ?? [];
                    const data = Buffer.from(`${SPEC}-${family}`).toString('base64');
                    const s = await signWithItem(api, priv, data, sig);
                    expect(s.status(), await s.text()).toBe(200);
                    const ver = await verifyWithItem(api, pub, data, signatureOf(await s.json())!, sig);
                    expect(verificationOf(await ver.json())).toBe(true);
                    if (FAMILIES[family].algorithm === 'RSA') {
                        const defs = await listEncryptAttributes(api, pub);
                        const options = (defs[0]?.content ?? []) as Json[];
                        const pkcs1 = options.find((o) => /PKCS1/i.test(String(o.reference ?? o.data)));
                        const oaep = options.find((o) => /OAEP/i.test(String(o.reference ?? o.data)) && /256/.test(String(o.reference ?? o.data)));
                        const attrs = (o: Json | undefined) => (o ? [{ name: defs[0].name, uuid: defs[0].uuid, version: 'v2', contentType: defs[0].contentType ?? 'string', content: [o] }] : []);
                        const e = await cipherWithItem(api, pub, 'encrypt', data, attrs(pkcs1));
                        expect(e.status()).toBe(200);
                        const d = await cipherWithItem(api, priv, 'decrypt', cipherOutputOf(await e.json())!, attrs(pkcs1));
                        expect(cipherOutputOf(await d.json())).toBe(data);
                        const oe = await cipherWithItem(api, pub, 'encrypt', data, attrs(oaep));
                        expect(oe.status(), 'OAEP-SHA-256 round trip').toBe(200);
                    }
                });
            }
            await test.step('no import / export surface (STATELESS)', async () => {
                const res = await api.get(`/api/v1/tokens/${token.uuid}/tokenProfiles/${profile.uuid}/keys/keyPair/import/attributes`);
                expect(res.status()).toBeGreaterThanOrEqual(400);
            });
        });
});
