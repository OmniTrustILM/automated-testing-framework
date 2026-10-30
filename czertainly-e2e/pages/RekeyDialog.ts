/**
 * RekeyDialog — the "Rekey Certificate" dialog (REG-CERT-08).
 *
 * A `CertificateToolbarDialog`: Key Source External with the CSR upload, submit and the error line. The answer with
 * the successor's uuid goes back to the spec. Used only on a certificate this run created.
 */
import { expect, Locator, Page } from '@playwright/test';
import { AnswerWithUuid, CertificateToolbarDialog } from './CertificateToolbarDialog';
import { chooseOption } from './ui/select';
import { UUID } from './ui/waitForResponse';

export class RekeyDialog extends CertificateToolbarDialog {
    readonly submitButton: Locator;
    /** The dialog's error line after a refused rekey. */
    readonly error: Locator;

    constructor(page: Page) {
        super(page, 'Rekey Certificate', 'rekey');
        this.submitButton = this.dialog.getByRole('button', { name: /^(Rekey|Register)$/ });
        this.error = this.errorLine('rekeyDialogError');
    }

    /** Key Source → External, then the CSR into the upload. */
    async fillExternal(csrPem: string): Promise<void> {
        await chooseOption(this.page, this.dialog.getByTestId('select-uploadCsr-trigger'), 'External');
        const textarea = this.dialog.locator('#__fileUpload__fileContent');
        await expect(textarea).toBeVisible();
        await textarea.fill(csrPem);
    }

    /** Submit; returns the answer of `POST …/rekey` (its body names the successor: `uuid`). */
    async submit(): Promise<AnswerWithUuid> {
        await expect(this.submitButton).toBeEnabled();
        return this.answerWithUuid({ method: 'POST', path: new RegExp(`/certificates/${UUID}/rekey$`) }, () => this.submitButton.click());
    }
}
