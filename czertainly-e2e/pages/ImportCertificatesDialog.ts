/**
 * ImportCertificatesDialog — the "Import certificates and keys" dialog (REG-USE-03).
 *
 * REG-USE-03 imports one run-named PEM, reads a protected PKCS#12 with its password and shows a CSR as not importable.
 * Every method that causes the inspection or the import returns its answer. The file input is hidden but takes
 * `setInputFiles`. Enter in the password field re-reads the file and never submits.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { Logger } from '../utils/Logger';
import { actAndReadAnswer, actAndWaitForApi, ApiCall } from './ui/waitForResponse';
import { INSPECTION_ANSWER_MS } from '../utils/regression/timeouts';

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

    // Import certificates and keys dialog
    readonly dialog: Locator;
    /** The file chooser's input: visually hidden (class `hidden`); setInputFiles works on it all the same. */
    readonly fileInput: Locator;
    readonly passwordInput: Locator;
    readonly detectedContent: Locator;
    readonly submitButton: Locator;
    readonly cancelButton: Locator;

    // After the import
    readonly importResults: Locator;

    constructor(page: Page) {
        this.page = page;

        // Import certificates and keys dialog
        this.dialog = page.getByRole('dialog', { name: 'Import certificates and keys' });
        this.fileInput = this.dialog.locator('input[type="file"]');
        this.passwordInput = this.dialog.getByLabel('File password');
        this.detectedContent = this.dialog.getByTestId('import-detected-content');
        this.submitButton = this.dialog.getByTestId('import-submit');
        this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });

        // After the import
        this.importResults = this.dialog.getByTestId('import-results');
    }

    /** Cancel (never imports anything). */
    async cancel(): Promise<void> {
        await this.cancelButton.click();
        await expect(this.dialog).toBeHidden();
    }

    /** Chooses a file (bytes in memory, never on disk) and resolves with the inspection answer. */
    async chooseFile(file: ChosenFile): Promise<ApiAnswer> {
        logger.info(`Choosing a file of ${file.buffer.length} bytes`);
        return actAndReadAnswer(this.page, { ...INSPECTION, timeout: INSPECTION_ANSWER_MS }, () => this.fileInput.setInputFiles(file));
    }

    /** Types the file password and presses Enter: the file is read again with it (Enter never submits the form). */
    async enterPassword(password: string): Promise<ApiAnswer> {
        logger.info('Entering the file password');
        await expect(this.passwordInput).toBeVisible();
        return actAndReadAnswer(this.page, INSPECTION, async () => {
            await this.passwordInput.fill(password);
            await this.passwordInput.press('Enter');
        });
    }

    /** Clicks Import and returns the browser's response to the import call, for `CertificatePage.submitImport`, whose callers read it as one. */
    async submitForResponse(): Promise<Response> {
        await expect(this.submitButton).toBeEnabled();
        return actAndWaitForApi(this.page, IMPORT, () => this.submitButton.click());
    }

    /** No entries are shown (the file was refused or none was read). */
    async assertNoEntries(): Promise<void> {
        await expect(this.detectedContent).toBeHidden();
    }

    /** The import button is disabled (nothing selectable, or a refusal). */
    async assertSubmitDisabled(): Promise<void> {
        await expect(this.submitButton).toBeVisible();
        await expect(this.submitButton).toBeDisabled();
    }

    /** The "File password" field is shown (the inspection answered 422, or the entries were read with a password). */
    async assertPasswordFieldShown(): Promise<void> {
        await expect(this.passwordInput).toBeVisible();
    }

    /** The import results region lists these badges, in order (`Imported`, `Already in inventory`, `Not imported`, …). */
    async assertResults(badges: string[]): Promise<void> {
        await expect(this.importResults).toBeVisible();
        await expect(this.importResults.getByTestId('import-result-badge')).toHaveText(badges);
    }
}
