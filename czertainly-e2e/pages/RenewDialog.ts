/**
 * RenewDialog — the "Renew Certificate" dialog (REG-CERT-07).
 *
 * The "Register instead of renewing now" switch, the Challenge field (while a registration authorization is active), the
 * CSR upload and submit. With a platform key the CSR sits behind the "Upload new CSR" switch; with an external key the
 * upload is always shown. The renew answer carries the successor's uuid.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { setSwitch } from './ui/form';
import { actAndReadAnswerWithUuid, AnswerWithUuid, UUID } from './ui/waitForResponse';

const logger = new Logger('RenewDialog');

export class RenewDialog {
    readonly page: Page;

    // Certificate detail toolbar
    readonly renewButton: Locator;

    // Renew Certificate dialog
    readonly dialog: Locator;
    readonly registerInsteadSwitch: Locator;
    readonly uploadNewCsrSwitch: Locator;
    readonly csrTextarea: Locator;
    /** The Challenge field (shown only for a certificate with an active registration). */
    readonly challengeInput: Locator;
    /** The red asterisk of the Challenge label: the FE marks the field as required with it, not with an HTML `required` attribute. */
    readonly challengeRequiredMark: Locator;
    readonly submitButton: Locator;

    constructor(page: Page) {
        this.page = page;

        // Certificate detail toolbar
        this.renewButton = new CertificateDetailPage(page).renewButton;

        // Renew Certificate dialog
        this.dialog = page.getByRole('dialog', { name: 'Renew Certificate' });
        this.registerInsteadSwitch = this.dialog.getByTestId('switch-registerSuccessor-input');
        this.uploadNewCsrSwitch = this.dialog.getByTestId('switch-uploadCsr-input');
        this.csrTextarea = this.dialog.locator('#__fileUpload__fileContent');
        this.challengeInput = this.dialog.getByTestId('text-input-renewAuthorizationSecret');
        this.challengeRequiredMark = this.dialog.getByTestId('label-renewAuthorizationSecret').locator('.text-danger');
        this.submitButton = this.dialog.getByTestId('renewSubmit');
    }

    /** Opens the dialog from the toolbar of the certificate detail page that is shown. */
    async open(): Promise<void> {
        logger.info('Opening the Renew Certificate dialog');
        await this.renewButton.click();
        await expect(this.dialog).toBeVisible();
    }

    /** The Challenge field is shown and marked as required. */
    async assertChallengeRequired(): Promise<void> {
        await expect(this.challengeInput).toBeVisible();
        await expect(this.challengeRequiredMark).toBeVisible();
    }

    /** The "Register instead of renewing now" switch is off: the dialog renews. */
    async assertRegisterOff(): Promise<void> {
        await expect(this.registerInsteadSwitch).toBeVisible();
        await expect(this.registerInsteadSwitch).not.toBeChecked();
    }

    /**
     * Paste a CSR. With a platform private key the CSR is optional behind the "Upload new CSR ?" switch; an externally
     * keyed certificate always shows the upload.
     */
    async pasteCsr(csrPem: string): Promise<void> {
        if (await this.uploadNewCsrSwitch.isVisible()) await setSwitch(this.dialog, 'uploadCsr', true);
        await expect(this.csrTextarea).toBeVisible();
        await this.csrTextarea.fill(csrPem);
    }

    /** Submit; returns the answer of `POST …/renew` (its body names the successor: `uuid`). */
    async submit(): Promise<AnswerWithUuid> {
        return actAndReadAnswerWithUuid(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/renew$`) }, () => this.submitButton.click());
    }
}
