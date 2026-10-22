/**
 * REG-USE-05 — A certificate issued over ACME (release checklist: Usage 5). ilm#430.
 *
 * WHAT: 1. The run's ACME profile (one exact pre-authorized identifier) is activated on an own RA profile; an RFC 8555 client reads the
 *          directory, opens a valid account and orders the identifier → ready, no challenge needed.
 *       2. Finalize → the order is valid → download the chain; the certificate carries the CSR key and the identifier, and the inventory
 *          lists it by fingerprint under the RA profile with protocol ACME and the ACME profile's uuid.
 *       3. The account is listed in the API and in the UI's ACME accounts list; the certificate detail opens.
 *       4. A name that is not pre-authorized → pending, with http-01 and dns-01 challenges only (a test of its own).
 *       5. (REG-USE-05.1, RSA-2048 and EC P-256 CSRs) Order expiry equals now plus the profile validity and Retry-After equals the retry
 *          interval on new-account, new-order and finalize; the download is application/pem-certificate-chain with the leaf first and
 *          each block signed by the next; the leaf has the ordered SAN and the CSR key.
 *       6. (REG-USE-05.2) A second finalize of a valid order → 403 orderNotReady and the order stays valid.
 * WHY: ACME is the issuance path of most automated clients; the pre-authorization must skip challenges only for the exact identifier, and
 *      the protocol answers must follow RFC 8555 (§7.1.6, §7.4.2) and the profile's settings.
 * HOW: the ACME profile and the account are the run's own; the account and every certificate an order makes are recorded in the ledger
 *      with their keys before the assertions (also when the finalize throws). Every row declares the `ca` need, so a tier without a
 *      healthy CA skips with the named reason. The EC row is skipped with the CA's text when the RA profile refuses EC keys. The SAN
 *      oracle is CA-aware: the exact set on EJBCA-NG, DNS values elsewhere. Each row registers its own account on the run ACME profile.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AcmeAccountPage } from '../../../pages/AcmeAccountPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { AcmeClient } from '../../../utils/regression/protocols/acmeClient';
import { certificateInfo, chainProblems, csrWithSan, ecCsrWithSan, firstPem, parseCertificate, pemBlocks, publicKeyPemOf, sha256Fingerprint, sha256FingerprintOfPem } from '../../../utils/regression/pkiBuilders';
import { apiJson, getCertificate, searchCertificates, serverCreatedAfter } from '../../../utils/regression/apiReads';
import { recordingIssued } from '../../../utils/regression/issuedRecords';
import { sanOracle } from '../../../utils/regression/ownCertificates';
import { ensureAcmeOnRaProfile } from '../../../utils/regression/ownRaProfiles';
import { createdAfterMarker } from '../../../utils/regression/ledger/ledger';
import { runName } from '../../../utils/regression/ledger/runState';
import { ecRefusal, orderAndFinalize, startAcmeRun } from '../../../utils/regression/lifecycle/acmeOrders';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ACME_EXPIRY_TOLERANCE_SECONDS, ACME_ORDER_MS } from '../../../utils/regression/timeouts';

test.describe('Certificate issue over ACME', { tag: tags.regression }, () => {
    test('a pre-authorized ACME order is issued through the RA profile directory and listed',
        testMeta({
            id: 'REG-USE-05', prio: 'P1', issue: 'ilm#430', needs: 'ca',
            rule: ['release checklist Usage 5: issue a certificate with an ACME client through the RA profile directory (RFC 8555: account, order, finalize, download); the account is listed in the UI'],
        }),
        async ({ signedIn: page, api, own }) => {
            const { raProfile, acmeProfile, directoryUrl } = await test.step('Prerequisite: ACME profile activated on an own RA profile of the run', async () =>
                ensureAcmeOnRaProfile(api, own.spec));
            const identifier = acmeProfile.identifier;
            const client = new AcmeClient(directoryUrl);

            await test.step('Directory lists the RFC 8555 resources', async () => {
                const dir = await client.init();
                for (const k of ['newNonce', 'newAccount', 'newOrder', 'revokeCert']) expect(dir[k], k).toBeTruthy();
            });

            const accountUrl = await test.step('New account → valid', async () => {
                const res = await client.newAccount(`${runName('acme')}@example.test`);
                expect(res.location).toBeTruthy();
                // Recorded before the assertion on its state (ledger before assertion).
                await own.acmeAccount(res.location!, acmeProfile);
                expect(res.body.status).toBe('valid');
                return res.location!;
            });

            const order = await test.step(`New order for the pre-authorized ${identifier} → ready, no challenge needed`, async () => {
                const res = await client.newOrder([identifier]);
                expect(res.status, JSON.stringify(res.body)).toBe(201);
                expect(res.body.status).toBe('ready');
                const authz = await client.get(res.body.authorizations[0]);
                expect(authz.body.status).toBe('valid');
                return { url: res.location!, body: res.body, date: res.date };
            });

            const csr = csrWithSan(identifier, [identifier]);
            const pem = await test.step('Finalize → valid → download the certificate', async () => {
                const createdAfter = order.date ? createdAfterMarker(order.date) : await serverCreatedAfter(api);
                // Ledger first, also when the finalize throws after the server issued or the wait times out.
                const { result: done } = await recordingIssued(api, identifier, createdAfter, own.spec, 'issued via ACME', async () => {
                    const fin = await client.finalize(order.body.finalize, csr.derBase64Url);
                    expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
                    return client.waitForOrder(order.url);
                });
                expect(done.status, JSON.stringify(done)).toBe('valid');
                return firstPem(await client.downloadCertificate(done.certificate));
            });

            const cert = parseCertificate(pem);
            await test.step('Issued certificate carries the CSR key and the identifier', async () => {
                expect(publicKeyPemOf(cert)).toBe(csr.publicKeyPem);
                expect(cert.subject.getField('CN')?.value).toBe(identifier);
            });

            const certUuid = await test.step('Inventory: found by fingerprint, RA profile = the run RA profile, protocol ACME', async () => {
                const found = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: sha256Fingerprint(cert) }]);
                expect(found.length).toBe(1);
                const detail = await getCertificate(api, found[0].uuid);
                expect(detail.raProfile?.uuid).toBe(raProfile.uuid);
                expect(String(detail.protocolInfo?.protocol ?? '')).toMatch(/acme/i);
                expect(detail.protocolInfo?.protocolProfileUuid).toBe(acmeProfile.uuid);
                return found[0].uuid as string;
            });

            await test.step('ACME account is listed for the run ACME profile', async () => {
                const accounts = await apiJson<Array<Record<string, any>>>(api, 'GET', '/api/v1/acmeAccounts');
                const accountId = accountUrl.split('/').pop();
                expect(accounts.some((a) => String(a.accountId) === accountId && a.acmeProfileUuid === acmeProfile.uuid), `account of ${acmeProfile.name}`).toBe(true);
            });

            await test.step('UI: ACME accounts list shows the account (searched by its account id: the list pages by 10, sorted by ACME profile name)', async () => {
                const accounts = new AcmeAccountPage(page);
                await accounts.goToList();
                const accountId = accountUrl.split('/').pop() ?? '';
                await accounts.searchById(accountId);
                await accounts.assertListed(accountId, acmeProfile.name);
                await accounts.clearSearch();
            });

            await test.step('UI: the certificate detail opens', async () => {
                const certPage = new CertificatePage(page);
                await certPage.goToDetail(certUuid);
                await expect(certPage.main).toContainText(identifier);
            });
        });

    test('an order for a name that is not pre-authorized gets http-01 and dns-01 challenges only',
        testMeta({
            id: 'REG-USE-05', row: 'not-pre-authorized-name', prio: 'P1', issue: 'ilm#430', needs: 'ca',
            rule: ['the pre-authorization skips challenges only for the exact identifier: any other name is pending with the http-01 and dns-01 challenges only (RFC 8555 §7.1.6)'],
        }),
        async ({ api, own }) => {
            const run = await test.step('Prerequisite: ACME profile on an own RA profile of the run and a new account', async () => startAcmeRun(api, own.spec));

            await test.step('A name that is not pre-authorized gets http-01 / dns-01 challenges only', async () => {
                const other = `other-${run.acmeProfile.identifier}`;
                const res = await run.client.newOrder([other]);
                expect(res.status, JSON.stringify(res.body)).toBe(201);
                expect(res.body.status).toBe('pending');
                const authz = await run.client.get(res.body.authorizations[0]);
                const types = (authz.body.challenges ?? []).map((c: { type: string }) => c.type).sort();
                expect(types.length).toBeGreaterThan(0);
                for (const t of types) expect(['dns-01', 'http-01'], `challenge type ${t} is one of http-01 / dns-01`).toContain(t);
            });
        });

    // ------------------------------------------------------------------ order and download details, a second finalize

    for (const keyType of ['rsa-2048', 'ec-p256'] as const) {
        test(`${keyType === 'rsa-2048' ? 'an RSA 2048' : 'an EC P-256'} CSR: order expiry and Retry-After follow the profile and the chain has its SAN and key`,
            testMeta({
                id: 'REG-USE-05.1', row: keyType, prio: 'P1', issue: 'ilm#430', needs: 'ca',
                rule: [
                    'order expires = now + profile validity (core#2516 when NULL); Retry-After = retry interval on new-account, new-order, finalize',
                    'download: application/pem-certificate-chain with the chain of the CA, and RFC 8555 §7.4.2 (leaf first, each next certifies the previous)',
                    'pre-authorized → ready; the CSR names the ordered identifier; the order is valid once the certificate is issued; RFC 5280 §6 (chain signatures)',
                    'the CA decides the SAN extension: exact set on EJBCA-NG, DNS values elsewhere',
                ],
            }),
            async ({ api, own }, testInfo) => {
                // One order: finalize, settle (180 s order wait of the client), download.
                test.setTimeout(ACME_ORDER_MS);
                const run = await test.step('Prerequisite: ACME on an own RA profile, the profile settings and a new account', async () => startAcmeRun(api, own.spec));
                const identifier = run.acmeProfile.identifier;
                const retry = run.profile.retryInterval;
                const validity = run.profile.validity;
                const san = sanOracle(run.connector);
                testInfo.annotations.push({ type: 'san-oracle', description: san.describe() });

                await test.step('Precondition: the profile has an explicit retry interval and order validity', async () => {
                    expect(retry, 'retryInterval of the run ACME profile').toBeGreaterThan(0);
                    expect(validity, 'validity of the run ACME profile (none → 36 s orders, core#2516)').toBeGreaterThan(0);
                });

                await test.step('new-account answered Retry-After = the retry interval', async () => {
                    expect(run.account.retryAfter, 'Retry-After on new-account').toBe(String(retry));
                });

                const csr = keyType === 'rsa-2048' ? csrWithSan(identifier, [identifier]) : await ecCsrWithSan(identifier, [identifier]);
                const { order, fin, done, uuids, mine } = await test.step(`new-order for ${identifier} → finalize with a ${keyType} CSR → settled`, async () =>
                    orderAndFinalize(api, run, csr, own.spec));

                await test.step('new-order: 201, ready, Retry-After, expires = server now + validity (± 300 s)', async () => {
                    expect(order.body.status).toBe('ready');
                    expect(order.retryAfter, 'Retry-After on new-order').toBe(String(retry));
                    const serverNow = order.date?.getTime();
                    if (!serverNow) testInfo.annotations.push({ type: 'clock', description: 'no Date header on new-order: the runner clock is used' });
                    const expiresIn = (Date.parse(order.body.expires) - (serverNow ?? Date.now())) / 1000;
                    expect(Math.abs(expiresIn - validity!), `order expires in ${Math.round(expiresIn)} s, profile validity ${validity} s`).toBeLessThanOrEqual(ACME_EXPIRY_TOLERANCE_SECONDS);
                });

                if (keyType === 'ec-p256' && (fin.status >= 300 || done?.status === 'invalid')) {
                    // The RA profile's CA may refuse EC keys (a CA policy: the EC row is skipped when the RA profile refuses EC).
                    // That is only known from the answer of the finalize, so the skip comes after the writes; every certificate of the
                    // order is recorded already.
                    const refusal = await ecRefusal(api, fin, done, mine);
                    test.skip(!!refusal, `the RA profile refuses EC P-256 keys: ${String(refusal).slice(0, 300)}`);
                }

                await test.step('finalize: accepted with Retry-After; the order is valid', async () => {
                    expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
                    expect(fin.retryAfter, 'Retry-After on finalize').toBe(String(retry));
                    expect(done?.status, JSON.stringify(done)).toBe('valid');
                });

                const chain = await test.step('download: 200, application/pem-certificate-chain', async () => {
                    const dl = await run.client.downloadCertificateResponse(done!.certificate);
                    expect(dl.status).toBe(200);
                    expect(dl.contentType ?? '').toMatch(/^application\/pem-certificate-chain\b/);
                    return dl.body;
                });
                const blocks = pemBlocks(chain);

                const leafUuid = await test.step('inventory: the leaf is the certificate this order made', async () => {
                    expect(blocks.length).toBeGreaterThan(0);
                    const found = await searchCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: sha256FingerprintOfPem(blocks[0]) }]);
                    expect(found.length).toBe(1);
                    expect(mine).toContain(found[0].uuid);
                    expect(uuids).toContain(found[0].uuid);
                    return String(found[0].uuid);
                });

                await test.step('chain: the leaf first, each block signed by the next (two blocks at least when the issuing CA is in the inventory)', async () => {
                    // Whether the issuing CA is in the inventory is read at run time, so this is one check with two outcomes, not two rows.
                    const issuerInInventory = !!(await getCertificate(api, leafUuid)).issuerCertificateUuid;
                    if (issuerInInventory) expect(blocks.length, 'the issuing CA certificate is in the inventory, so the chain carries it').toBeGreaterThanOrEqual(2);
                    else if (blocks.length < 2) testInfo.annotations.push({ type: 'chain-check', description: 'partial: one block and the issuing CA certificate is not in the inventory (nothing to verify the leaf against)' });
                    expect(await chainProblems(blocks)).toEqual([]);
                });

                await test.step('leaf: SAN = the ordered identifier (CA-aware), public key = the CSR key', async () => {
                    const leaf = certificateInfo(blocks[0]);
                    san.expectSans(leaf.sans, { dns: [identifier], ip: [] });
                    expect(leaf.spkiBase64, 'leaf public key = CSR key').toBe(csr.spkiBase64);
                });
            });
    }

    test('a second finalize of a valid order answers 403 orderNotReady and the order stays valid',
        testMeta({
            id: 'REG-USE-05.2', prio: 'P1', issue: 'ilm#430', needs: 'ca',
            rule: ['finalize requires order `ready`, else 403 `orderNotReady` (also a second finalize); RFC 8555 §7.1.6 order state model'],
        }),
        async ({ api, own }) => {
            // One order to valid (client order wait 180 s) and two short reads.
            test.setTimeout(ACME_ORDER_MS);
            const run = await test.step('Prerequisite: ACME on an own RA profile and a new account', async () => startAcmeRun(api, own.spec));
            const csr = csrWithSan(run.acmeProfile.identifier, [run.acmeProfile.identifier]);
            const { order, fin, done } = await test.step('An order finalized to valid', async () => orderAndFinalize(api, run, csr, own.spec));

            await test.step('The first finalize settled the order as valid', async () => {
                expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
                expect(done?.status, JSON.stringify(done)).toBe('valid');
            });

            await test.step('Second finalize on the same order → 403 problem+json …:orderNotReady', async () => {
                const second = await run.client.finalize(order.body.finalize, csr.derBase64Url);
                expect(second.status, JSON.stringify(second.body)).toBe(403);
                expect(second.contentType ?? '').toMatch(/^application\/problem\+json\b/);
                expect(String(second.body?.type ?? '')).toMatch(/:orderNotReady$/);
            });

            await test.step('The order is still valid', async () => {
                const after = await run.client.get(order.location!);
                expect(after.body.status).toBe('valid');
            });
        });
});
