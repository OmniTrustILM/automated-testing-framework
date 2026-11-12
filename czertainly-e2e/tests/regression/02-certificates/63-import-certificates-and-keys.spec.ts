/**
 * REG-CERT-63 — Import certificates and keys: the files core refuses (release checklist: Certificates, import). ilm#428, ilm#442.
 *
 * WHAT: 1. Garbage bytes, a PEM with two private keys, a PEM with a DH-parameters block (one test each) → the inspection
 *          answers 422 with the fixed text; the wizard shows the red alert, no entries, Import disabled and the File password field.
 *       2. A protected PKCS#12 without a password, then with a wrong one → the same refusal text both times (a wrong and a
 *          missing password cannot be told apart); Import stays disabled.
 *       3. A file of 5 242 881 bytes → refused by the size rule unread (422, never 413).
 *       4. A file of 5 242 880 bytes → passes the size rule and is read: one certificate entry whose reference, fingerprint and
 *          digest are recomputed from the bytes; Import is not clicked.
 *       5. A certificate request → one "Signing request" entry, its checkbox disabled, the reason shown, no refusal alert.
 *       In every test the browser logs no error and no certificate with the file's run-prefixed common name exists afterwards.
 * WHY: the import dialog is the entry for operator-supplied files; a refusal must be one fixed, non-oracular message and must
 *      not leave an object behind. A red test means a refusal text changed, a limit moved or an import slipped through.
 * HOW: the inspection is a read the browser sends itself; nothing is stored and Import is never clicked, so the tests create
 *      nothing (the search by the run-prefixed name answering 0 is the proof). The provoked 422 is allowed by name in the browser
 *      guard. The size rows skip with the reason when an ingress answers 413 before core. Passwords are generated per run.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ImportCertificatesDialog } from '../../../pages/ImportCertificatesDialog';
import { AllowedClientError, BrowserGuards } from '../../../utils/regression/browserGuards';
import { expectRefused } from '../../../utils/regression/errorContract';
import { isolation, searchPage } from '../../../utils/regression/inventory/searchApi';
import { asFile, certificate, certificateFingerprint, containerDigest, csrPem, dhParametersPem, entryReference, garbageBytes, importCn, inspectionAlert, LIMITS, paddedCertificatePem, pemTwoKeys, pkcs12, REFUSAL, UploadFile } from '../../../utils/regression/inventory/importFixtures';
import { sha256Hex } from '../../../utils/regression/pkiBuilders';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { ApiAnswer } from '../../../utils/regression/apiReads';
import { randomBytes } from 'node:crypto';
import { LARGE_FILE_TEST_MS } from '../../../utils/regression/timeouts';
// Run-scoped generated test passwords: no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_2 = `qa-${randomBytes(9).toString('base64url')}`;

/** The provoked refusal of the inspection: the 422 is the oracle of these rows, not a defect. */
const EXPECTED_REFUSAL: AllowedClientError[] = [
    { method: 'POST', path: /\/api\/v1\/inspections$/, status: 422, expected: 'a refused file answers 422 (the inspection API refuses an unreadable or oversized file with 422)', reason: 'the row provokes it' },
    { method: 'GET', path: /\/v1\/branding$/, status: 404, expected: 'an unbranded tier answers 404: "no branding", silent by design (the FE branding module)', reason: 'the theme provider asks on every full page load' },
];

const RULE_TEXTS = 'fixed refusal texts, red alert `Failed to read the uploaded file (<status>): <text>`';

/** The 413 an ingress would answer before core (the proxy body limit is not known): the size rows cannot decide anything then. */
function skipOnIngressRefusal(answer: ApiAnswer): void {
    test.skip(answer.status === 413, 'the ingress in front of core refused the 5 MiB body with 413 before core read it (the proxy body limit is not known; core has no 413 path)');
}

/** Nothing was created: no certificate whose common name starts with the file's run-prefixed name. */
async function expectNothingCreated(api: GuardedApi, prefix: string): Promise<void> {
    const found = await searchPage(api, { filters: [isolation(prefix)], itemsPerPage: 10, pageNumber: 1, includeArchived: true });
    expect(found.totalItems, `certificates under ${prefix}`).toBe(0);
}

/** The refused answer: 422 with the body shape of core (a JSON array of non-empty strings) and exactly this message. */
function expectRefusalAnswer(answer: ApiAnswer, text: string): void {
    expectRefused(answer, { status: 422, text, what: 'POST /v1/inspections' });
}

interface RefusedRow {
    row: string;
    /** The behaviour in the test title. */
    title: string;
    /** Why core refuses it, with the code path (fixtures module header). */
    why: string;
    file: (base: string) => UploadFile;
    text: string;
}

/** Files core refuses whole: one browser test each, so a failing row is attributable. */
const REFUSED: RefusedRow[] = [
    {
        row: 'garbage',
        title: 'garbage bytes are refused',
        why: 'garbage bytes are no supported format',
        file: () => asFile('garbage.bin', garbageBytes()),
        text: REFUSAL.notSupportedFormat,
    },
    {
        row: 'pem-two-keys',
        title: 'a PEM with two private keys is refused whole',
        why: 'a PEM holds at most one private key, so a certificate with two keys is refused whole',
        file: (base) => asFile('two-keys.pem', `${certificate(`${base}-leaf`).pem}${pemTwoKeys()}`, 'application/x-pem-file'),
        text: REFUSAL.pemTooManyKeys,
    },
    {
        row: 'dh-parameters',
        title: 'a PEM with a DH-parameters block is refused',
        why: 'a DH PARAMETERS block is a PEM type the reader does not take',
        file: (base) => asFile('dhparam.pem', `${certificate(`${base}-leaf`).pem}${dhParametersPem()}`, 'application/x-pem-file'),
        text: REFUSAL.pemBlockUnsupported('DH PARAMETERS'),
    },
];

test.describe('import wizard and its refusals', { tag: tags.regression }, () => {
    for (const r of REFUSED) {
        test(`${r.title}: red alert, Import disabled`,
            testMeta({ id: 'REG-CERT-63', row: r.row, prio: 'P2', issue: ['ilm#428', 'ilm#442'], rule: [RULE_TEXTS, r.why] }),
            async ({ signedIn: page, api }) => {
                const base = importCn(`neg-${r.row}`);
                const file = r.file(base);
                const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
                const wizard = new ImportCertificatesDialog(page);

                await test.step('Open Import certificates and keys, choose the file', async () => {
                    guards.start(); // after the sign-in (the `signedIn` fixture): the identity provider's pages are not the wizard's
                    guards.mark(r.row);
                    await wizard.goToList();
                    await wizard.openDialog();
                });

                const answer = await wizard.chooseFile(file);
                await test.step('The inspection is refused with the fixed message (status, body shape, text)', async () => expectRefusalAnswer(answer, r.text));

                await test.step('The wizard: red alert, no entries, Import disabled, File password offered', async () => {
                    await wizard.assertRefused(inspectionAlert(422, r.text));
                    await wizard.assertNoEntries();
                    await wizard.assertSubmitDisabled();
                    await wizard.assertPasswordFieldShown();
                });

                await test.step('No console error, page error, 5xx or unexpected 4xx; nothing was created', async () => {
                    guards.assertZero();
                    await expectNothingCreated(api, base);
                });
                await wizard.cancel();
            });
    }

    test('a PKCS#12 gives one refusal for a missing and a wrong password',
        testMeta({ id: 'REG-CERT-63', row: 'pkcs12-wrong-password', prio: 'P2', issue: ['ilm#428', 'ilm#442'], rule: [RULE_TEXTS, '"one non-oracular message"'] }),
        async ({ signedIn: page, api }) => {
            const base = importCn('neg-p12');
            const p12 = pkcs12(`${base}-leaf`, GEN_PW_1);
            const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
            const wizard = new ImportCertificatesDialog(page);

            await test.step('Open the dialog, choose the protected PKCS#12 without a password', async () => {
                guards.start();
                guards.mark('pkcs12');
                await wizard.goToList();
                await wizard.openDialog();
            });
            const missing = await wizard.chooseFile(asFile('protected.p12', p12.bytes, 'application/x-pkcs12'));
            await test.step('Missing password: 422 integrity text, alert, File password offered, Import disabled', async () => {
                expectRefusalAnswer(missing, REFUSAL.integrityFailed);
                await wizard.assertRefused(inspectionAlert(422, REFUSAL.integrityFailed));
                await wizard.assertPasswordFieldShown();
                await wizard.assertNoEntries();
                await wizard.assertSubmitDisabled();
            });

            const wrong = await wizard.enterPassword(GEN_PW_2);
            await test.step('Wrong password: the SAME text (a wrong and a missing password cannot be told apart), Import still disabled', async () => {
                expectRefusalAnswer(wrong, REFUSAL.integrityFailed);
                expect(wrong.text, 'wrong and missing password: identical body').toBe(missing.text);
                await wizard.assertRefused(inspectionAlert(422, REFUSAL.integrityFailed));
                await wizard.assertNoEntries();
                await wizard.assertSubmitDisabled();
            });

            await test.step('No browser findings; nothing was created', async () => {
                guards.assertZero();
                await expectNothingCreated(api, base);
            });
            await wizard.cancel();
        });

    test('a file of 5 242 881 bytes is refused by the size rule unread',
        testMeta({ id: 'REG-CERT-63', row: 'over-limit-5242881', prio: 'P2', issue: ['ilm#428', 'ilm#442'], rule: [RULE_TEXTS, 'the 5 MiB limit answers 422 `file must not exceed 5242880 bytes`, never 413'] }),
        async ({ signedIn: page, api }) => {
            test.setTimeout(LARGE_FILE_TEST_MS);
            const base = importCn('neg-size');
            // A valid certificate PEM padded to the byte: the content is fine, so only the size rule can refuse it.
            const { file } = paddedCertificatePem(`${base}-leaf`, LIMITS.fileBytes + 1);
            expect(file.length).toBe(5_242_881);
            const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
            const wizard = new ImportCertificatesDialog(page);

            await test.step('Open the dialog, choose the 5 242 881-byte file', async () => {
                guards.start();
                guards.mark('over-limit');
                await wizard.goToList();
                await wizard.openDialog();
            });
            const answer = await wizard.chooseFile(asFile('over-limit.pem', file, 'application/x-pem-file'));
            skipOnIngressRefusal(answer);

            await test.step('422 with the size text; red alert; Import disabled; File password offered', async () => {
                expectRefusalAnswer(answer, REFUSAL.fileTooLarge);
                await wizard.assertRefused(inspectionAlert(422, REFUSAL.fileTooLarge));
                await wizard.assertNoEntries();
                await wizard.assertSubmitDisabled();
                await wizard.assertPasswordFieldShown();
            });

            await test.step('No browser findings; nothing was created', async () => {
                guards.assertZero();
                await expectNothingCreated(api, base);
            });
            await wizard.cancel();
        });

    test('the file one byte shorter passes the size rule and is read',
        testMeta({ id: 'REG-CERT-63', row: 'at-limit-5242880', prio: 'P2', issue: ['ilm#428', 'ilm#442'], rule: [RULE_TEXTS, '5 242 880 decoded bytes pass the size rule, 5 242 881 are refused'] }),
        async ({ signedIn: page, api }) => {
            test.setTimeout(LARGE_FILE_TEST_MS);
            const base = importCn('neg-size-ok');
            const { file, identity } = paddedCertificatePem(`${base}-leaf`, LIMITS.fileBytes);
            expect(file.length).toBe(5_242_880);
            const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
            const wizard = new ImportCertificatesDialog(page);

            await test.step('Open the dialog, choose the 5 242 880-byte file', async () => {
                guards.start();
                guards.mark('at-limit');
                await wizard.goToList();
                await wizard.openDialog();
            });
            const answer = await wizard.chooseFile(asFile('at-limit.pem', file, 'application/x-pem-file'));
            skipOnIngressRefusal(answer);

            await test.step('200: one certificate entry whose reference, fingerprint and digest are the ones recomputed from the bytes', async () => {
                expect(answer.status, 'POST /v1/inspections').toBe(200);
                const body = answer.json as { containerDigest: string; entries: Array<{ kind: string; entryReference: string; fingerprint?: string }> };
                expect(body.containerDigest).toBe(containerDigest(file));
                expect(body.entries).toHaveLength(1);
                expect(body.entries[0].kind).toBe('certificate');
                expect(body.entries[0].entryReference).toBe(entryReference(identity.der));
                expect(body.entries[0].fingerprint).toBe(certificateFingerprint(identity.der));
            });

            await test.step('The wizard lists the entry, no refusal; Import is NOT clicked', async () => {
                await wizard.assertNotRefused();
                await wizard.assertDetected(1);
                await wizard.assertPasswordFieldHidden();
            });

            await test.step('No browser findings; nothing was created (Cancel only)', async () => {
                guards.assertZero();
                await wizard.cancel();
                await expectNothingCreated(api, base);
            });
        });

    test('a certificate request is shown as "Signing request" with its checkbox disabled',
        testMeta({ id: 'REG-CERT-63', row: 'csr', prio: 'P2', issue: ['ilm#428', 'ilm#442'], rule: ['a certificate request is reported as `signingRequest` and is not importable', RULE_TEXTS] }),
        async ({ signedIn: page, api }) => {
            const base = importCn('neg-csr');
            const csr = csrPem(`${base}-request`);
            const file = Buffer.from(csr.pem);
            const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
            const wizard = new ImportCertificatesDialog(page);

            await test.step('Open the dialog, choose the CSR file', async () => {
                guards.start();
                guards.mark('csr');
                await wizard.goToList();
                await wizard.openDialog();
            });
            const answer = await wizard.chooseFile(asFile('request.csr', file, 'application/pkcs10'));

            await test.step('200: one `signingRequest` entry; its reference is the SHA-256 of the request DER', async () => {
                expect(answer.status, 'POST /v1/inspections').toBe(200);
                const body = answer.json as { containerDigest: string; entries: Array<{ kind: string; entryReference: string }> };
                expect(body.containerDigest).toBe(sha256Hex(file));
                expect(body.entries).toHaveLength(1);
                expect(body.entries[0].kind).toBe('signingRequest');
                expect(body.entries[0].entryReference).toBe(csr.reference);
            });

            await test.step('Detected content – 1 entry: "Signing request", checkbox disabled and unchecked, the reason shown, Import disabled, no refusal alert, no password field', async () => {
                await wizard.assertDetected(1);
                await wizard.assertSigningRequest(REFUSAL.requestNotImported);
                await wizard.assertNotRefused();
                await wizard.assertPasswordFieldHidden();
            });

            await test.step('No browser findings; nothing was created', async () => {
                guards.assertZero();
                await expectNothingCreated(api, base);
            });
            await wizard.cancel();
        });
});
