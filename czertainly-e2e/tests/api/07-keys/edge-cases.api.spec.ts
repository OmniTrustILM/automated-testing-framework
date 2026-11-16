/**
 * API-KEY-25, API-KEY-26 — a certificate issued for the run token key carries its public key; the PKCS#11 token matrix (ilm#431).
 * API-KEY-26 is test.fixme until the PKCS#11 token chain (a vault-backed PIN secret) exists on a tier.
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/areas/ownKeys';
import { AttributeDefinition, AttributeOption, FAMILIES, Family, offeredAlgorithms, signVariants } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import { cipherOutputOf, cipherWithItem, itemRef, listEncryptAttributes, listSignAttributes, signatureAttributesFor, signatureOf, signWithItem, verificationOf, verifyWithItem } from '../../../utils/regression/platform/keyOperations';
import { createOwnKey, getKey, itemOf, KeyChain, listCreateKeyAttributes } from '../../../utils/regression/platform/keys';
import { createOwnToken, createOwnTokenProfile, enableOwnTokenProfile } from '../../../utils/regression/platform/tokens';
import { requestAttributesFrom } from '../../../utils/regression/customAttributes';
import { sha256FingerprintOfPem } from '../../../utils/regression/pkiBuilders';
import { apiJson } from '../../../utils/regression/apiReads';
import { ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { API_TOKEN_MATRIX_TEST_MS, ISSUED_WAIT_MS, ISSUE_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';
import { connectorVersion } from '../../../utils/regression/platform/connectorApi';
import type { JsonObject } from '../../../utils/regression/json';
import { readAnswer, send } from '../../../utils/regression/inventory/searchApi';
import { settings } from '../../../utils/regression/run/settings';

/** The CSR attributes of the platform-built request: the common name goes into the attribute named like `commonName` / `cn`. */
async function csrAttributesFor(api: GuardedApi, commonName: string): Promise<JsonObject[]> {
    const defs = await apiJson<AttributeDefinition[]>(api, 'GET', '/api/v1/certificates/csr/attributes');
    const values: Record<string, unknown> = {};
    for (const d of defs) if (/commonName|^cn$|common_name/i.test(String(d.name))) values[d.name] = commonName;
    return requestAttributesFrom(defs, values, commonName);
}

test.describe('Key edge rows', { tag: tags.api }, () => {
    test('a certificate issued for a token key carries that key\'s public key',
        testMeta({
            id: 'API-KEY-25', prio: 'P1', issue: 'ilm#431', phaseB: true, needs: 'ca',
            rule: [
                'a platform-built request on a v2 token; issue from a platform key; the certificate detail answers 200 (core#2508: the 500 needed v2-version definition rows under v3 content, not reproduced for new certificates since core acf3ba2)',
                'core#2321 / core#2355: the request names its signature algorithm (signatureAttributes, the key\'s sign selection); an empty one is refused',
            ],
        }),
        async ({ api, own, ownRaProfile: ra, ownKeys }, testInfo) => {
            test.setTimeout(ISSUE_MS);
            const c = await ownKeys.chain();
            const commonName = ownName('tkc');
            const signatureAttributes = signatureAttributesFor(await listSignAttributes(api, itemRef(c, 'private')), signVariants('rsa-2048')[0]);
            expect(signatureAttributes, 'the RSA PKCS#1 SHA-256 sign selection is offered').toBeDefined();
            const issued = await send(api, 'POST', `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}/certificates`, {
                data: {
                    keyUuid: c.key.uuid,
                    tokenProfileUuid: c.tokenProfile.uuid,
                    csrAttributes: await csrAttributesFor(api, commonName),
                    signatureAttributes: signatureAttributes!,
                    issueAttributes: [],
                    customAttributes: [],
                },
            });
            // The real answer is recorded before anything is asserted; a refused or id-less answer fails after its record.
            const certificate = await test.step('Record the issued certificate from the answer', async () => {
                const certificate = own.record('certificates', { status: issued.status, uuid: (issued.json as JsonObject | undefined)?.uuid as string | undefined, text: issued.text }, { name: commonName, note: 'issued from the run token key', parents: { authority: ra.authorityUuid, raProfile: ra.uuid, key: c.key.uuid } });
                testInfo.annotations.push({ type: 'certificate-uuid', description: certificate.uuid });
                return certificate;
            });
            await test.step('The certificate reaches issued', async () => {
                await waitForCertificateState(api, certificate.uuid, 'issued', ISSUED_WAIT_MS);
            });
            await test.step('The certificate is linked to the run key and carries its public key algorithm', async () => {
                const detail = await apiJson<JsonObject>(api, 'GET', `/api/v1/certificates/${certificate.uuid}`);
                expect(String(detail.state).toLowerCase()).toBe('issued');
                expect((detail.key as JsonObject | undefined)?.uuid, 'the certificate is linked to the run key').toBe(c.key.uuid);
                const keyDetail = await getKey(api, c.key.uuid);
                const pub = itemOf(keyDetail, 'public');
                expect(pub, 'the key has a public item').toBeTruthy();
                expect(detail.certificateContent, 'the certificate detail carries its content').toBeTruthy();
                const certificateDer = Buffer.from(String(detail.certificateContent).replace(/-----[^-]+-----|\s/g, ''), 'base64');
                const certificateSpki = new crypto.X509Certificate(certificateDer).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
                expect(certificateSpki, 'the certificate carries the key\'s public key').toBe(Buffer.from(String(pub!.keyData), 'base64').toString('base64'));
                testInfo.annotations.push({ type: 'certificate-fingerprint', description: sha256FingerprintOfPem(String(detail.certificateContent)) });
            });
        });

    test.fixme('a PKCS#11 token generates, signs and encrypts with the RSA and EC keys it supports',
        testMeta({ id: 'API-KEY-26', prio: 'P1', issue: 'ilm#431', needs: 'pkcs11', bug: 'pkcs11-cryptography-provider#107', rule: ['PKCS#11 column of the algorithm matrix (RSA 3072 only on PKCS#11; SoftHSM: RSA and ECDSA only, ilm#415); the PKCS#11 provider declares STATELESS only: no import / export; pkcs11-cryptography-provider#107'] }),
        async ({ api, own }, testInfo) => {
            test.setTimeout(API_TOKEN_MATRIX_TEST_MS);
            testInfo.annotations.push({ type: 'fixme', description: 'the PKCS#11 token chain (a vault-backed PIN secret) does not exist yet — runs once it does' });
            const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors');
            const wanted = settings().pkcs11Connector;
            const p11 = rows.find((r) => r.name === wanted && r.status === 'connected');
            expect(p11, `the connected PKCS#11 cryptography connector (${wanted}) that the pkcs11 need resolved`).toBeTruthy();
            const v = await connectorVersion(api, String(p11!.uuid));
            const connector = { uuid: String(p11!.uuid), name: String(p11!.name), version: (v.version ?? 2) as 1 | 2 };
            const token = await createOwnToken(api, own.spec, 'p11', { connector });
            const profile = await createOwnTokenProfile(api, own.spec, 'p11tp', { token });
            await enableOwnTokenProfile(api, token, profile);
            const chain: KeyChain = { connector, provider: 'pkcs11', token, tokenProfile: profile, key: { uuid: '', name: '', kind: 'own' } };
            const offered = offeredAlgorithms(await listCreateKeyAttributes(api, token, profile));
            expect(offered).toEqual(expect.arrayContaining(['RSA', 'ECDSA']));
            expect(offered).not.toContain('FALCON');
            expect(offered, 'SoftHSM reports no ML-DSA').not.toContain('ML-DSA');
            test.fail(true, 'pkcs11-cryptography-provider#107: SoftHSM refuses OAEP with SHA-2');
            for (const family of ['rsa-2048', 'rsa-3072', 'rsa-4096', 'ec-p256', 'ec-p384', 'ec-p521'] as Family[]) {
                await test.step(FAMILIES[family].label, async () => {
                    const key = await createOwnKey(api, own.spec, `p11-${family}`, { chain, family, enabled: true });
                    const priv = itemRef(chain, 'private', key);
                    const pub = itemRef(chain, 'public', key);
                    const sig = signatureAttributesFor(await listSignAttributes(api, priv), signVariants(family)[0]) ?? [];
                    const data = Buffer.from(`${own.spec}-${family}`).toString('base64');
                    const s = await signWithItem(api, priv, data, sig);
                    expect(s.status(), await s.text()).toBe(200);
                    const ver = await verifyWithItem(api, pub, data, signatureOf(await s.json())!, sig);
                    expect(verificationOf(await ver.json()), `${family}: the signature verifies`).toBe(true);
                    if (FAMILIES[family].algorithm === 'RSA') {
                        const defs = await listEncryptAttributes(api, pub);
                        const options = defs[0]?.content ?? [];
                        const pkcs1 = options.find((o) => /PKCS1/i.test(String(o.reference ?? o.data)));
                        const oaep = options.find((o) => /OAEP/i.test(String(o.reference ?? o.data)) && /256/.test(String(o.reference ?? o.data)));
                        const attrs = (o: AttributeOption | undefined) => (o ? [{ name: defs[0].name, uuid: defs[0].uuid, version: 'v2', contentType: defs[0].contentType ?? 'string', content: [o] }] : []);
                        const e = await cipherWithItem(api, pub, 'encrypt', data, attrs(pkcs1));
                        expect(e.status(), `${family}: PKCS1 encrypt`).toBe(200);
                        const d = await cipherWithItem(api, priv, 'decrypt', cipherOutputOf(await e.json())!, attrs(pkcs1));
                        expect(cipherOutputOf(await d.json()), `${family}: decrypt returns the plain data`).toBe(data);
                        const oe = await cipherWithItem(api, pub, 'encrypt', data, attrs(oaep));
                        expect(oe.status(), 'OAEP-SHA-256 round trip').toBe(200);
                    }
                });
            }
            await test.step('no import / export surface (STATELESS)', async () => {
                const p = await readAnswer(api, `/api/v1/tokens/${token.uuid}/tokenProfiles/${profile.uuid}/keys/keyPair/import/attributes`);
                expect(p.status, p.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
            });
        });
});
