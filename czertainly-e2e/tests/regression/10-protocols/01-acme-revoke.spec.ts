/**
 * REG-PROT-01 — ACME issue and revoke with the in-repo RFC 8555 client. ilm#430, core#2231.
 *
 * WHAT: 1. A fresh ACME account on the run's directory → valid.
 *       2. new-order for the pre-authorized name → 201 ready; the authorization is valid with no challenge.
 *       3. Finalize with a CSR → the order is valid within 120 s → download the certificate chain.
 *       4. The inventory finds it by fingerprint on the run RA profile with protocol ACME, and the public key is the CSR's.
 *       5. revoke-cert signed with the account key → 200, empty body; the inventory shows Revoked within 60 s with the history
 *          "Certificate revoked. Reason: Unspecified".
 *       6. A second revoke → 400 problem+json `alreadyRevoked`.
 * WHY: ACME is the protocol most clients use; a pre-authorized identifier needs no challenge (core#2231), and revoking must work
 *      with the account key and answer RFC 8555 §7.6 for an already revoked certificate.
 * HOW: the ACME profile is activated on an own RA profile of the run (without a CA the test skips with the reason). The account is
 *      recorded in the ledger as soon as it exists and the certificate by its run-prefixed name as soon as the order settles or fails
 *      to, with the key core links (derived, server clock), each before anything is judged. Core sets REVOKED first and writes the
 *      history entry afterwards, so the history is polled.
 */
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';
import { expect, test } from '../../../fixtures/areas/protocolTarget';
import { AcmeClient } from '../../../utils/regression/protocols/acmeClient';
import { csrWithSan, firstPem, sha256FingerprintOfPem, pemToDer } from '../../../utils/regression/pkiBuilders';
import { isProblemJson } from '../../../utils/regression/protocols/protocolHttp';
import { certificateFacts } from '../../../utils/regression/protocols/protocolResponseReaders';
import { getCertificate, searchCertificates, serverCreatedAfter } from '../../../utils/regression/apiReads';
import { getCertificateHistory } from '../../../utils/regression/discovery/discoveryApi';
import { createdAfterMarker } from '../../../utils/regression/ledger/ledger';
import { runName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ACME_FLOW_MS, ACME_ORDER_WAIT_MS, HISTORY_ENTRY_MS, HISTORY_POLL_EVERY_MS, STATUS_CHANGE_MS } from '../../../utils/regression/timeouts';

test.describe('ACME issue and revoke', { tag: tags.regression }, () => {
    test('an ACME account revokes its own certificate and a second revoke is refused',
        testMeta({
            id: 'REG-PROT-01', prio: 'P2', issue: 'ilm#430', needs: 'ca',
            rule: [
                'ilm#430 steps 1–2: order through the directory → issued; revoke with the client → REVOKED in core',
                'pre-authorized identifier → authorization valid, no challenges, order ready at creation (core#2231)',
                'finalize needs ready; valid when ISSUED; download application/pem-certificate-chain (RFC 8555 §7.4)',
                'revoke-cert with the account key (kid): the certificate must be ACME-issued to that account; success 200 empty; already revoked → 400 alreadyRevoked (RFC 8555 §7.6); reason null → unspecified',
                'the certificate history records "Certificate revoked. Reason: Unspecified" when no reason was given',
            ],
        }),
        async ({ api, own, acmeRig }) => {
            // One order to valid (client order wait up to 120 s), a download, two revokes and a state wait (≤ 60 s).
            test.setTimeout(ACME_FLOW_MS);
            const { raProfile, acmeProfile, directoryUrl } = acmeRig;
            const identifier = acmeProfile.identifier;
            const client = new AcmeClient(directoryUrl);

            await test.step('Directory → a fresh account (valid), recorded', async () => {
                const dir = await client.init();
                expect(dir.revokeCert, 'directory advertises revokeCert').toBeTruthy();
                const account = await client.newAccount(`${runName('acme-prot01')}@example.test`);
                // The account is on the tier once the platform answered: record it before anything is judged.
                if (account.location) await own.acmeAccount(account.location, acmeProfile);
                expect(account.location, 'new-account answers the account URL').toBeTruthy();
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
                let recorded: string[] = [];
                const before = new Set((await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'EQUALS', value: identifier }], 100)).map((r) => String(r.uuid)));
                const fin = await client.finalize(order.body.finalize, csr.derBase64Url);
                let done: Awaited<ReturnType<typeof client.waitForOrder>> | undefined;
                try {
                    if (fin.status < 300) done = await client.waitForOrder(order.url, ACME_ORDER_WAIT_MS);
                } finally {
                    // Ledger before assertion, also when the finalize was refused or the order never became valid: every certificate of the
                    // identifier and its linked key (derived, server clock).
                    const createdAfter = order.date ? createdAfterMarker(order.date) : await serverCreatedAfter(api);
                    const uuids = await own.recordNamed(identifier, 'issued via ACME');
                    for (const uuid of uuids) await own.derivedKey(uuid, createdAfter);
                    recorded = uuids;
                }
                expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
                expect(done?.status, JSON.stringify(done)).toBe('valid');
                return { pem: firstPem(await client.downloadCertificate(done!.certificate)), mine: recorded.filter((u) => !before.has(u)) };
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
                await waitForCertificateState(api, certUuid, 'revoked', STATUS_CHANGE_MS);
                // Core sets REVOKED first and writes the history entry afterwards: poll the history.
                await expect.poll(async () => (await getCertificateHistory(api, certUuid)).map((h) => String(h.message ?? '')),
                    { timeout: HISTORY_ENTRY_MS, intervals: [HISTORY_POLL_EVERY_MS], message: 'history after the revoke' }).toContain('Certificate revoked. Reason: Unspecified');
            });

            await test.step('Second revoke → 400 problem+json …:alreadyRevoked', async () => {
                const res = await client.revokeCert(certificateDer);
                expect(res.status, JSON.stringify(res.body)).toBe(400);
                expect(isProblemJson(res.contentType), `content type ${res.contentType}`).toBe(true);
                expect(String(res.body?.type ?? '')).toMatch(/:alreadyRevoked$/);
            });
        });
});
