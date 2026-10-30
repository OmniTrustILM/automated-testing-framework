/**
 * CompleteRegistrationDialog — the "Complete Certificate Registration" dialog of a pre-registered certificate
 * (REG-CERT-13).
 *
 * A `CertificateToolbarDialog`: challenge, CSR, submit and the dialog's error line. The completion answer goes back to
 * the spec. Used only on a certificate this run created.
 */
import { expect, Locator, Page } from '@playwright/test';
import { CertificateToolbarDialog } from './CertificateToolbarDialog';
import { ApiAnswer } from '../utils/regression/apiReads';
import { fillText } from './ui/form';
import { UUID } from './ui/waitForResponse';

export class CompleteRegistrationDialog extends CertificateToolbarDialog {
    readonly submitButton: Locator;
    /** The dialog's error line after a refused completion. */
    readonly error: Locator;

    constructor(page: Page) {
        super(page, 'Complete Certificate Registration', 'complete');
        this.submitButton = this.dialog.getByTestId('completeRegisteredSubmit');
        this.error = this.errorLine('completeRegisteredError');
    }

    /** The challenge (when the registration has one) and the CSR (Key Source External = upload). */
    async fill(opts: { secret?: string; csrPem: string }): Promise<void> {
        if (opts.secret !== undefined) {
            const secret = this.dialog.getByTestId('completeAuthorizationSecret');
            await expect(secret).toBeVisible();
            await fillText(secret, opts.secret);
        }
        const textarea = this.dialog.locator('#completeCsrUpload__fileUpload__fileContent');
        await expect(textarea).toBeVisible();
        await textarea.fill(opts.csrPem);
    }

    /** Submit; returns the answer of `POST …/certificates/{uuid}/issue`. */
    async submit(): Promise<ApiAnswer> {
        await expect(this.submitButton).toBeEnabled();
        return this.answerWithUuid({ method: 'POST', path: new RegExp(`/certificates/${UUID}/issue$`) }, () => this.submitButton.click());
    }
}
