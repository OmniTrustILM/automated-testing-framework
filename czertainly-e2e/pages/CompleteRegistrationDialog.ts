/**
 * CompleteRegistrationDialog — the "Complete Certificate Registration" dialog of a pre-registered certificate (REG-CERT-13).
 */
import { expect, Locator, Page } from '@playwright/test';
import { ApiAnswer } from '../utils/regression/apiReads';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { fillText } from './ui/form';
import { actAndReadAnswer, UUID } from './ui/waitForResponse';

const logger = new Logger('CompleteRegistrationDialog');

export class CompleteRegistrationDialog {
    readonly page: Page;

    // Certificate detail toolbar
    readonly completeButton: Locator;

    // Complete Certificate Registration dialog
    readonly dialog: Locator;
    readonly challengeInput: Locator;
    readonly csrTextarea: Locator;
    readonly submitButton: Locator;
    readonly cancelButton: Locator;
    readonly error: Locator;

    constructor(page: Page) {
        this.page = page;

        this.completeButton = new CertificateDetailPage(page).completeButton;

        this.dialog = page.getByRole('dialog', { name: 'Complete Certificate Registration' });
        this.challengeInput = this.dialog.getByTestId('completeAuthorizationSecret');
        this.csrTextarea = this.dialog.locator('#completeCsrUpload__fileUpload__fileContent');
        this.submitButton = this.dialog.getByTestId('completeRegisteredSubmit');
        this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
        this.error = this.dialog.getByTestId('completeRegisteredError');
    }

    async open(): Promise<void> {
        logger.info('Opening the Complete Certificate Registration dialog');
        await this.completeButton.click();
        await expect(this.dialog).toBeVisible();
    }

    async close(): Promise<void> {
        await this.cancelButton.click();
        await expect(this.dialog).toBeHidden();
    }

    async fill(opts: { secret?: string; csrPem: string }): Promise<void> {
        if (opts.secret !== undefined) {
            await expect(this.challengeInput).toBeVisible();
            await fillText(this.challengeInput, opts.secret);
        }
        await expect(this.csrTextarea).toBeVisible();
        await this.csrTextarea.fill(opts.csrPem);
    }

    async submit(): Promise<ApiAnswer> {
        await expect(this.submitButton).toBeEnabled();
        return actAndReadAnswer(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/issue$`) }, () => this.submitButton.click());
    }
}
