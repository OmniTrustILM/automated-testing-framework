/**
 * RekeyDialog — the "Rekey Certificate" dialog (REG-CERT-08); the answer names the successor's uuid.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { chooseOption } from './ui/select';
import { actAndReadAnswerWithUuid, AnswerWithUuid, UUID } from './ui/waitForResponse';

const logger = new Logger('RekeyDialog');

export class RekeyDialog {
    readonly page: Page;

    // Certificate detail toolbar
    readonly rekeyButton: Locator;

    // Rekey Certificate dialog
    readonly dialog: Locator;
    readonly keySourceTrigger: Locator;
    readonly csrTextarea: Locator;
    readonly submitButton: Locator;
    readonly cancelButton: Locator;
    readonly error: Locator;

    constructor(page: Page) {
        this.page = page;

        this.rekeyButton = new CertificateDetailPage(page).rekeyButton;

        this.dialog = page.getByRole('dialog', { name: 'Rekey Certificate' });
        this.keySourceTrigger = this.dialog.getByTestId('select-uploadCsr-trigger');
        this.csrTextarea = this.dialog.locator('#__fileUpload__fileContent');
        this.submitButton = this.dialog.getByRole('button', { name: /^(Rekey|Register)$/ });
        this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
        this.error = this.dialog.getByTestId('rekeyDialogError');
    }

    async open(): Promise<void> {
        logger.info('Opening the Rekey Certificate dialog');
        await this.rekeyButton.click();
        await expect(this.dialog).toBeVisible();
    }

    async close(): Promise<void> {
        await this.cancelButton.click();
        await expect(this.dialog).toBeHidden();
    }

    async fillExternal(csrPem: string): Promise<void> {
        await chooseOption(this.page, this.keySourceTrigger, 'External');
        await expect(this.csrTextarea).toBeVisible();
        await this.csrTextarea.fill(csrPem);
    }

    async submit(): Promise<AnswerWithUuid> {
        await expect(this.submitButton).toBeEnabled();
        return actAndReadAnswerWithUuid(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/rekey$`) }, () => this.submitButton.click());
    }
}
