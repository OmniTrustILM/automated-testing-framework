/**
 * RenewDialog — the "Renew Certificate" dialog (REG-CERT-07).
 *
 * A `CertificateToolbarDialog`: the "Register instead of renewing now" switch, the Challenge field (while a
 * registration authorization is active), the CSR upload and submit. With a platform key the CSR sits behind the
 * "Upload new CSR" switch; with an external key the upload is always shown. The renew answer carries the successor's
 * uuid.
 */
import { expect, Locator, Page } from '@playwright/test';
import { AnswerWithUuid, CertificateToolbarDialog } from './CertificateToolbarDialog';
import { setSwitch } from './ui/form';
import { UUID } from './ui/waitForResponse';

export class RenewDialog extends CertificateToolbarDialog {
    /** The Challenge field (shown only for a certificate with an active registration). */
    readonly challenge: Locator;
    readonly submitButton: Locator;
    /** The dialog's error line after a refused renew. */
    readonly error: Locator;

    constructor(page: Page) {
        super(page, 'Renew Certificate', 'renew');
        this.challenge = this.dialog.getByTestId('text-input-renewAuthorizationSecret');
        this.submitButton = this.dialog.getByTestId('renewSubmit');
        this.error = this.errorLine('renewDialogError');
    }

    /**
     * The Challenge field is shown and marked as required: the FE marks it with the red asterisk of its label, not with an HTML `required`
     * attribute.
     */
    async assertChallengeRequired(): Promise<void> {
        await expect(this.challenge).toBeVisible();
        await expect(this.dialog.getByTestId('label-renewAuthorizationSecret').locator('.text-danger')).toBeVisible();
    }

    /** The "Register instead of renewing now" switch is off: the dialog renews. */
    async assertRegisterOff(): Promise<void> {
        const sw = this.dialog.getByTestId('switch-registerSuccessor-input');
        await expect(sw).toBeVisible();
        await expect(sw).not.toBeChecked();
    }

    /**
     * Paste a CSR. With a platform private key the CSR is optional behind the "Upload new CSR ?" switch; an externally
     * keyed certificate always shows the upload.
     */
    async pasteCsr(csrPem: string): Promise<void> {
        if (await this.dialog.getByTestId('switch-uploadCsr-input').isVisible()) await setSwitch(this.dialog, 'uploadCsr', true);
        const textarea = this.dialog.locator('#__fileUpload__fileContent');
        await expect(textarea).toBeVisible();
        await textarea.fill(csrPem);
    }

    /** Submit; returns the answer of `POST …/renew` (its body names the successor: `uuid`). */
    async submit(): Promise<AnswerWithUuid> {
        return this.answerWithUuid({ method: 'POST', path: new RegExp(`/certificates/${UUID}/renew$`) }, () => this.submitButton.click());
    }
}
