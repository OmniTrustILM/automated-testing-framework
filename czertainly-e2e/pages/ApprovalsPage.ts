/**
 * ApprovalsPage — the Approvals list (`List of Approvals` tab: row checkboxes and the OVERRIDE toolbar, `check-button` =
 * Approve, `times-button` = Reject, each behind a confirm dialog and sending `PATCH /v1/approvals/{uuid}/approve|reject`)
 * and the approval detail. Rows are `tr[data-id=<approval uuid>]`, newest first, so a fresh approval is on page one.
 * Every decision waits for the request it expects, so a wrong button fails loudly.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { iconButton, widgetTitled } from './ui/widget';
import { actAndWaitForApi } from './ui/waitForResponse';

const logger = new Logger('ApprovalsPage');

export type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected' | 'Expired';

export class ApprovalsPage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    /** The list page on the `List of Approvals` tab (URL slug of the tab title). */
    async goToList(): Promise<void> {
        logger.info('Opening the approvals list');
        await this.page.goto('administrator/#/approvals?tab=list-of-approvals');
        await expect(this.main).toBeVisible();
        await expect(this.listWidget).toBeVisible();
    }

    get listWidget(): Locator {
        return widgetTitled(this.main, 'List of Approvals');
    }

    row(approvalUuid: string): Locator {
        return this.listWidget.locator(`tr[data-id="${approvalUuid}"]`);
    }

    /** Tick the row of an approval (the list must show it: newest first). */
    async checkRow(approvalUuid: string): Promise<void> {
        const row = this.row(approvalUuid);
        await expect(row, `approval row ${approvalUuid}`).toBeVisible();
        const box = row.locator('input[type="checkbox"]');
        if (!(await box.isChecked())) await box.check();
        await expect(box).toBeChecked();
    }

    private async overrideDecision(decision: 'approve' | 'reject', approvalUuid: string): Promise<number> {
        const icon = decision === 'approve' ? 'check' : 'times';
        const caption = decision === 'approve' ? 'Accept the selected Approval?' : 'Reject the selected Approval?';
        const confirm = decision === 'approve' ? 'Yes, approve' : 'Yes, reject';
        logger.info(`Override ${decision} of approval ${approvalUuid}`);
        await iconButton(this.listWidget, icon).click();
        const dialog = this.page.getByRole('dialog', { name: caption });
        await expect(dialog).toBeVisible();
        const answer = await actAndWaitForApi(this.page, { method: 'PATCH', path: `/api/v1/approvals/${approvalUuid}/${decision}` }, () => dialog.getByRole('button', { name: confirm, exact: true }).click());
        const status = answer.status();
        await expect(dialog).toBeHidden();
        return status;
    }

    /** List toolbar Approve on the checked row; returns the status of `PATCH …/approve` (204). */
    async overrideApprove(approvalUuid: string): Promise<number> {
        return this.overrideDecision('approve', approvalUuid);
    }

    /** List toolbar Reject on the checked row; returns the status of `PATCH …/reject` (204). */
    async overrideReject(approvalUuid: string): Promise<number> {
        return this.overrideDecision('reject', approvalUuid);
    }

    /** The status badge text of a list row. */
    async assertStatus(approvalUuid: string, status: ApprovalStatus): Promise<void> {
        await expect(this.row(approvalUuid)).toContainText(status);
    }

    // ------------------------------------------------------------------ detail page

    async goToDetail(approvalUuid: string): Promise<void> {
        logger.info(`Opening approval ${approvalUuid}`);
        await this.page.goto(`administrator/#/approvals/detail/${approvalUuid}`);
        await expect(this.main).toBeVisible();
        await expect(this.detailsWidget).toBeVisible();
    }

    get detailsWidget(): Locator {
        return widgetTitled(this.main, 'Approval Details');
    }

    get approversWidget(): Locator {
        return widgetTitled(this.main, 'Approvers');
    }

    /** The `Approval Details` status row. */
    async assertDetailStatus(status: ApprovalStatus): Promise<void> {
        await expect(this.detailsWidget.locator('tr[data-id="status"]')).toContainText(status);
    }

    /** A recipient row of the `Approvers` table carries the comment ("Approval flow overridden" on an override). */
    async assertRecipientComment(text: string | RegExp): Promise<void> {
        await expect(this.approversWidget).toBeVisible();
        await expect(this.approversWidget.locator('tbody tr').filter({ hasText: text }).first(), `approver row with comment ${String(text)}`).toBeVisible();
    }

    /** The recipient Approve / Reject buttons of the detail page (`check-button` / `times-button` of the details widget). */
    recipientButton(decision: 'approve' | 'reject'): Locator {
        return iconButton(this.detailsWidget, decision === 'approve' ? 'check' : 'times');
    }

    async assertRecipientButtons(state: 'enabled' | 'disabled'): Promise<void> {
        for (const d of ['approve', 'reject'] as const) {
            if (state === 'enabled') await expect(this.recipientButton(d)).toBeEnabled();
            else await expect(this.recipientButton(d)).toBeDisabled();
        }
    }
}
