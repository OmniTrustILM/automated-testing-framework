/**
 * RevokeDialog — the "Revoke Certificate" dialog (REG-CERT-10).
 */
import { expect, Locator, Page } from '@playwright/test';
import { ApiAnswer } from '../utils/regression/apiReads';
import { Logger } from '../utils/Logger';
import { CertificateDetailPage } from './CertificateDetailPage';
import { chooseOption, readSelectOptions } from './ui/select';
import { actAndReadAnswer, UUID } from './ui/waitForResponse';

const logger = new Logger('RevokeDialog');

const PLACEHOLDER_OPTION = /^choose\b/i;

export class RevokeDialog {
    readonly page: Page;

    // Certificate detail page
    readonly detail: CertificateDetailPage;

    // Revoke Certificate dialog
    readonly dialog: Locator;
    readonly reasonTrigger: Locator;
    readonly submitButton: Locator;

    constructor(page: Page) {
        this.page = page;

        this.detail = new CertificateDetailPage(page);

        this.dialog = page.getByRole('dialog', { name: 'Revoke Certificate' });
        this.reasonTrigger = this.dialog.getByTestId('select-revokeReason-trigger');
        this.submitButton = this.dialog.getByTestId('revokeSubmit');
    }

    async open(): Promise<void> {
        logger.info('Opening the Revoke Certificate dialog');
        await this.detail.clickAction('revoke');
        await expect(this.dialog).toBeVisible();
    }

    /** The reason labels in the order shown; the placeholder option is skipped. */
    async reasonLabels(): Promise<string[]> {
        return (await readSelectOptions(this.page, this.reasonTrigger)).filter((label) => !PLACEHOLDER_OPTION.test(label));
    }

    async assertReasons(expected: readonly string[]): Promise<void> {
        const shown = await this.reasonLabels();
        expect([...shown].sort(), 'revoke reasons').toEqual([...expected].sort());
    }

    async chooseReason(label: string): Promise<void> {
        await chooseOption(this.page, this.reasonTrigger, label);
    }

    async submit(): Promise<ApiAnswer> {
        return actAndReadAnswer(this.page, { method: 'POST', path: new RegExp(`/certificates/${UUID}/revoke$`) }, () => this.submitButton.click());
    }
}
