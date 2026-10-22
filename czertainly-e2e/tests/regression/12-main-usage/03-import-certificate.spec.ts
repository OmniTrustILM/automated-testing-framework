/**
 * REG-USE-03 — Importing certificates through the import dialog (release checklist: Usage 3). ilm#428.
 *
 * WHAT: 1. Paste a new self-signed PEM → detected → Import → the result says "Imported"; the API finds it by fingerprint.
 *       2. The same PEM again → "Already in inventory".
 *       3. A protected PKCS#12 → "File password" is asked for; a wrong password is refused with no entries; the right one lists the
 *          entries and asks for a key destination (token profile); another file clears the password.
 *       4. A CSR file → detected, "requests are not imported", Import disabled; close without importing (a test of its own).
 * WHY: the import dialog is how operators bring existing certificates in; a duplicate must be recognised, a protected container must
 *      not leak its content, and a request is not a certificate.
 * HOW: only the PEM is imported: it is recorded from the import answer together with the key core links to it, and the run CN is recorded
 *      from the inventory if anything throws after the click. The PKCS#12 key is never imported. Passwords are random per run.
 */
import { randomBytes } from 'node:crypto';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { CertificatePage } from '../../../pages/CertificatePage';
import { findCertificateByFingerprint, generateSelfSignedCert } from '../../../utils/certificateUtils';
import { csrWithSan, selfSignedPkcs12 } from '../../../utils/regression/pkiBuilders';
import { serverCreatedAfter } from '../../../utils/regression/apiReads';
import { recordingIssued } from '../../../utils/regression/issuedRecords';
import { runName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { INVENTORY_APPEAR_MS } from '../../../utils/regression/timeouts';

test.describe('Certificate import', { tag: tags.regression }, () => {
    test('a PEM imported in the dialog is in the inventory and a second import says already there',
        testMeta({
            id: 'REG-USE-03', prio: 'P1', issue: 'ilm#428',
            rule: ['release checklist Usage 3: import a certificate through the import dialog; the result badge says Imported, then Already in inventory for the same PEM'],
        }),
        async ({ signedIn: page, api, own }) => {
            const cn = runName('import-pem');
            const { pem, fingerprint } = generateSelfSignedCert(cn, 30);
            const certPage = new CertificatePage(page);

            await test.step('Open the import dialog', async () => {
                await certPage.goToList();
                await certPage.openImportModal();
            });

            const importedUuid = await test.step('Paste the PEM → detected → Import → recorded from the answer (+ its linked key) → "Imported"', async () => {
                await certPage.pasteCertificatePem(pem);
                const createdAfter = await serverCreatedAfter(api);
                // Whatever throws after the click (a response wait that times out, an answer that does not parse, a key read
                // that fails) the run CN is recorded from the inventory by recordingIssued.
                const { result: { answer, created } } = await recordingIssued(api, cn, createdAfter, own.spec, 'imported (self-signed)', async () => {
                    const answer = await certPage.submitImport();
                    // A body that is not JSON names nothing created: the inventory read of recordingIssued records it instead.
                    const text = await answer.text().catch(() => '');
                    const parsed = ((): { results?: Array<{ certificateUuid?: string; certificateOutcome?: string }> } => {
                        try {
                            return JSON.parse(text);
                        } catch {
                            return {};
                        }
                    })();
                    const created = (parsed.results ?? []).find((r) => r.certificateUuid && r.certificateOutcome === 'created');
                    if (created) {
                        own.record('certificates', { status: answer.status(), uuid: created.certificateUuid, text }, { name: cn, note: 'imported (self-signed)' });
                        await own.derivedKey(created.certificateUuid!, createdAfter);
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
                await expect.poll(async () => (await findCertificateByFingerprint(api, fingerprint))?.uuid ?? '', { timeout: INVENTORY_APPEAR_MS }).toBe(importedUuid);
            });

            await test.step('Same PEM again → "Already in inventory"', async () => {
                await certPage.openImportModal();
                await certPage.pasteCertificatePem(pem);
                await certPage.submitImport();
                await certPage.assertImportResult('Already in inventory');
                await certPage.closeImportModal();
            });
        });

    test('a protected PKCS#12 asks for its password and lists its entries only with the right one',
        testMeta({
            id: 'REG-USE-03', prio: 'P1', issue: 'ilm#428',
            rule: ['the import dialog asks for the password of a protected PKCS#12, refuses a wrong one and lists the entries with the key destination'],
        }),
        async ({ signedIn: page }, testInfo) => {
            const certPage = new CertificatePage(page);
            const dialog = certPage.importDialog;
            // Run-scoped random passwords: nothing password-like is a literal in the spec.
            const secret = () => `qa-${randomBytes(12).toString('base64url')}`;
            const passwordA = secret(), passwordB = secret(), wrongPassword = secret();
            const p12a = { name: `${runName('a')}.p12`, mimeType: 'application/x-pkcs12', buffer: selfSignedPkcs12(runName('p12-a'), passwordA) };
            const p12b = { name: `${runName('b')}.p12`, mimeType: 'application/x-pkcs12', buffer: selfSignedPkcs12(runName('p12-b'), passwordB) };

            await test.step('Open the import dialog', async () => {
                await certPage.goToList();
                await certPage.openImportModal();
            });

            await test.step('Protected PKCS#12 → "File password" is asked for', async () => {
                await dialog.chooseFile(p12a);
                await dialog.assertPasswordFieldShown();
            });

            await test.step('Wrong password → refused, no entries', async () => {
                await dialog.enterPassword(wrongPassword); // Enter re-reads the file; it never submits the form
                await expect(dialog.dialog.getByRole('alert').filter({ hasText: /passphrase is wrong or missing/i })).toBeVisible();
                await dialog.assertNoEntries();
            });

            await test.step('Right password → entries detected, key destination required', async () => {
                await dialog.enterPassword(passwordA);
                await expect(dialog.detected).toBeVisible();
                await expect(dialog.detected).toContainText(runName('p12-a'));
                await expect(dialog.dialog.getByText('Token profile', { exact: false }).first()).toBeVisible();
                await testInfo.attach('p12-entries', { body: await page.screenshot(), contentType: 'image/png' });
            });

            await test.step('Switching to another file clears the password', async () => {
                await dialog.chooseFile(p12b);
                await dialog.assertPasswordFieldShown();
                await expect(dialog.password).toHaveValue('');
            });

            await test.step('Close without importing', async () => {
                await dialog.cancel();
            });
        });

    test('a CSR file is detected but cannot be imported',
        testMeta({
            id: 'REG-USE-03', row: 'csr-not-imported', prio: 'P1', issue: 'ilm#428',
            rule: ['the import dialog detects a certificate request but does not import it: Import stays disabled'],
        }),
        async ({ signedIn: page }) => {
            const certPage = new CertificatePage(page);
            const dialog = certPage.importDialog;

            await test.step('Open the import dialog', async () => {
                await certPage.goToList();
                await certPage.openImportModal();
            });

            await test.step('A CSR file is detected but cannot be imported', async () => {
                const csr = csrWithSan(runName('csr'));
                await dialog.chooseFile({ name: `${runName('csr')}.csr`, mimeType: 'application/pkcs10', buffer: Buffer.from(csr.pem) });
                await expect(dialog.dialog.getByText(/requests are not imported/i).first()).toBeVisible();
                await dialog.assertSubmitDisabled();
            });

            await test.step('Close without importing', async () => {
                await dialog.cancel();
            });
        });
});
