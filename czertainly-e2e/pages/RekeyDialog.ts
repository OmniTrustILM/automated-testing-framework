/**
 * RekeyDialog — the "Rekey Certificate" dialog (REG-CERT-08).
 *
 * Key Source External with the CSR upload, submit and the error line. The answer with the successor's uuid goes back to
 * the spec. Used only on a certificate this run created.
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
    /** The dialog's error line after a refused rekey. */
    readonly error: Locator;

    constructor(page: Page) {
        this.page = page;

        // Certificate detail toolbar
        this.rekeyButton = new CertificateDetailPage(page).rekeyButton;

        // Rekey Certificate dialog
        this.dialog = page.getByRole('dialog', { name: 'Rekey Certificate' });
        this.keySourceTrigger = this.dialog.getByTestId('select-uploadCsr-trigger');
        this.csrTextarea = this.dialog.locator('#__fileUpload__fileContent');
        this.submitButton = this.dialog.getByRole('button', { name: /^(Rekey|Register)$/ });
        this.cancelButton = this.dialog.getByRole('button', { name: 'Cancel', exact: true });
        this.error = this.dialog.getByTestId('rekeyDialogError');
    }

    /** Opens the dialog from the toolbar of the certificate detail page that is shown. */
    async open(): Promise<void> {
        logger.info('Opening the Rekey Certificate dialog');
        await this.rekeyButton.click();
        await expect(this.dialog).toBeVisible();
    }

    /** Cancels the dialog and waits until it is gone. */
    async close(): Promise<void> {
        await this.cancelButton.click();
        await expect(this.dialog).toBeHidden();
    }

    /** Key Source → External, then the CSR into the upload. */
    async fillExternal(csrPem: string): Promise<void> {
        await chooseOption(this.page, this.keySourceTrigger, 'External');
        await expect(this.csrTextarea).toBeVisible();
        await this.csrTextarea.fill(csrPem);
    }

    /** Submit; returns the answer of `POST …/rekey` (its body names the successor: `uuid`). */
    async submit(): Promise<AnswerWithUuid> {
        await expect(this.submitButton).toBeEnabled();
        return actAndReadAnswerWithUuid(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/rekey$`) }, () => this.submitButton.click());
    }
}
