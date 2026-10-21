/**
 * REG-USE-03 — importing certificates through the import dialog (release checklist: Usage 3): a new PEM is imported
 * and found by fingerprint, the same PEM again is "Already in inventory"; a PKCS#12 asks for its password, refuses a wrong
 * one and shows its entries; a CSR file is detected but not importable. Only the PEM is imported (recorded from the
 * import answer with the key core links to it); the PKCS#12 key is never imported.
 */
import { randomBytes } from 'node:crypto';
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { CertificatePage } from '../../pages/CertificatePage';
import { findCertificateByFingerprint, generateSelfSignedCert } from '../../utils/certificateUtils';
import { csrWithSan, selfSignedPkcs12 } from '../../utils/regression/pkiBuilders';
import { serverCreatedAfter } from '../../utils/regression/apiReads';
import { recordDerivedKeyOf, recordingIssued } from '../../utils/regression/issuedRecords';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'REG-USE-03';

test.describe('Certificate import', { tag: tags.regression }, () => {
    test('a PEM imported in the dialog is in the inventory and a second import says already there',
        testMeta({
            id: 'REG-USE-03', prio: 'P1', issue: 'ilm#428',
            rule: ['release checklist Usage 3: import a certificate through the import dialog; the result badge says Imported, then Already in inventory for the same PEM'],
        }),
        async ({ page, api, env }) => {
            const cn = runName('import-pem');
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
                // that fails) the run CN is recorded from the inventory by recordingIssued.
                const { result: { answer, created } } = await recordingIssued(api, cn, createdAfter, SPEC, 'imported (self-signed)', async () => {
                    const answer = await certPage.submitImport();
                    // A body that is not JSON names nothing created: the inventory read of recordingIssued records it instead.
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
                await certPage.assertImportResult('Imported');
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
                await certPage.assertImportResult('Already in inventory');
                await certPage.closeImportModal();
            });
        });

    test('a PKCS#12 needs its password and a CSR file is detected but cannot be imported',
        testMeta({
            id: 'REG-USE-03', prio: 'P1', issue: 'ilm#428',
            rule: ['the import dialog asks for the password of a protected PKCS#12, refuses a wrong one and lists the entries with the key destination; certificate requests are not imported'],
        }),
        async ({ page, env }, testInfo) => {
            const certPage = new CertificatePage(page);
            const fileInput = certPage.importModal.locator('input[type="file"]').first();
            const password = certPage.importModal.locator('#importPassphrase');
            // Run-scoped random passwords: nothing password-like is a literal in the spec.
            const secret = () => `qa-${randomBytes(12).toString('base64url')}`;
            const passwordA = secret(), passwordB = secret(), wrongPassword = secret();
            const p12a = { name: `${runName('a')}.p12`, mimeType: 'application/x-pkcs12', buffer: selfSignedPkcs12(runName('p12-a'), passwordA) };
            const p12b = { name: `${runName('b')}.p12`, mimeType: 'application/x-pkcs12', buffer: selfSignedPkcs12(runName('p12-b'), passwordB) };

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
                await expect(certPage.importDetectedContent).toContainText(runName('p12-a'));
                await expect(certPage.importModal.getByText('Token profile', { exact: false }).first()).toBeVisible();
                await testInfo.attach('p12-entries', { body: await page.screenshot(), contentType: 'image/png' });
            });

            await test.step('Switching to another file clears the password', async () => {
                await fileInput.setInputFiles(p12b);
                await expect(password).toBeVisible();
                await expect(password).toHaveValue('');
            });

            await test.step('A CSR file is detected but cannot be imported', async () => {
                const csr = csrWithSan(runName('csr'));
                await fileInput.setInputFiles({ name: `${runName('csr')}.csr`, mimeType: 'application/pkcs10', buffer: Buffer.from(csr.pem) });
                await expect(certPage.importModal.getByText(/requests are not imported/i).first()).toBeVisible();
                await expect(certPage.importSubmitButton).toBeDisabled();
            });

            await test.step('Close without importing', async () => {
                await certPage.importModal.getByRole('button', { name: 'Cancel', exact: true }).click();
                await expect(certPage.importModal).toBeHidden();
            });
        });
});
