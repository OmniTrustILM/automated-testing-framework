/**
 * ImportWizardPage — the "Import certificates and keys" dialog of the certificate inventory (fe-administrator
 * `_pages/certificates/ImportWizard/*`, `CertificateImportDialog`, fe#2073 / #2239 / #2274): REG-CERT-63 now, REG-CERT-62 /
 * 64 / 65 / 66 / 67 (B5) later.
 *
 * What the dialog is (origin/main): a Radix dialog captioned "Import certificates and keys" opened by the list's
 * `upload-button`. One form: a "File content" textarea (`import-file-content`, paste), a hidden file input ("Select
 * file"), then — after the file is read through `POST /api/v1/inspections` — a red `role="alert"` Callout
 * `Failed to read the uploaded file (<status>): <messages>` when core refuses it (a refusal of status 422 also shows the
 * "File password" field: a protected file is not told apart from a wrong password), or the section "Detected content –
 * N entries" (`import-detected-content`) with one checkbox per entry, all supported entries pre-selected, and the
 * submit button `import-submit` ("Import N entries", disabled while nothing is selectable). A submitted import shows
 * `import-results` (badges `import-result-badge`) and `import-done`, the only way the dialog closes besides Cancel.
 *
 * Every method that sends the inspection or the import registers the response wait BEFORE the action that triggers it
 * (observe, never mock) and returns the response, so a spec can read the status and the body it asserts on. This page
 * object never submits an import: REG-CERT-63 inspects only (nothing is created); `submit()` exists for the specs that
 * import their own run-named certificates.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import { Logger } from '../utils/Logger';

const logger = new Logger('ImportWizardPage');

/** A file the browser chooser takes (Playwright's `FilePayload`). */
export interface ChosenFile {
    name: string;
    mimeType: string;
    buffer: Buffer;
}

const isInspection = (r: Response): boolean => r.request().method() === 'POST' && /\/api\/v1\/inspections$/.test(new URL(r.url()).pathname);
const isImport = (r: Response): boolean => r.request().method() === 'POST' && /\/api\/v1\/certificates\/import$/.test(new URL(r.url()).pathname);

export class ImportWizardPage {
    readonly page: Page;
    readonly main: Locator;
    readonly uploadButton: Locator;
    readonly dialog: Locator;
    readonly fileContent: Locator;
    readonly fileInput: Locator;
    readonly password: Locator;
    readonly detected: Locator;
    readonly submitButton: Locator;
    readonly results: Locator;
    readonly doneButton: Locator;
    readonly cancelButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.uploadButton = this.main.getByTestId('upload-button');
        this.dialog = page.getByRole('dialog', { name: 'Import certificates and keys' });
        this.fileContent = this.dialog.getByTestId('import-file-content');
        // The input is visually hidden (class `hidden`); setInputFiles works on it all the same.
        this.fileInput = this.dialog.locator('input[type="file"]');
        this.password = this.dialog.getByLabel('File password');
        this.detected = this.dialog.getByTestId('import-detected-content');
        this.submitButton = this.dialog.getByTestId('import-submit');
        this.results = this.dialog.getByTestId('import-results');
        this.doneButton = this.dialog.getByTestId('import-done');
        this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
    }

    // ---------------------------------------------------------------- open / close

    /** The certificate inventory → the upload button → the dialog (the list is opened by its route, not by the sidebar). */
    async open(): Promise<void> {
        logger.info('Opening Import certificates and keys');
        await this.page.goto('administrator/#/certificates');
        await expect(this.main).toBeVisible();
        await this.uploadButton.click();
        await expect(this.dialog).toBeVisible();
    }

    /** Cancel (never imports anything). */
    async cancel(): Promise<void> {
        await this.cancelButton.click();
        await expect(this.dialog).toBeHidden();
    }

    /** Done: the only way the dialog closes after an import. */
    async done(): Promise<void> {
        await this.doneButton.click();
        await expect(this.dialog).toBeHidden();
    }

    // ---------------------------------------------------------------- input

    /** Types the text into "File content" (a PEM, usually) and leaves the field: the file is read on blur. Resolves with the inspection answer. */
    async pasteContent(text: string): Promise<Response> {
        logger.info(`Pasting ${text.length} characters`);
        const answer = this.page.waitForResponse(isInspection);
        await this.fileContent.fill(text);
        await this.fileContent.blur();
        return answer;
    }

    /** Chooses a file (bytes in memory, never on disk) and resolves with the inspection answer. */
    async chooseFile(file: ChosenFile): Promise<Response> {
        logger.info(`Choosing a file of ${file.buffer.length} bytes`);
        const answer = this.page.waitForResponse(isInspection, { timeout: 90_000 });
        await this.fileInput.setInputFiles(file);
        return answer;
    }

    /** Types the file password and presses Enter: the file is read again with it (Enter never submits the form). */
    async enterPassword(password: string): Promise<Response> {
        logger.info('Entering the file password');
        await expect(this.password).toBeVisible();
        const answer = this.page.waitForResponse(isInspection);
        await this.password.fill(password);
        await this.password.press('Enter');
        return answer;
    }

    /** Clicks the import button and resolves with the import answer (only for specs that import their own run-named objects). */
    async submit(): Promise<Response> {
        await expect(this.submitButton).toBeEnabled();
        const answer = this.page.waitForResponse(isImport);
        await this.submitButton.click();
        return answer;
    }

    // ---------------------------------------------------------------- assertions

    /** The red alert of the wizard for a refused inspection, with exactly this text. */
    async assertRefused(text: string): Promise<void> {
        const alert = this.dialog.getByRole('alert').filter({ hasText: /^Failed to read the uploaded file/ });
        await expect(alert).toHaveCount(1);
        await expect(alert).toBeVisible();
        await expect(alert).toHaveText(text);
    }

    /** No inspection refusal is shown. */
    async assertNotRefused(): Promise<void> {
        await expect(this.dialog.getByRole('alert').filter({ hasText: /^Failed to read the uploaded file/ })).toHaveCount(0);
    }

    /** "Detected content – N entries" (`entry` / `entries`), all entries listed. */
    async assertDetected(count: number): Promise<void> {
        await expect(this.detected).toBeVisible();
        await expect(this.detected.getByRole('heading', { name: `Detected content – ${count} ${count === 1 ? 'entry' : 'entries'}` })).toBeVisible();
        await expect(this.detected.getByRole('listitem')).toHaveCount(count);
    }

    /** No entries are shown (the file was refused or none was read). */
    async assertNoEntries(): Promise<void> {
        await expect(this.detected).toBeHidden();
    }

    /** The import button is disabled (nothing selectable, or a refusal). */
    async assertSubmitDisabled(): Promise<void> {
        await expect(this.submitButton).toBeVisible();
        await expect(this.submitButton).toBeDisabled();
    }

    /** The "File password" field is shown (the inspection answered 422, or the entries were read with a password). */
    async assertPasswordFieldShown(): Promise<void> {
        await expect(this.password).toBeVisible();
    }

    /** The "File password" field is not offered (the FE does not render it; a hidden element counts as not offered too). */
    async assertPasswordFieldHidden(): Promise<void> {
        await expect(this.password).toBeHidden();
    }

    /**
     * A certificate request is listed as one entry: kind badge "Signing request", its checkbox disabled and unchecked, the
     * reason "Certificate requests are not imported" (ImportWizard/importRequest.ts:38), and Import disabled.
     */
    async assertSigningRequest(reason: string): Promise<void> {
        await expect(this.detected).toBeVisible();
        const entry = this.detected.getByRole('listitem');
        await expect(entry).toHaveCount(1);
        await expect(entry.getByRole('checkbox')).toBeDisabled();
        await expect(entry.getByRole('checkbox')).not.toBeChecked();
        await expect(entry.getByTestId('badge')).toHaveText('Signing request');
        await expect(entry).toContainText(reason);
        await this.assertSubmitDisabled();
    }

    /** The import results region lists these badges, in order (`Imported`, `Already in inventory`, `Not imported`, …). */
    async assertResults(badges: string[]): Promise<void> {
        await expect(this.results).toBeVisible();
        await expect(this.results.getByTestId('import-result-badge')).toHaveText(badges);
    }
}
