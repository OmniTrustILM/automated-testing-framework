/**
 * REG-USE-03 — Import certificate (release checklist: Usage 3).
 *
 * Flow: Certificates → "Import certificates and keys" → paste a new PEM → Import → "Imported" → the certificate
 * is in the inventory. Same PEM again → "Already in inventory". PKCS#12: the password is asked for (422), a wrong
 * one is refused, the right one shows the entries and the key destination; switching the file clears the
 * password. A CSR file is detected but cannot be imported.
 * Upload-only: the key in the PKCS#12 is never imported (that would write into an existing token). The imported PEM
 * is recorded in the ledger from the import call's own answer (`certificateOutcome: created`), before any assertion
 * (review Q14), together with the `certKey_<CN>` key core links to every imported certificate (derived object, server
 * clock from a read before the import; incident fix, B1 live run 1: that key was left behind), and deleted by the
 * run-end teardown; an `existing` / `adopted` outcome is never recorded as own.
 */
import { randomBytes } from 'node:crypto';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificatePage } from '../../pages/CertificatePage';
import { findCertificateByFingerprint, generateSelfSignedCert } from '../../utils/certificateUtils';
import { csrWithSan, selfSignedPkcs12 } from '../../utils/regression/pki';
import { recordDerivedKeyOf, recordingIssued, serverCreatedAfter } from '../../utils/regression/regressionApi';
import { recordCreated, regName } from '../../utils/regression/regressionRun';

const SPEC = 'REG-USE-03';

test.describe('@regression REG-USE-03 import certificate', () => {
    test('import a PEM certificate through the import wizard', async ({ page, api, env }) => {
        const cn = regName('import-pem');
        const { pem, fingerprint } = generateSelfSignedCert(cn, 30);
        const certPage = new CertificatePage(page);

        await test.step('Log in, open the import dialog', async () => {
            await loginAsSmokeUser(page, env);
            await certPage.goToList();
            await certPage.openImportModal();
        });

        const importedUuid = await test.step('Paste the PEM → detected → Import → recorded from the answer (+ its linked key) → "Imported"', async () => {
            await certPage.pasteCertificatePem(pem);
            const createdAfter = await serverCreatedAfter(api);
            // Whatever throws after the click (a response wait that times out, an answer that does not parse, a key read
            // that fails) the run CN is recorded from the inventory by recordingIssued (Sonnet F2).
            const { result: { answer, created } } = await recordingIssued(api, cn, createdAfter, SPEC, 'imported (self-signed)', async () => {
                const answer = await certPage.submitImport();
                const results = (((await answer.json().catch(() => ({}))) as { results?: Array<{ certificateUuid?: string; certificateOutcome?: string }> }).results) ?? [];
                const created = results.find((r) => r.certificateUuid && r.certificateOutcome === 'created');
                if (created) {
                    recordCreated('certificates', { uuid: created.certificateUuid!, name: cn }, SPEC, 'imported (self-signed)');
                    await recordDerivedKeyOf(api, created.certificateUuid!, createdAfter, SPEC);
                }
                return { answer, created };
            });
            expect(answer.status(), 'the import call answered').toBeLessThan(300);
            expect(created?.certificateUuid, 'the import created the certificate').toBeTruthy();
            await certPage.expectImportResult('Imported');
            await certPage.closeImportModal();
            return created!.certificateUuid!;
        });

        await test.step('The certificate is in the inventory (API, by fingerprint)', async () => {
            await expect.poll(async () => (await findCertificateByFingerprint(api, fingerprint))?.uuid ?? '', { timeout: 30_000 }).toBe(importedUuid);
        });

        await test.step('Same PEM again → "Already in inventory"', async () => {
            await certPage.openImportModal();
            await certPage.pasteCertificatePem(pem);
            await certPage.submitImport();
            await certPage.expectImportResult('Already in inventory');
            await certPage.closeImportModal();
        });
    });

    test('PKCS#12 password flow and CSR detection (no import)', async ({ page, env }, testInfo) => {
        const certPage = new CertificatePage(page);
        const fileInput = certPage.importModal.locator('input[type="file"]').first();
        const password = certPage.importModal.locator('#importPassphrase');
        // Run-scoped random passwords (merge item 8): nothing password-like is a literal in the spec.
        const secret = () => `qa-${randomBytes(12).toString('base64url')}`;
        const passwordA = secret(), passwordB = secret(), wrongPassword = secret();
        const p12a = { name: `${regName('a')}.p12`, mimeType: 'application/x-pkcs12', buffer: selfSignedPkcs12(regName('p12-a'), passwordA) };
        const p12b = { name: `${regName('b')}.p12`, mimeType: 'application/x-pkcs12', buffer: selfSignedPkcs12(regName('p12-b'), passwordB) };

        await test.step('Log in, open the import dialog', async () => {
            await loginAsSmokeUser(page, env);
            await certPage.goToList();
            await certPage.openImportModal();
        });

        await test.step('Protected PKCS#12 → "File password" is asked for', async () => {
            await fileInput.setInputFiles(p12a);
            await expect(password).toBeVisible();
        });

        await test.step('Wrong password → refused, no entries', async () => {
            await password.fill(wrongPassword);
            await password.press('Enter'); // Enter re-reads the file; it never submits the form
            await expect(certPage.importModal.getByRole('alert').filter({ hasText: /passphrase is wrong or missing/i })).toBeVisible();
            await expect(certPage.importDetectedContent).toBeHidden();
        });

        await test.step('Right password → entries detected, key destination required', async () => {
            await password.fill(passwordA);
            await password.press('Enter');
            await expect(certPage.importDetectedContent).toBeVisible();
            await expect(certPage.importDetectedContent).toContainText(regName('p12-a'));
            await expect(certPage.importModal.getByText('Token profile', { exact: false }).first()).toBeVisible();
            await testInfo.attach('p12-entries', { body: await page.screenshot(), contentType: 'image/png' });
        });

        await test.step('Switching to another file clears the password', async () => {
            await fileInput.setInputFiles(p12b);
            await expect(password).toBeVisible();
            await expect(password).toHaveValue('');
        });

        await test.step('A CSR file is detected but cannot be imported', async () => {
            const csr = csrWithSan(regName('csr'));
            await fileInput.setInputFiles({ name: `${regName('csr')}.csr`, mimeType: 'application/pkcs10', buffer: Buffer.from(csr.pem) });
            await expect(certPage.importModal.getByText(/requests are not imported/i).first()).toBeVisible();
            await expect(certPage.importSubmitButton).toBeDisabled();
        });

        await test.step('Close without importing', async () => {
            await certPage.importModal.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(certPage.importModal).toBeHidden();
        });
    });
});
