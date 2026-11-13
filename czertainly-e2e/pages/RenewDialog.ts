/**
 * RenewDialog — the "Renew Certificate" dialog (REG-CERT-07); the answer names the successor's uuid.
 * With a platform key the CSR sits behind the "Upload new CSR" switch; with an external key the upload is always shown.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { setSwitch } from './ui/form';
import { actAndReadAnswerWithUuid, AnswerWithUuid, UUID } from './ui/waitForResponse';

const logger = new Logger('RenewDialog');

export class RenewDialog {
    readonly page: Page;

    // Certificate detail page
    readonly detail: CertificateDetailPage;

    // Renew Certificate dialog
    readonly dialog: Locator;
    readonly registerInsteadSwitch: Locator;
    readonly uploadNewCsrSwitch: Locator;
    readonly csrTextarea: Locator;
    readonly challengeInput: Locator;
    /** The FE marks the field as required with this asterisk, not with an HTML `required` attribute. */
    readonly challengeRequiredMark: Locator;
    readonly submitButton: Locator;

    constructor(page: Page) {
        this.page = page;

        this.detail = new CertificateDetailPage(page);

        this.dialog = page.getByRole('dialog', { name: 'Renew Certificate' });
        this.registerInsteadSwitch = this.dialog.getByTestId('switch-registerSuccessor-input');
        this.uploadNewCsrSwitch = this.dialog.getByTestId('switch-uploadCsr-input');
        this.csrTextarea = this.dialog.locator('#__fileUpload__fileContent');
        this.challengeInput = this.dialog.getByTestId('text-input-renewAuthorizationSecret');
        this.challengeRequiredMark = this.dialog.getByTestId('label-renewAuthorizationSecret').locator('.text-danger');
        this.submitButton = this.dialog.getByTestId('renewSubmit');
    }

    async open(): Promise<void> {
        logger.info('Opening the Renew Certificate dialog');
        await this.detail.clickAction('renew');
        await expect(this.dialog).toBeVisible();
    }

    async assertChallengeRequired(): Promise<void> {
        await expect(this.challengeInput).toBeVisible();
        await expect(this.challengeRequiredMark).toBeVisible();
    }

    async assertRegisterOff(): Promise<void> {
        await expect(this.registerInsteadSwitch).toBeVisible();
        await expect(this.registerInsteadSwitch).not.toBeChecked();
    }

    async pasteCsr(csrPem: string): Promise<void> {
        if (await this.uploadNewCsrSwitch.isVisible()) await setSwitch(this.dialog, 'uploadCsr', true);
        await expect(this.csrTextarea).toBeVisible();
        await this.csrTextarea.fill(csrPem);
    }

    async submit(): Promise<AnswerWithUuid> {
        return actAndReadAnswerWithUuid(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/renew$`) }, () => this.submitButton.click());
    }
}
