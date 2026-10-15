/**
 * REG-PROT-01 — ACME issue and revoke with the in-repo RFC 8555 client (ilm#430 steps 1 and 2; release rule R1a–c).
 *
 * Flow: the run ACME profile (one pre-authorized DNS identifier) activated on an own RA profile of the run → a FRESH
 * account → new-order for the pre-authorized name → `ready` at creation, authorization `valid` with no challenge →
 * finalize → `valid` → download → the certificate is in the inventory under the run RA profile with protocol ACME →
 * `revoke-cert` signed with the ACCOUNT key (`kid`) → 200 with an empty body → the inventory shows it `revoked`
 * with the history "Certificate revoked. Reason: Unspecified" → a second revoke → 400 problem+json `alreadyRevoked`.
 *
 * S-own: the revoke acts on a certificate this run made (adopted by its run-prefixed CN right after the order
 * settled, ledger before assertion; its linked `certKey_` key recorded as derived with `createdAfter` from the
 * new-order response's Date). The run-end teardown deletes the certificate (already revoked), the key, the account
 * (with its profile) and deactivates ACME on the own RA profile. Nothing pre-existing is touched.
 */
import { waitForCertificateState } from '../../utils/certificateUtils';
import { expect, test } from '../../fixtures/testFixtures';
import { AcmeClient } from '../../utils/regression/acmeClient';
import { csrWithSan, firstPem, sha256FingerprintOfPem } from '../../utils/regression/pki';
import { isProblemJson } from '../../utils/regression/protocolHttp';
import { certificateFacts, pemToDer } from '../../utils/regression/protocolPki';
import {
    apiJson, ensureAcmeOnRaProfile, getCertificate, orSkipWithoutCa, recordAcmeAccount, recordCertificatesNamed, recordDerivedKeyOf, searchCertificates,
    serverCreatedAfter,
} from '../../utils/regression/regressionApi';
import { createdAfterFrom, regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-PROT-01';
const skip = (reason: string) => test.skip(true, reason);

type Json = Record<string, any>;

test.describe('@regression REG-PROT-01 ACME issue and revoke', () => {
    test('REG-PROT-01: a fresh account orders the pre-authorized name on the RA-profile directory, finalizes, downloads and revokes with its account key; a second revoke is alreadyRevoked',
        meta({
            id: 'REG-PROT-01', prio: 'P1', issue: 'ilm#430',
            rule: [
                'ilm#430 steps 1–2 (T6-1, T6-2): order through the directory → issued; revoke with the client → REVOKED in core',
                'protocols §4.2 r16–r19: pre-authorized identifier → authorization valid, no challenges, order ready at creation (core#2231)',
                'protocols §4.2 r25–r27: finalize needs ready; valid when ISSUED; download application/pem-certificate-chain (RFC 8555 §7.4)',
                'protocols §4.2 r29: revoke-cert with the account key (kid): the certificate must be ACME-issued to that account; success 200 empty; already revoked → 400 alreadyRevoked (RFC 8555 §7.6); reason null → unspecified',
                'cert-lifecycle: history "Certificate revoked. Reason: Unspecified" (ClientOperationServiceImpl, CertificateRevocationReason.UNSPECIFIED label)',
            ],
        }),
        async ({ api }) => {
            // One order to valid (client order wait up to 120 s), a download, two revokes and a state wait (≤ 60 s).
            test.setTimeout(300_000);
            const { raProfile, acmeProfile, directoryUrl } = await test.step('Prerequisite: ACME profile activated on an own RA profile of the run', async () =>
                orSkipWithoutCa(ensureAcmeOnRaProfile(api, SPEC), skip));
            const identifier = acmeProfile.identifier;
            const client = new AcmeClient(directoryUrl);

            await test.step('Directory → a fresh account (valid), recorded', async () => {
                const dir = await client.init();
                expect(dir.revokeCert, 'directory advertises revokeCert').toBeTruthy();
                const account = await client.newAccount(`${regName('acme-prot01')}@example.test`);
                expect(account.location, 'new-account answers the account URL').toBeTruthy();
                await recordAcmeAccount(api, account.location!, acmeProfile, SPEC);
                expect(account.body.status).toBe('valid');
            });

            const order = await test.step(`new-order for ${identifier} → 201 ready; authorization valid with no challenge`, async () => {
                const res = await client.newOrder([identifier]);
                expect(res.status, JSON.stringify(res.body)).toBe(201);
                expect(res.body.status).toBe('ready');
                const authz = await client.get(res.body.authorizations[0]);
                expect(authz.body.status).toBe('valid');
                expect(authz.body.challenges ?? [], 'a pre-authorized identifier gets no challenge').toEqual([]);
                return { url: res.location!, body: res.body, date: res.date };
            });

            const csr = csrWithSan(identifier, [identifier]);
            const { pem, mine } = await test.step('finalize → valid within 120 s → download', async () => {
                const before = new Set((await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: identifier }], 100)).map((r) => String(r.uuid)));
                const fin = await client.finalize(order.body.finalize, csr.derBase64Url);
                expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
                const done = await client.waitForOrder(order.url, 120_000);
                // Ledger before assertion: every certificate of the identifier and its linked key (derived, server clock).
                const createdAfter = order.date ? createdAfterFrom(order.date) : await serverCreatedAfter(api);
                const uuids = await recordCertificatesNamed(api, identifier, SPEC, 'issued via ACME (REG-PROT-01)');
                for (const uuid of uuids) await recordDerivedKeyOf(api, uuid, createdAfter, SPEC);
                expect(done.status, JSON.stringify(done)).toBe('valid');
                return { pem: firstPem(await client.downloadCertificate(done.certificate)), mine: uuids.filter((u) => !before.has(u)) };
            });

            const certUuid = await test.step('Inventory: found by fingerprint, RA profile = the run RA profile, protocol ACME', async () => {
                const found = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: sha256FingerprintOfPem(pem) }]);
                expect(found.length).toBe(1);
                expect(mine, 'the leaf is the certificate this order made').toContain(found[0].uuid);
                const detail = await getCertificate(api, found[0].uuid);
                expect(detail.raProfile?.uuid).toBe(raProfile.uuid);
                expect(String(detail.protocolInfo?.protocol ?? '')).toMatch(/acme/i);
                expect(certificateFacts(pem).spkiBase64, 'leaf public key = CSR key').toBe(csr.spkiBase64);
                return String(found[0].uuid);
            });

            const certificateDer = pemToDer(pem).toString('base64url');
            await test.step('revoke-cert signed with the account key (kid) → 200, empty body', async () => {
                const res = await client.revokeCert(certificateDer);
                expect(res.status, JSON.stringify(res.body)).toBe(200);
                expect(String(res.body ?? '')).toBe('');
            });

            await test.step('Inventory: revoked ≤ 60 s; history "Certificate revoked. Reason: Unspecified"', async () => {
                await waitForCertificateState(api, certUuid, 'revoked', 60_000);
                // Core sets REVOKED first and writes the history entry afterwards (live run 2): poll the history.
                await expect.poll(async () => (await apiJson<Json[]>(api, 'GET', `/api/v1/certificates/${certUuid}/history`)).map((h) => String(h.message ?? '')),
                    { timeout: 15_000, intervals: [1_000], message: 'history after the revoke' }).toContain('Certificate revoked. Reason: Unspecified');
            });

            await test.step('Second revoke → 400 problem+json …:alreadyRevoked', async () => {
                const res = await client.revokeCert(certificateDer);
                expect(res.status, JSON.stringify(res.body)).toBe(400);
                expect(isProblemJson(res.contentType), `content type ${res.contentType}`).toBe(true);
                expect(String(res.body?.type ?? '')).toMatch(/:alreadyRevoked$/);
            });
        });
});
