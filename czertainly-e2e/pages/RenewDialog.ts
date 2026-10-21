/**
 * RenewDialog — the "Renew Certificate" dialog of the certificate detail toolbar: the "Register instead of renewing now"
 * switch, the Challenge field (shown while the certificate's registration authorization is active), the CSR upload and
 * submit, which returns the renew answer with the successor's uuid. Called only on a certificate the run created (the
 * spec checks it with `assertOwnLive` first).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { actAndWaitForApi, UUID } from './ui/waitForResponse';

const logger = new Logger('RenewDialog');

export class RenewDialog {
    readonly page: Page;
    readonly dialog: Locator;
    private readonly detail: CertificateDetailPage;

    constructor(page: Page) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: 'Renew Certificate' });
        this.detail = new CertificateDetailPage(page);
    }

    async open(): Promise<Locator> {
        logger.info('Opening the Renew dialog');
        await this.detail.toolbar.button('renew').click();
        await expect(this.dialog).toBeVisible();
        return this.dialog;
    }

    /** The "Register instead of renewing now" switch is off: the dialog renews. */
    async assertRegisterOff(): Promise<void> {
        const sw = this.dialog.getByTestId('switch-registerSuccessor-input');
        await expect(sw).toBeVisible();
        await expect(sw).not.toBeChecked();
    }

    /** The Challenge field (shown only for a certificate with an active registration). */
    get challenge(): Locator {
        return this.dialog.getByTestId('text-input-renewAuthorizationSecret');
    }

    get submitButton(): Locator {
        return this.dialog.getByTestId('renewSubmit');
    }

    /**
     * Paste a CSR. With a platform private key the CSR is optional behind the "Upload new CSR ?" switch; an externally
     * keyed certificate always shows the upload.
     */
    async pasteCsr(csrPem: string): Promise<void> {
        const uploadSwitch = this.dialog.getByTestId('switch-uploadCsr-input');
        if (await uploadSwitch.isVisible()) {
            if (!(await uploadSwitch.isChecked())) await uploadSwitch.click();
        }
        const textarea = this.dialog.locator('#__fileUpload__fileContent');
        await expect(textarea).toBeVisible();
        await textarea.fill(csrPem);
    }

    /** Submit; returns the status and the uuid the renew call answered (`POST …/renew` → `{uuid}`). */
    async submit(): Promise<{ status: number; uuid?: string }> {
        const res = await actAndWaitForApi(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/renew$`) }, () => this.submitButton.click());
        let uuid: string | undefined;
        try {
            uuid = (JSON.parse(await res.text()) as { uuid?: string }).uuid;
        } catch {
            uuid = undefined; // a body that is not JSON names no successor
        }
        return { status: res.status(), uuid };
    }

    get error(): Locator {
        return this.dialog.getByTestId('renewDialogError');
    }
}
