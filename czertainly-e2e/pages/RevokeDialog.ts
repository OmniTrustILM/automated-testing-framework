/**
 * RevokeDialog — the "Revoke Certificate" dialog of the certificate detail toolbar: the reason Select (its labels read
 * from the open option list, compared as an exact set), the choice of a reason and submit, which returns the status of
 * the revoke call. Called only on a certificate the run created (the spec checks it with `assertOwnLive` first).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { chooseOption, readSelectOptions } from './ui/select';
import { actAndWaitForApi, UUID } from './ui/waitForResponse';

const logger = new Logger('RevokeDialog');

/** The placeholder option of a Select ("Choose …"): shown in the list, but not a value. */
const PLACEHOLDER_OPTION = /^choose\b/i;

export class RevokeDialog {
    readonly page: Page;
    readonly dialog: Locator;
    private readonly detail: CertificateDetailPage;

    constructor(page: Page) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: 'Revoke Certificate' });
        this.detail = new CertificateDetailPage(page);
    }

    async open(): Promise<Locator> {
        logger.info('Opening the Revoke dialog');
        await this.detail.toolbar.button('revoke').click();
        await expect(this.dialog).toBeVisible();
        return this.dialog;
    }

    get reasonTrigger(): Locator {
        return this.dialog.getByTestId('select-revokeReason-trigger');
    }

    /**
     * The reason labels the dialog offers, in the order shown (the option list is opened, read and closed). A
     * placeholder option ("Choose …") is not a reason and is skipped.
     */
    async reasonLabels(): Promise<string[]> {
        return (await readSelectOptions(this.page, this.reasonTrigger)).filter((label) => !PLACEHOLDER_OPTION.test(label));
    }

    /** The dialog offers exactly these labels (order-insensitive, no extras). */
    async assertReasons(expected: readonly string[]): Promise<void> {
        const shown = await this.reasonLabels();
        expect([...shown].sort(), 'revoke reasons').toEqual([...expected].sort());
    }

    async chooseReason(label: string): Promise<void> {
        await chooseOption(this.page, this.reasonTrigger, label);
    }

    /** Submit; returns the revoke call's status (`POST …/revoke` → 204). */
    async submit(): Promise<{ status: number }> {
        const res = await actAndWaitForApi(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/revoke$`) }, () => this.dialog.getByTestId('revokeSubmit').click());
        return { status: res.status() };
    }
}
