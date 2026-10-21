/**
 * RekeyDialog — the "Rekey Certificate" dialog of the certificate detail toolbar: Key Source External with the CSR
 * upload, submit (returns the rekey answer with the successor's uuid and the body text) and the dialog's error line.
 * Called only on a certificate the run created (the spec checks it with `assertOwnLive` first).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { chooseOption } from './ui/select';
import { actAndWaitForApi, UUID } from './ui/waitForResponse';

const logger = new Logger('RekeyDialog');

export class RekeyDialog {
    readonly page: Page;
    readonly dialog: Locator;
    private readonly detail: CertificateDetailPage;

    constructor(page: Page) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: 'Rekey Certificate' });
        this.detail = new CertificateDetailPage(page);
    }

    async open(): Promise<Locator> {
        logger.info('Opening the Rekey dialog');
        await this.detail.toolbar.button('rekey').click();
        await expect(this.dialog).toBeVisible();
        return this.dialog;
    }

    /** Key Source → External, then the CSR into the upload. */
    async fillExternal(csrPem: string): Promise<void> {
        await chooseOption(this.page, this.dialog.getByTestId('select-uploadCsr-trigger'), 'External');
        const textarea = this.dialog.locator('#__fileUpload__fileContent');
        await expect(textarea).toBeVisible();
        await textarea.fill(csrPem);
    }

    get submitButton(): Locator {
        return this.dialog.getByRole('button', { name: /^(Rekey|Register)$/ });
    }

    /** Submit; returns the rekey call's answer (`POST …/rekey`). */
    async submit(): Promise<{ status: number; uuid?: string; text: string }> {
        await expect(this.submitButton).toBeEnabled();
        const res = await actAndWaitForApi(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/rekey$`) }, () => this.submitButton.click());
        const text = await res.text();
        let uuid: string | undefined;
        try {
            uuid = (JSON.parse(text) as { uuid?: string }).uuid;
        } catch {
            uuid = undefined; // a body that is not JSON names no successor
        }
        return { status: res.status(), uuid, text };
    }

    get error(): Locator {
        return this.dialog.getByTestId('rekeyDialogError');
    }

    async close(): Promise<void> {
        await this.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(this.dialog).toBeHidden();
    }
}
