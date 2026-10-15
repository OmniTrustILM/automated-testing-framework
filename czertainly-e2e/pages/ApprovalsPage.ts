/**
 * ApprovalsPage — the Approvals list and detail pages (B3, cert-lifecycle area: REG-CERT-16 / 17; later 18 / 19).
 *
 * The list page has two tabs: `My Approvals` (the recipient's) and `List of Approvals` (all, with checkboxes and the
 * OVERRIDE toolbar: `check-button` = Approve → dialog "Accept the selected Approval?", `times-button` = Reject →
 * "Reject the selected Approval?"; both call `PATCH /v1/approvals/{uuid}/approve|reject`, phase-04 B11). The detail page
 * (`#/approvals/detail/<uuid>`) carries the RECIPIENT buttons with the same icon ids (`/approveRecipient`,
 * `/rejectRecipient`), so every method here waits for the request it expects: a wrong button fails loudly.
 * Rows are `tr[data-id=<approval uuid>]`; the row checkbox is the row's `input[type=checkbox]`; the list is sorted
 * newest first by the backend (ApprovalServiceImpl: createdAt desc), so a fresh approval is on page one.
 * Override decisions are made only on approvals of certificates the run created: the spec checks the approval's
 * ledger line first (`assertOwnLive`, id-named type).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { iconButton, widget } from './RegressionUi';

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
        return widget(this.main, 'List of Approvals');
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
        const answer = this.page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/api/v1/approvals/${approvalUuid}/${decision}`));
        await dialog.getByRole('button', { name: confirm, exact: true }).click();
        const status = (await answer).status();
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

    async openDetail(approvalUuid: string): Promise<void> {
        logger.info(`Opening approval ${approvalUuid}`);
        await this.page.goto(`administrator/#/approvals/detail/${approvalUuid}`);
        await expect(this.main).toBeVisible();
        await expect(this.detailsWidget).toBeVisible();
    }

    get detailsWidget(): Locator {
        return widget(this.main, 'Approval Details');
    }

    get approversWidget(): Locator {
        return widget(this.main, 'Approvers');
    }

    /** The `Approval Details` status row. */
    async assertDetailStatus(status: ApprovalStatus): Promise<void> {
        await expect(this.detailsWidget.locator('tr[data-id="status"]')).toContainText(status);
    }

    /** A recipient row of the `Approvers` table carries the comment (AP-6: "Approval flow overridden" on an override). */
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
