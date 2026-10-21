/**
 * REG-USE-04 — a certificate issued in the web UI from an external CSR (release checklist: Usage 4) on the run RA profile:
 * a garbage CSR creates nothing; Request now issues the CSR's key and SANs, and the Details, Request and History tabs show
 * them. Every certificate is recorded right after Create (also when the page shows the "accepted with warnings" panel or
 * the step throws), with its linked key, and deleted by the run-end teardown.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificateAddPage } from '../../pages/CertificateAddPage';
import { CertificatePage } from '../../pages/CertificatePage';
import { dismissToasts } from '../../pages/ui/toast';
import { CERTIFICATE_DETAILS_TABS } from '../../utils/constants';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { csrWithSan, parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../utils/regression/pkiBuilders';
import { getCertificate, serverCreatedAfter } from '../../utils/regression/apiReads';
import { authorityConnectorName } from '../../utils/regression/config/authorities';
import { recordDerivedKeyOf, recordingIssued } from '../../utils/regression/issuedRecords';
import { sanOracleFor } from '../../utils/regression/ownCertificates';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { escapeRegExp } from '../../utils/regression/text';

const SPEC = 'REG-USE-04';

test.describe('Certificate issue in the web UI with an external key', { tag: tags.regression }, () => {
    test('requesting now with an uploaded CSR issues the certificate with its key, but not for a garbage CSR',
        testMeta({
            id: 'REG-USE-04', prio: 'P1', issue: 'ilm#429',
            rule: ['release checklist Usage 4: Add Certificate, Request now, the RA profile, Key Source External, a pasted CSR; the issued certificate carries the CSR key and its tabs open'],
        }),
        async ({ page, api, env, ownRaProfile }, testInfo) => {
            const ra = ownRaProfile;
            const cn = `${runName('ui')}.example.test`;
            const csr = csrWithSan(cn, [cn]);
            const certPage = new CertificatePage(page);

            await test.step('Log in and open Add Certificate', async () => {
                await loginAsSmokeUser(page, env);
                await certPage.goToList();
                await certPage.openIssuePage();
            });

            await test.step('Negative: a garbage CSR does not create a certificate', async () => {
                await certPage.selectRequestTypeIssue();
                await certPage.selectRaProfile(ra.name);
                await certPage.selectKeySourceExternal();
                await certPage.pasteCsr('-----BEGIN CERTIFICATE REQUEST-----\nbm90LWEtY3Ny\n-----END CERTIFICATE REQUEST-----');
                // Inline validation under File content, and the same message as a toast.
                await expect(page.locator('main').getByText(/issue with certification request/i).first()).toBeVisible();
                await dismissToasts(page);
                await certPage.submitButton.click();
                await expect(page.getByRole('alert').filter({ hasText: /Failed to issue certificate \(4\d\d\)/ }).first()).toBeVisible();
                await expect(page).toHaveURL(/\/certificates\/add/);
                await dismissToasts(page);
            });

            const createdAfter = await serverCreatedAfter(api);
            const uuid = await test.step('Request now → RA profile → External → paste CSR → Create', async () => {
                await certPage.goToList();
                await certPage.openIssuePage();
                await certPage.selectRequestTypeIssue();
                await certPage.selectRaProfile(ra.name);
                await certPage.selectKeySourceExternal();
                await certPage.pasteCsr(csr.pem);
                const { result } = await recordingIssued(api, cn, createdAfter, SPEC, 'issued via UI', async () => {
                    const issued = await new CertificateAddPage(page).submitIssueWithWarnings();
                    recordCreated('certificates', { uuid: issued.uuid, name: cn }, SPEC, 'issued via UI', { raProfile: ra.uuid, authority: ra.authorityUuid });
                    return issued;
                });
                if (result.warnings.length) testInfo.annotations.push({ type: 'issue-warnings', description: result.warnings.join(' | ') });
                return result.uuid;
            });

            await test.step('Issuance completes (state issued)', async () => {
                // Issued within 180 s (the CA answers synchronously or through status polling).
                await waitForCertificateState(api, uuid, 'issued', 180_000);
                // Second recording of the derived key (idempotent): catches a key core links only after the first recording.
                await recordDerivedKeyOf(api, uuid, createdAfter, SPEC);
            });

            await test.step('Detail page: Details tab', async () => {
                // The detail page opened by Create does not poll: it keeps "Pending issue" until reloaded.
                await certPage.goToDetail(uuid);
                await page.reload();
                await certPage.assertIssuedDetails({ commonName: cn, raProfileName: ra.name });
            });

            await test.step('Request tab (pkcs10) and History tab (issue entry)', async () => {
                await certPage.assertRequestTab({ commonName: cn });
                await certPage.assertHistoryTabHasEntry(/issue/i);
            });

            await test.step('Other tabs open without errors', async () => {
                await certPage.assertTabsOpenWithoutError(CERTIFICATE_DETAILS_TABS);
            });

            await test.step('API: issued by the run RA profile with the CSR key', async () => {
                const cert = await getCertificate(api, uuid);
                expect(cert.raProfile?.uuid).toBe(ra.uuid);
                expect(publicKeyPemOf(parseCertificate(cert.certificateContent))).toBe(csr.publicKeyPem);
            });
        });

    test('requesting now with a CSR carrying DNS and IP SANs issues them and shows them in Details and History',
        testMeta({
            id: 'REG-USE-04.1', prio: 'P1', issue: 'ilm#429',
            rule: [
                'Request now + External: v2 issue, redirect to the detail, Issued after reload, CSR key',
                'history "Issued using RA Profile <name>"; SAN content reaches the CA (what it accepts is the CA\'s decision)',
                'the issued certificate carries the requested SANs',
            ],
        }),
        async ({ page, api, env, ownRaProfile }, testInfo) => {
            // UI flow + issuance (180 s) + the tab checks.
            test.setTimeout(300_000);
            const ra = ownRaProfile;
            const connector = await authorityConnectorName(api, ra.authorityUuid);
            const mode = sanOracleFor(connector);
            testInfo.annotations.push({ type: 'san-oracle', description: mode === 'exact' ? `exact SAN set (DNS and IP) on ${connector}` : `DNS values only on ${connector} (its template decides the SAN extension)` });

            // A time suffix keeps the name unique under --repeat-each.
            const cn = `${runName(`ui-san-${Date.now().toString(36)}`)}.example.test`;
            // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): a documentation address, never a real host.
            const sans = { dns: [cn, `alt.${cn}`], ip: ['192.0.2.10'] };
            const csr = csrWithSan(cn, sans.dns, { ip: sans.ip });
            const certPage = new CertificatePage(page);

            const createdAfter = await serverCreatedAfter(api);
            const uuid = await test.step('Add Certificate → Request now → the run RA profile → External → the SAN CSR → Create', async () => {
                await loginAsSmokeUser(page, env);
                await certPage.goToList();
                await certPage.openIssuePage();
                await certPage.selectRequestTypeIssue();
                await certPage.selectRaProfile(ra.name);
                await certPage.selectKeySourceExternal();
                await certPage.pasteCsr(csr.pem);
                const { result } = await recordingIssued(api, cn, createdAfter, SPEC, 'issued via UI with DNS + IP SANs (REG-USE-04.1)', async () => {
                    const issued = await new CertificateAddPage(page).submitIssueWithWarnings();
                    recordCreated('certificates', { uuid: issued.uuid, name: cn }, SPEC, 'issued via UI with DNS + IP SANs (REG-USE-04.1)', { raProfile: ra.uuid, authority: ra.authorityUuid });
                    return issued;
                });
                // Lenient validation: the request-attribute set of the copied RA profile decides whether e.g. the IP SAN is a warning.
                if (result.warnings.length) testInfo.annotations.push({ type: 'issue-warnings', description: result.warnings.join(' | ') });
                return result.uuid;
            });

            await test.step('Issuance completes (state issued, within 180 s)', async () => {
                await waitForCertificateState(api, uuid, 'issued', 180_000);
                // Second recording of the derived key (idempotent): catches a key core links only after the first recording.
                await recordDerivedKeyOf(api, uuid, createdAfter, SPEC);
            });

            await test.step('API: the issued certificate carries the CSR\'s SANs and key; the stored request keeps the CSR\'s SANs', async () => {
                const cert = await getCertificate(api, uuid);
                const issued = sansOfDetail(cert.subjectAlternativeNames);
                if (mode === 'exact') expect(sameSans(issued, sans), `issued SANs ${JSON.stringify(issued)} = CSR SANs ${JSON.stringify(sans)}`).toBe(true);
                else for (const d of sans.dns) expect(issued.dns.map((x) => x.toLowerCase())).toContain(d.toLowerCase());
                // Seen on a live tier: on a profile whose request-attribute set drops the IP SAN ("SAN iPAddress … is not allowed by the request-attribute
                // set", accepted with warnings) the stored request keeps the DNS SANs only: the SAN oracle of the CA / profile decides.
                const stored = sansOfDetail(cert.certificateRequest?.subjectAlternativeNames);
                if (mode === 'exact') expect(sameSans(stored, sans), 'the stored request has exactly the CSR SANs').toBe(true);
                else for (const d of sans.dns) expect(stored.dns.map((x) => x.toLowerCase()), 'the stored request keeps the CSR DNS SANs').toContain(d.toLowerCase());
                if (!sameSans(stored, sans)) testInfo.annotations.push({ type: 'san-oracle-request', description: `stored request SANs ${JSON.stringify(stored)} differ from the CSR's ${JSON.stringify(sans)}: the request-attribute set of the profile decides` });
                expect(publicKeyPemOf(parseCertificate(cert.certificateContent)), 'public key = CSR key').toBe(csr.publicKeyPem);
                expect(cert.raProfile?.uuid).toBe(ra.uuid);
            });

            await test.step('Details tab after reload: state Issued, the RA profile, the SAN widget', async () => {
                await certPage.goToDetail(uuid);
                await page.reload();
                await certPage.assertIssuedDetails({ commonName: cn, raProfileName: ra.name });
                await certPage.assertSans(sans, mode);
            });

            await test.step('Request tab: the pkcs10 request of the CN', async () => {
                await certPage.assertRequestTab({ commonName: cn });
            });

            await test.step('History tab: "Issued using RA Profile <RA name>"', async () => {
                await certPage.assertHistoryTabHasEntry(new RegExp(`Issued using RA Profile ${escapeRegExp(ra.name)}`));
            });
        });
});
