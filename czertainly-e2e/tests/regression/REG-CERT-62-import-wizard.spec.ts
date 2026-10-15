/**
 * REG-CERT-62…67 — the import wizard of the certificate inventory ("Import certificates and keys"). This file holds
 * REG-CERT-63 now (wizard NEGATIVES); B5 adds REG-CERT-62 / 64…67 beside it.
 *
 * REG-CERT-63 — what the wizard does with a file core refuses. The browser makes the inspection request itself
 * (`POST /v1/inspections`, a read of the file: stateless, nothing is stored), so this spec observes the real answer and
 * needs no API call of its own except the read-only search that proves nothing was created. For each file:
 *   - the red alert reads `Failed to read the uploaded file (422): <the fixed text of core>`  (inventory-api rules §6.2 r18),
 *   - the Import button stays disabled and no entry is listed,
 *   - the "File password" field appears for the 422 (a protected file is not told apart from a wrong password, §6.2 r17),
 *   - no console error, page error, 5xx or other 4xx (`browserGuards`; the 422 of the inspection is the provoked refusal),
 *   - nothing was created (a search by the run-prefixed common name of the file's own certificate answers 0).
 * The files are built in memory (utils/regression/inventoryImportFixtures.ts: garbage bytes, a PKCS#12 with a password, a PEM
 * with two keys, a PEM with a DH-parameters block, a PEM of exactly 5 242 881 bytes) and handed to the file chooser as a
 * buffer: nothing is written to disk. The refusal texts and the code path that produces each are in the fixtures module.
 * Import is never clicked: a certificate request is shown as "Signing request" with its checkbox disabled (§6.2 r8).
 *
 * Shared-tier safety: read-only (inspection) — no object is created, so the ledger stays untouched. If an ingress in
 * front of core refuses the 5 MiB body with 413 before core sees it (inventory-api OPEN Q1: the proxy limit is not known;
 * core itself has no 413 path), the two size rows skip with that named reason: a deploy gate, never a pass.
 */
import { expect, loginAsSmokeUser, test } from '../../fixtures/testFixtures';
import { ImportWizardPage } from '../../pages/ImportWizardPage';
import { AllowedClientError, BrowserGuards } from '../../utils/regression/browserGuards';
import { expect422Messages } from '../../utils/regression/errorContract';
import { isolation, searchPage } from '../../utils/regression/inventoryApi';
import {
    asFile, certificate, certificateFingerprint, containerDigest, csrPem, dhParametersPem, entryReference, garbageBytes, importCn, inspectionAlert,
    LIMITS, paddedCertificatePem, pemTwoKeys, pkcs12, REFUSAL, sha256Hex, UploadFile,
} from '../../utils/regression/inventoryImportFixtures';
import { meta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import type { Response } from '@playwright/test';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords (merge follow-up 2026-10-15): no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;
const GEN_PW_2 = `qa-${randomBytes(9).toString('base64url')}`;

/** The provoked refusal of the inspection: the 422 is the oracle of these rows, not a defect. */
const EXPECTED_REFUSAL: AllowedClientError[] = [
    { method: 'POST', path: /\/api\/v1\/inspections$/, status: 422, expected: 'a refused file answers 422 (inventory-api §1.3, §6.2 r4-r5)', reason: 'REG-CERT-63 provokes it' },
    { method: 'GET', path: /\/v1\/branding$/, status: 404, expected: 'an unbranded tier answers 404: "no branding", silent by design (fe ducks/branding-epics.ts:21, :50-52)', reason: 'the theme provider asks on every full page load' },
];

const RULE_TEXTS = 'inventory-api §6.2 r3–r5, r8, r18 (fixed refusal texts, red alert `Failed to read the uploaded file (<status>): <text>`); §6.4 [neg][ui]; QA#14';

/** The 413 an ingress would answer before core (inventory-api OPEN Q1): the size rows cannot decide anything then. */
function skipOnIngressRefusal(answer: Response): void {
    test.skip(answer.status() === 413, 'the ingress in front of core refused the 5 MiB body with 413 before core read it (inventory-api OPEN Q1: the proxy body limit is not known; core has no 413 path)');
}

/** Nothing was created: no certificate whose common name starts with the file's run-prefixed name. */
async function expectNothingCreated(api: GuardedApi, prefix: string): Promise<void> {
    const found = await searchPage(api, { filters: [isolation(prefix)], itemsPerPage: 10, pageNumber: 1, includeArchived: true });
    expect(found.totalItems, `certificates under ${prefix}`).toBe(0);
}

/** The refused answer: 422 with the body shape of core (a JSON array of non-empty strings) and exactly this message. */
async function expectRefusalAnswer(answer: Response, text: string): Promise<void> {
    expect(answer.status(), 'POST /v1/inspections').toBe(422);
    expect(answer.headers()['content-type'] ?? '').toMatch(/application\/json/);
    expect(expect422Messages(await answer.text())).toEqual([text]);
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
        title: 'garbage bytes are refused as no supported format',
        why: 'garbage bytes are no supported format (DerFormat parse fails: ContainerRefusal.java:13)',
        file: () => asFile('garbage.bin', garbageBytes()),
        text: REFUSAL.notSupportedFormat,
    },
    {
        row: 'pem-two-keys',
        title: 'a PEM with two private keys is refused whole',
        why: 'a PEM holds at most one private key, so a certificate with two keys is refused whole (PemFormat.java:55-57)',
        file: (base) => asFile('two-keys.pem', `${certificate(`${base}-leaf`).pem}${pemTwoKeys()}`, 'application/x-pem-file'),
        text: REFUSAL.pemTooManyKeys,
    },
    {
        row: 'dh-parameters',
        title: 'a PEM with a DH-parameters block is refused as an unsupported block',
        why: 'a DH PARAMETERS block is a PEM type the reader does not take (PemFormat.java:145)',
        file: (base) => asFile('dhparam.pem', `${certificate(`${base}-leaf`).pem}${dhParametersPem()}`, 'application/x-pem-file'),
        text: REFUSAL.pemBlockUnsupported('DH PARAMETERS'),
    },
];

test.describe('REG-CERT-62 import wizard (REG-CERT-63 negatives)', { tag: tags.regression }, () => {
    for (const r of REFUSED) {
        test(`REG-CERT-63[${r.row}]: ${r.title}: red alert with the fixed text, Import disabled, password field offered, nothing created`,
            meta({ id: 'REG-CERT-63', prio: 'P1', issue: ['ilm#428', 'ilm#442'], rule: [RULE_TEXTS, r.why] }),
            async ({ page, api, env }) => {
                const base = importCn(`neg-${r.row}`);
                const file = r.file(base);
                const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
                const wizard = new ImportWizardPage(page);

                await test.step('Log in, open Import certificates and keys, choose the file', async () => {
                    await loginAsSmokeUser(page, env);
                    guards.start(); // after the sign-in: the identity provider's pages are not the wizard's
                    guards.mark(r.row);
                    await wizard.open();
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

    test('REG-CERT-63[pkcs12-wrong-password]: a protected PKCS#12 gives ONE refusal text for a missing and for a wrong password (non-oracular)',
        meta({ id: 'REG-CERT-63', prio: 'P1', issue: ['ilm#428', 'ilm#442'], rule: [RULE_TEXTS, 'inventory-api §6.2 r5: "one non-oracular message" (Pkcs12Mac.verify → ContainerRefusal.INTEGRITY_FAILED, ContainerRefusal.java:21-22)'] }),
        async ({ page, api, env }) => {
            const base = importCn('neg-p12');
            const p12 = pkcs12(`${base}-leaf`, GEN_PW_1);
            const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
            const wizard = new ImportWizardPage(page);

            await test.step('Log in, open the dialog, choose the protected PKCS#12 without a password', async () => {
                await loginAsSmokeUser(page, env);
                guards.start();
                guards.mark('pkcs12');
                await wizard.open();
            });
            const missing = await wizard.chooseFile(asFile('protected.p12', p12.bytes, 'application/x-pkcs12'));
            await test.step('Missing password: 422 integrity text, alert, File password offered, Import disabled', async () => {
                await expectRefusalAnswer(missing, REFUSAL.integrityFailed);
                await wizard.assertRefused(inspectionAlert(422, REFUSAL.integrityFailed));
                await wizard.assertPasswordFieldShown();
                await wizard.assertNoEntries();
                await wizard.assertSubmitDisabled();
            });

            const wrong = await wizard.enterPassword(GEN_PW_2);
            await test.step('Wrong password: the SAME text (a wrong and a missing password cannot be told apart), Import still disabled', async () => {
                await expectRefusalAnswer(wrong, REFUSAL.integrityFailed);
                expect(await wrong.text(), 'wrong and missing password: identical body').toBe(await missing.text());
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

    test('REG-CERT-63[over-limit-5242881]: a file of 5 242 881 bytes is refused by the size rule before its content is read',
        meta({ id: 'REG-CERT-63', prio: 'P1', issue: ['ilm#428', 'ilm#442'], rule: [RULE_TEXTS, 'inventory-api §6.2 r4: the 5 MiB limit answers 422 `fileWithinLimit file must not exceed 5242880 bytes`, never 413 (UploadRequestDto.java:48-51)'] }),
        async ({ page, api, env }) => {
            test.setTimeout(180_000);
            const base = importCn('neg-size');
            // A valid certificate PEM padded to the byte: the content is fine, so only the size rule can refuse it.
            const { file } = paddedCertificatePem(`${base}-leaf`, LIMITS.fileBytes + 1);
            expect(file.length).toBe(5_242_881);
            const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
            const wizard = new ImportWizardPage(page);

            await test.step('Log in, open the dialog, choose the 5 242 881-byte file', async () => {
                await loginAsSmokeUser(page, env);
                guards.start();
                guards.mark('over-limit');
                await wizard.open();
            });
            const answer = await wizard.chooseFile(asFile('over-limit.pem', file, 'application/x-pem-file'));
            skipOnIngressRefusal(answer);

            await test.step('422 with the size text; red alert; Import disabled; File password offered', async () => {
                await expectRefusalAnswer(answer, REFUSAL.fileTooLarge);
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

    test('REG-CERT-63[at-limit-5242880]: the same file one byte shorter passes the size rule and is read as one certificate (boundary pair)',
        meta({ id: 'REG-CERT-63', prio: 'P1', issue: ['ilm#428', 'ilm#442'], rule: [RULE_TEXTS, 'inventory-api §6.4 [neg][api] "5 242 880 decoded bytes pass the size rule, 5 242 881 are refused" (UploadedFile.MAXIMUM_LENGTH, UploadedFile.java:25)'] }),
        async ({ page, api, env }) => {
            test.setTimeout(180_000);
            const base = importCn('neg-size-ok');
            const { file, identity } = paddedCertificatePem(`${base}-leaf`, LIMITS.fileBytes);
            expect(file.length).toBe(5_242_880);
            const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
            const wizard = new ImportWizardPage(page);

            await test.step('Log in, open the dialog, choose the 5 242 880-byte file', async () => {
                await loginAsSmokeUser(page, env);
                guards.start();
                guards.mark('at-limit');
                await wizard.open();
            });
            const answer = await wizard.chooseFile(asFile('at-limit.pem', file, 'application/x-pem-file'));
            skipOnIngressRefusal(answer);

            await test.step('200: one certificate entry whose reference, fingerprint and digest are the ones recomputed from the bytes', async () => {
                expect(answer.status(), 'POST /v1/inspections').toBe(200);
                const body = (await answer.json()) as { containerDigest: string; entries: Array<{ kind: string; entryReference: string; fingerprint?: string }> };
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

    test('REG-CERT-63[csr]: a certificate request is shown as "Signing request" with its checkbox disabled ("Certificate requests are not imported")',
        meta({ id: 'REG-CERT-63', prio: 'P1', issue: ['ilm#428', 'ilm#442'], rule: ['inventory-api §6.2 r8: a certificate request is reported as `signingRequest` and is not importable (ImportWizard/importRequest.ts:38)', RULE_TEXTS] }),
        async ({ page, api, env }) => {
            const base = importCn('neg-csr');
            const csr = csrPem(`${base}-request`);
            const file = Buffer.from(csr.pem);
            const guards = new BrowserGuards(page, { allow: EXPECTED_REFUSAL });
            const wizard = new ImportWizardPage(page);

            await test.step('Log in, open the dialog, choose the CSR file', async () => {
                await loginAsSmokeUser(page, env);
                guards.start();
                guards.mark('csr');
                await wizard.open();
            });
            const answer = await wizard.chooseFile(asFile('request.csr', file, 'application/pkcs10'));

            await test.step('200: one `signingRequest` entry; its reference is the SHA-256 of the request DER', async () => {
                expect(answer.status(), 'POST /v1/inspections').toBe(200);
                const body = (await answer.json()) as { containerDigest: string; entries: Array<{ kind: string; entryReference: string }> };
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
