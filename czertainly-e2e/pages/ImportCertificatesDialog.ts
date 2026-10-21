/**
 * ImportCertificatesDialog — the "Import certificates and keys" dialog of the certificate list: paste or choose a file,
 * read the inspection answer (the refusal alert, the password field, the detected entries) and import the selected
 * entries. Every method that sends the inspection or the import waits for its response from before the click (observe,
 * never mock) and returns it. Nothing here imports unless a spec calls `submit()` with its own run-named content.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { actAndWaitForApi, ApiCall } from './ui/waitForResponse';

const logger = new Logger('ImportCertificatesDialog');

/** A file the browser chooser takes (Playwright's `FilePayload`). */
export interface ChosenFile {
    name: string;
    mimeType: string;
    buffer: Buffer;
}

const INSPECTION: ApiCall = { method: 'POST', path: /\/api\/v1\/inspections$/ };
const IMPORT: ApiCall = { method: 'POST', path: /\/api\/v1\/certificates\/import$/ };

export class ImportCertificatesDialog {
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

    /** The certificate list, opened by its route (not by the sidebar). */
    async goToList(): Promise<void> {
        await this.page.goto('administrator/#/certificates');
        await expect(this.main).toBeVisible();
    }

    /** The list's upload button → the dialog. */
    async openDialog(): Promise<void> {
        logger.info('Opening Import certificates and keys');
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
        return actAndWaitForApi(this.page, INSPECTION, async () => {
            await this.fileContent.fill(text);
            await this.fileContent.blur();
        });
    }

    /** Chooses a file (bytes in memory, never on disk) and resolves with the inspection answer. */
    async chooseFile(file: ChosenFile): Promise<Response> {
        logger.info(`Choosing a file of ${file.buffer.length} bytes`);
        return actAndWaitForApi(this.page, { ...INSPECTION, timeout: 90_000 }, () => this.fileInput.setInputFiles(file));
    }

    /** Types the file password and presses Enter: the file is read again with it (Enter never submits the form). */
    async enterPassword(password: string): Promise<Response> {
        logger.info('Entering the file password');
        await expect(this.password).toBeVisible();
        return actAndWaitForApi(this.page, INSPECTION, async () => {
            await this.password.fill(password);
            await this.password.press('Enter');
        });
    }

    /** Clicks the import button and resolves with the import answer (only for specs that import their own run-named objects). */
    async submit(): Promise<Response> {
        await expect(this.submitButton).toBeEnabled();
        return actAndWaitForApi(this.page, IMPORT, () => this.submitButton.click());
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
