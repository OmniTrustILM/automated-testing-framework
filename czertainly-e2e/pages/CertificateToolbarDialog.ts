/**
 * CertificateToolbarDialog — what the dialogs opened from the certificate detail toolbar have in common.
 *
 * Base for the Renew, Rekey, Revoke and Complete Registration dialogs: the dialog by its accessible name, `open()`,
 * `close()`, the error line, and `answerWithUuid`, the one reader of a lifecycle answer (the answer plus the successor's
 * uuid when the body names one).
 *
 * The subclasses keep only their form fields and `submit()`.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { CertificateDetailPage } from './CertificateDetailPage';
import { ToolbarButtonName } from './ui/toolbar';
import { actAndWaitForApi, answerFrom, ApiCall } from './ui/waitForResponse';

const logger = new Logger('CertificateToolbarDialog');

/** The answer of a lifecycle request, with the uuid of the successor certificate when the answer names one. */
export type AnswerWithUuid = ApiAnswer & { uuid?: string };

export abstract class CertificateToolbarDialog {
    protected readonly page: Page;
    readonly dialog: Locator;
    private readonly detail: CertificateDetailPage;

    /** `caption`: the dialog's accessible name; `action`: the toolbar button that opens it. */
    protected constructor(page: Page, private readonly caption: string, private readonly action: ToolbarButtonName) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: caption });
        this.detail = new CertificateDetailPage(page);
    }

    /** Opens the dialog from the toolbar of the certificate detail page that is shown. */
    async open(): Promise<void> {
        logger.info(`Opening the ${this.caption} dialog`);
        await this.detail.toolbar.button(this.action).click();
        await expect(this.dialog).toBeVisible();
    }

    /** Cancels the dialog and waits until it is gone. */
    async close(): Promise<void> {
        await this.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(this.dialog).toBeHidden();
    }

    /** The dialog's error line (`<test id>`), shown after a refused submit. */
    protected errorLine(testId: string): Locator {
        return this.dialog.getByTestId(testId);
    }

    /** Clicks, waits for the answer of `call` (registered before the click) and returns it with the uuid its JSON body names. */
    protected async answerWithUuid(call: ApiCall, click: () => Promise<unknown>): Promise<AnswerWithUuid> {
        const startedAt = Date.now();
        const answer = await answerFrom(await actAndWaitForApi(this.page, call, click), startedAt);
        const uuid = (answer.json as { uuid?: unknown } | undefined)?.uuid;
        return { ...answer, uuid: typeof uuid === 'string' ? uuid : undefined };
    }
}
