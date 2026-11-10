/**
 * ImportCertificatesDialog — the "Import certificates and keys" dialog (REG-USE-03).
 * Every method that causes the inspection or the import returns its
 * answer. Enter in the password field re-reads the file and never submits.
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { Logger } from '../utils/Logger';
import { actAndReadAnswer, actAndWaitForApi, ApiCall } from './ui/waitForResponse';
import { INSPECTION_ANSWER_MS } from '../utils/regression/timeouts';

const logger = new Logger('ImportCertificatesDialog');

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
    /** Visually hidden, but `setInputFiles` works on it. */
    readonly fileInput: Locator;
    readonly passwordInput: Locator;
    readonly detectedContent: Locator;
    readonly submitButton: Locator;
    readonly cancelButton: Locator;

    // After the import
    readonly importResults: Locator;

    constructor(page: Page) {
        this.page = page;

        this.dialog = page.getByRole('dialog', { name: 'Import certificates and keys' });
        this.fileInput = this.dialog.locator('input[type="file"]');
        this.passwordInput = this.dialog.getByLabel('File password');
        this.detectedContent = this.dialog.getByTestId('import-detected-content');
        this.submitButton = this.dialog.getByTestId('import-submit');
        this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });

        this.importResults = this.dialog.getByTestId('import-results');
    }

    async cancel(): Promise<void> {
        await this.cancelButton.click();
        await expect(this.dialog).toBeHidden();
    }

    async chooseFile(file: ChosenFile): Promise<ApiAnswer> {
        logger.info(`Choosing a file of ${file.buffer.length} bytes`);
        return actAndReadAnswer(this.page, { ...INSPECTION, timeout: INSPECTION_ANSWER_MS }, () => this.fileInput.setInputFiles(file));
    }

    async enterPassword(password: string): Promise<ApiAnswer> {
        logger.info('Entering the file password');
        await expect(this.passwordInput).toBeVisible();
        return actAndReadAnswer(this.page, INSPECTION, async () => {
            await this.passwordInput.fill(password);
            await this.passwordInput.press('Enter');
        });
    }

    /** Clicks Import and returns the browser's response, for `CertificatePage.submitImport`. */
    async submitForResponse(): Promise<Response> {
        await expect(this.submitButton).toBeEnabled();
        return actAndWaitForApi(this.page, IMPORT, () => this.submitButton.click());
    }

    async assertNoEntries(): Promise<void> {
        await expect(this.detectedContent).toBeHidden();
    }

    async assertSubmitDisabled(): Promise<void> {
        await expect(this.submitButton).toBeVisible();
        await expect(this.submitButton).toBeDisabled();
    }

    async assertPasswordFieldShown(): Promise<void> {
        await expect(this.passwordInput).toBeVisible();
    }

    async assertResults(badges: string[]): Promise<void> {
        await expect(this.importResults).toBeVisible();
        await expect(this.importResults.getByTestId('import-result-badge')).toHaveText(badges);
    }
}
