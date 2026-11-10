/**
 * ApprovalsPage — the approvals list with its override toolbar, and the approval detail (REG-CERT-16, REG-CERT-17).
 * Each decision returns the answer of the request it causes; rows are found by data id.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { widgetTitled } from './ui/widget';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { actAndReadAnswer } from './ui/waitForResponse';

const logger = new Logger('ApprovalsPage');

export type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected' | 'Expired';

export class ApprovalsPage {
    readonly page: Page;
    readonly main: Locator;

    // List of Approvals with its override toolbar (Approve / Reject the checked row)
    readonly approvalsList: Locator;
    readonly overrideApproveButton: Locator;
    readonly overrideRejectButton: Locator;

    // Override confirm dialogs
    readonly approveConfirmDialog: Locator;
    readonly confirmApproveButton: Locator;
    readonly rejectConfirmDialog: Locator;
    readonly confirmRejectButton: Locator;

    // Approval Details
    readonly approvalDetails: Locator;
    readonly statusRow: Locator;

    // Approvers
    readonly approvers: Locator;
    readonly approverRows: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.approvalsList = widgetTitled(this.main, 'List of Approvals');
        this.overrideApproveButton = this.approvalsList.getByTestId('check-button');
        this.overrideRejectButton = this.approvalsList.getByTestId('times-button');

        this.approveConfirmDialog = page.getByRole('dialog', { name: 'Accept the selected Approval?' });
        this.confirmApproveButton = this.approveConfirmDialog.getByRole('button', { name: 'Yes, approve', exact: true });
        this.rejectConfirmDialog = page.getByRole('dialog', { name: 'Reject the selected Approval?' });
        this.confirmRejectButton = this.rejectConfirmDialog.getByRole('button', { name: 'Yes, reject', exact: true });

        this.approvalDetails = widgetTitled(this.main, 'Approval Details');
        this.statusRow = this.approvalDetails.locator('tr[data-id="status"]');

        this.approvers = widgetTitled(this.main, 'Approvers');
        this.approverRows = this.approvers.locator('tbody tr');
    }

    row(approvalUuid: string): Locator {
        return this.approvalsList.locator(`tr[data-id="${approvalUuid}"]`);
    }

    rowCheckbox(approvalUuid: string): Locator {
        return this.row(approvalUuid).locator('input[type="checkbox"]');
    }

    async goToList(): Promise<void> {
        logger.info('Opening the approvals list');
        await this.page.goto('/administrator/#/approvals?tab=list-of-approvals');
        await expect(this.main).toBeVisible();
        await expect(this.approvalsList).toBeVisible();
    }

    async checkRow(approvalUuid: string): Promise<void> {
        await expect(this.row(approvalUuid), `approval row ${approvalUuid}`).toBeVisible();
        const box = this.rowCheckbox(approvalUuid);
        if (!(await box.isChecked())) await box.check();
        await expect(box).toBeChecked();
    }

    private async overrideDecision(decision: 'approve' | 'reject', approvalUuid: string): Promise<ApiAnswer> {
        const button = decision === 'approve' ? this.overrideApproveButton : this.overrideRejectButton;
        const dialog = decision === 'approve' ? this.approveConfirmDialog : this.rejectConfirmDialog;
        const confirm = decision === 'approve' ? this.confirmApproveButton : this.confirmRejectButton;
        logger.info(`Override ${decision} of approval ${approvalUuid}`);
        await button.click();
        await expect(dialog).toBeVisible();
        const answer = await actAndReadAnswer(this.page, { method: 'PATCH', path: `/api/v1/approvals/${approvalUuid}/${decision}` }, () => confirm.click());
        await expect(dialog).toBeHidden();
        return answer;
    }

    async overrideApprove(approvalUuid: string): Promise<ApiAnswer> {
        return this.overrideDecision('approve', approvalUuid);
    }

    async overrideReject(approvalUuid: string): Promise<ApiAnswer> {
        return this.overrideDecision('reject', approvalUuid);
    }

    async assertStatus(approvalUuid: string, status: ApprovalStatus): Promise<void> {
        await expect(this.row(approvalUuid)).toContainText(status);
    }

    async goToDetail(approvalUuid: string): Promise<void> {
        logger.info(`Opening approval ${approvalUuid}`);
        await this.page.goto(`/administrator/#/approvals/detail/${approvalUuid}`);
        await expect(this.main).toBeVisible();
        await expect(this.approvalDetails).toBeVisible();
    }

    async assertDetailStatus(status: ApprovalStatus): Promise<void> {
        await expect(this.statusRow).toContainText(status);
    }

    async assertRecipientComment(text: string | RegExp): Promise<void> {
        await expect(this.approvers).toBeVisible();
        await expect(this.approverRows.filter({ hasText: text }).first(), `approver row with comment ${String(text)}`).toBeVisible();
    }
}
