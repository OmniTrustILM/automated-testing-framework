/**
 * REG-USE-04 — A certificate issued in the web UI from an external CSR (release checklist: Usage 4; ilm#429).
 *
 * Add Certificate with Key Source External issues the certificate within 180 s, and the API shows the CSR's public key. A
 * garbage CSR gets inline validation and a "Failed to issue certificate" alert. (.1) A CSR with DNS and IP SANs is issued
 * with them; the SAN check is exact on EJBCA-NG and DNS-only where the CA's template decides the SANs.
 *
 * The RA profile is the run's own. Every certificate is recorded in the ledger from the create answer, before the redirect
 * is waited for, and deleted by the run-end teardown.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { CertificateAddPage } from '../../../pages/CertificateAddPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { dismissToasts } from '../../../pages/ui/toast';
import { CERTIFICATE_DETAILS_TABS } from '../../../utils/constants';
import { csrWithSan, parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../../utils/regression/pkiBuilders';
import { getCertificate, serverCreatedAfter } from '../../../utils/regression/apiReads';
import { authorityConnectorName } from '../../../utils/regression/config/authorities';
import { recordingIssued } from '../../../utils/regression/issuedRecords';
import { submitFormCreateRecorded } from '../../../utils/regression/ui/certificateFormCreate';
import { sanOracle, waitIssued } from '../../../utils/regression/ownCertificates';
import { ownCommonName, runCommonName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { UI_ISSUE_FLOW_MS } from '../../../utils/regression/timeouts';
import { escapeRegExp } from '../../../utils/regression/text';

test.describe('Certificate issue in the web UI with an external key', { tag: tags.regression }, () => {
    test('requesting now with an uploaded CSR issues the certificate with its key and its tabs open',
        testMeta({
            id: 'REG-USE-04', prio: 'P1', issue: 'ilm#429',
            rule: ['release checklist Usage 4: Add Certificate, Request now, the RA profile, Key Source External, a pasted CSR; the issued certificate carries the CSR key and its tabs open'],
        }),
        async ({ signedIn: page, api, own, live, ownRaProfile }, testInfo) => {
            const ra = ownRaProfile;
            // The form selects this RA profile: prove it is a live object of this run first (an issue-only parent is only used, never
            // changed).
            if (ra.kind === 'own') await live('raProfiles', ra);
            const cn = runCommonName('ui');
            const csr = csrWithSan(cn, [cn]);
            const certPage = new CertificatePage(page);

            const createdAfter = await serverCreatedAfter(api);
            const uuid = await test.step('Request now → RA profile → External → paste CSR → Create', async () => {
                await certPage.goToList();
                await certPage.openIssuePage();
                await certPage.selectRequestTypeIssue();
                await certPage.selectRaProfile(ra.name);
                await certPage.selectKeySourceExternal();
                await certPage.pasteCsr(csr.pem);
                const { result } = await recordingIssued(api, cn, createdAfter, own.spec, 'issued via UI', async () => {
                    const addPage = new CertificateAddPage(page);
                    // The create answer is recorded before the redirect is waited for; the page then opens the certificate (or the warnings
                    // panel).
                    await submitFormCreateRecorded(addPage, own, 'issue', { cn, note: 'issued via UI', ra });
                    return addPage.waitForCreatedCertificate({ acceptWarnings: true });
                });
                if (result.warnings.length) testInfo.annotations.push({ type: 'issue-warnings', description: result.warnings.join(' | ') });
                return result.uuid;
            });

            await test.step('Issuance completes (state issued)', async () => {
                // Issued within the issue budget (the CA answers synchronously or through status polling).
                await waitIssued(api, uuid);
                // Second recording of the derived key (idempotent): catches a key core links only after the first recording.
                await own.derivedKey(uuid, createdAfter);
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
                await certPage.verifyOtherTabsOpenWithoutError(CERTIFICATE_DETAILS_TABS);
            });

            await test.step('API: issued by the run RA profile with the CSR key', async () => {
                const cert = await getCertificate(api, uuid);
                expect(cert.raProfile?.uuid).toBe(ra.uuid);
                expect(publicKeyPemOf(parseCertificate(cert.certificateContent))).toBe(csr.publicKeyPem);
            });
        });

    test('a garbage CSR in the Add Certificate form shows the validation and creates no certificate',
        testMeta({
            id: 'REG-USE-04', row: 'garbage-csr', prio: 'P1', issue: 'ilm#429',
            rule: ['Add Certificate, Request now, Key Source External: a pasted garbage CSR is refused inline and by the create answer (4xx) and the page stays on the form'],
        }),
        async ({ signedIn: page, live, ownRaProfile }) => {
            const ra = ownRaProfile;
            // The form selects this RA profile: prove it is a live object of this run first (an issue-only parent is only used, never
            // changed).
            if (ra.kind === 'own') await live('raProfiles', ra);
            const certPage = new CertificatePage(page);

            await test.step('Open Add Certificate', async () => {
                await certPage.goToList();
                await certPage.openIssuePage();
            });

            await test.step('Negative: a garbage CSR does not create a certificate', async () => {
                await certPage.selectRequestTypeIssue();
                await certPage.selectRaProfile(ra.name);
                await certPage.selectKeySourceExternal();
                await certPage.pasteCsr('-----BEGIN CERTIFICATE REQUEST-----\nbm90LWEtY3Ny\n-----END CERTIFICATE REQUEST-----');
                await dismissToasts(page);
                await certPage.submitButton.click();
                await expect(page.getByRole('alert').filter({ hasText: /Failed to issue certificate \(4\d\d\)/ }).first()).toBeVisible();
                await expect(page).toHaveURL(/\/certificates\/add/);
                await dismissToasts(page);
            });
        });

    test('a garbage CSR in the Add Certificate form shows the inline message under File content',
        testMeta({
            id: 'REG-USE-04', row: 'inline-csr-message', prio: 'P1', issue: 'ilm#429', needs: 'utils-service',
            rule: ['Add Certificate, Request now, Key Source External: a pasted garbage CSR shows the inline "issue with certification request" message under File content'],
        }),
        async ({ signedIn: page, live, ownRaProfile }) => {
            const ra = ownRaProfile;
            if (ra.kind === 'own') await live('raProfiles', ra);
            const certPage = new CertificatePage(page);

            await test.step('Open Add Certificate', async () => {
                await certPage.goToList();
                await certPage.openIssuePage();
            });

            await test.step('A garbage CSR shows the inline message', async () => {
                await certPage.selectRequestTypeIssue();
                await certPage.selectRaProfile(ra.name);
                await certPage.selectKeySourceExternal();
                await certPage.pasteCsr('-----BEGIN CERTIFICATE REQUEST-----\nbm90LWEtY3Ny\n-----END CERTIFICATE REQUEST-----');
                await expect(page.locator('main').getByText(/issue with certification request/i).first()).toBeVisible();
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
        async ({ signedIn: page, api, own, live, ownRaProfile }, testInfo) => {
            // UI flow + issuance (180 s) + the tab checks.
            test.setTimeout(UI_ISSUE_FLOW_MS);
            const ra = ownRaProfile;
            // The form selects this RA profile: prove it is a live object of this run first (an issue-only parent is only used, never
            // changed).
            if (ra.kind === 'own') await live('raProfiles', ra);
            const san = sanOracle(await authorityConnectorName(api, ra.authorityUuid));
            testInfo.annotations.push({ type: 'san-oracle', description: san.describe() });

            // A time suffix keeps the name unique under --repeat-each.
            const cn = ownCommonName('ui-san');
            // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): a documentation address, never a real host.
            const sans = { dns: [cn, `alt.${cn}`], ip: ['192.0.2.10'] };
            const csr = csrWithSan(cn, sans.dns, { ip: sans.ip });
            const certPage = new CertificatePage(page);

            const createdAfter = await serverCreatedAfter(api);
            const uuid = await test.step('Add Certificate → Request now → the run RA profile → External → the SAN CSR → Create', async () => {
                await certPage.goToList();
                await certPage.openIssuePage();
                await certPage.selectRequestTypeIssue();
                await certPage.selectRaProfile(ra.name);
                await certPage.selectKeySourceExternal();
                await certPage.pasteCsr(csr.pem);
                const { result } = await recordingIssued(api, cn, createdAfter, own.spec, 'issued via UI with DNS + IP SANs (REG-USE-04.1)', async () => {
                    const addPage = new CertificateAddPage(page);
                    // The create answer is recorded before the redirect is waited for; the page then opens the certificate (or the warnings
                    // panel).
                    await submitFormCreateRecorded(addPage, own, 'issue', { cn, note: 'issued via UI with DNS + IP SANs (REG-USE-04.1)', ra });
                    return addPage.waitForCreatedCertificate({ acceptWarnings: true });
                });
                // Lenient validation: the request-attribute set of the copied RA profile decides whether e.g. the IP SAN is a warning.
                if (result.warnings.length) testInfo.annotations.push({ type: 'issue-warnings', description: result.warnings.join(' | ') });
                return result.uuid;
            });

            await test.step('Issuance completes (state issued, within 180 s)', async () => {
                await waitIssued(api, uuid);
                // Second recording of the derived key (idempotent): catches a key core links only after the first recording.
                await own.derivedKey(uuid, createdAfter);
            });

            await test.step('API: the issued certificate carries the CSR\'s SANs and key; the stored request keeps the CSR\'s SANs', async () => {
                const cert = await getCertificate(api, uuid);
                san.expectIssued(cert, sans);
                // On a profile whose request-attribute set drops the IP SAN ("SAN iPAddress … is not allowed by the request-attribute
                // set", accepted with warnings) the stored request keeps the DNS SANs only: the SAN oracle of the CA / profile decides.
                const stored = sansOfDetail(cert.certificateRequest?.subjectAlternativeNames);
                san.expectSans(stored, sans);
                if (!sameSans(stored, sans)) testInfo.annotations.push({ type: 'san-oracle-request', description: `stored request SANs ${JSON.stringify(stored)} differ from the CSR's ${JSON.stringify(sans)}: the request-attribute set of the profile decides` });
                expect(publicKeyPemOf(parseCertificate(cert.certificateContent)), 'public key = CSR key').toBe(csr.publicKeyPem);
                expect(cert.raProfile?.uuid).toBe(ra.uuid);
            });

            await test.step('Details tab after reload: state Issued, the RA profile, the SAN widget', async () => {
                await certPage.goToDetail(uuid);
                await page.reload();
                await certPage.assertIssuedDetails({ commonName: cn, raProfileName: ra.name });
                await certPage.assertSans(sans, san.mode);
            });

            await test.step('Request tab: the pkcs10 request of the CN', async () => {
                await certPage.assertRequestTab({ commonName: cn });
            });

            await test.step('History tab: "Issued using RA Profile <RA name>"', async () => {
                await certPage.assertHistoryTabHasEntry(new RegExp(`Issued using RA Profile ${escapeRegExp(ra.name)}`));
            });
        });
});
