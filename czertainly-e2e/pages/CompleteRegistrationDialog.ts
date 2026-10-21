/**
 * CompleteRegistrationDialog — the "Complete Certificate Registration" dialog of a pre-registered certificate (toolbar
 * Complete): the challenge (when the registration has one) and the CSR, submit (returns the answer of the completion
 * call, `POST …/certificates/{uuid}/issue`) and the dialog's error line. Called only on a certificate the run created.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { fillText } from './ui/form';
import { actAndWaitForApi, UUID } from './ui/waitForResponse';

const logger = new Logger('CompleteRegistrationDialog');

export class CompleteRegistrationDialog {
    readonly page: Page;
    readonly dialog: Locator;
    private readonly detail: CertificateDetailPage;

    constructor(page: Page) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: 'Complete Certificate Registration' });
        this.detail = new CertificateDetailPage(page);
    }

    async open(): Promise<Locator> {
        logger.info('Opening the Complete dialog');
        await this.detail.toolbar.button('complete').click();
        await expect(this.dialog).toBeVisible();
        return this.dialog;
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

    /** Submit; returns the completion call's answer (`POST …/certificates/{uuid}/issue`). */
    async submit(): Promise<{ status: number; text: string }> {
        const submit = this.dialog.getByTestId('completeRegisteredSubmit');
        await expect(submit).toBeEnabled();
        const res = await actAndWaitForApi(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/issue$`) }, () => submit.click());
        return { status: res.status(), text: await res.text() };
    }

    get error(): Locator {
        return this.dialog.getByTestId('completeRegisteredError');
    }

    async close(): Promise<void> {
        await this.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(this.dialog).toBeHidden();
    }
}
