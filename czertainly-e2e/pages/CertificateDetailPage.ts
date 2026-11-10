/**
 * CertificateDetailPage — the detail page of one certificate (REG-CERT-07, 10, 12, 16).
 * Asserts never navigate: the spec opens the page or tab first. `openFresh` reloads, because the page a create leaves open does not poll.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { PageHeader } from './ui/pageHeader';
import { ButtonState, expectButtons } from './ui/toolbar';
import { widgetTitled } from './ui/widget';

const logger = new Logger('CertificateDetailPage');

export type CertificateAction = 'issue' | 'renew' | 'rekey' | 'revoke' | 'complete' | 'delete' | 'archive' | 'unarchive';
export type DetailTab = 'Details' | 'Request' | 'Attributes' | 'Validation' | 'Approvals' | 'Locations' | 'History' | 'Event History' | 'Flow' | 'Related Certificates' | 'Comments';
export type RelationRole = 'Successor' | 'Predecessor';
export type RelationType = 'Renewal' | 'Rekey' | 'Replacement' | 'Pending';

const slug = (tab: string): string => tab.toLowerCase().replace(/\s+/g, '-');

export class CertificateDetailPage {
    readonly page: Page;
    readonly main: Locator;

    // Tabs
    readonly tabs: Locator;

    // Page header (fe-administrator#2426): the lifecycle actions; the toolbar of Certificate Properties on older builds
    readonly header: PageHeader;

    // Details tab: Certificate Properties (CSR Properties before issuance), its toolbar and the state badge
    readonly certificateProperties: Locator;
    readonly issueButton: Locator;
    readonly renewButton: Locator;
    readonly rekeyButton: Locator;
    readonly revokeButton: Locator;
    readonly completeButton: Locator;
    readonly deleteButton: Locator;
    readonly archiveButton: Locator;
    readonly unarchiveButton: Locator;
    readonly stateBadge: Locator;

    // Registration
    readonly registrationWidget: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.tabs = page.getByRole('tablist');

        this.header = new PageHeader(page);

        this.certificateProperties = widgetTitled(this.main, /^(Certificate|CSR) Properties$/);
        this.issueButton = this.header.action('issue', this.certificateProperties.getByTestId('cubes-button'));
        this.renewButton = this.header.action('renew', this.certificateProperties.getByTestId('retweet-button'));
        this.rekeyButton = this.header.action('rekey', this.certificateProperties.getByTestId('rekey-button'));
        this.revokeButton = this.header.action('revoke', this.certificateProperties.getByTestId('minus-square-button'));
        this.completeButton = this.header.action('complete', this.certificateProperties.getByTestId('check-button'));
        this.deleteButton = this.header.action('delete', this.certificateProperties.getByTestId('trash-button'));
        this.archiveButton = this.header.action('archive', this.certificateProperties.getByTestId('archive-button'));
        this.unarchiveButton = this.header.action('unarchive', this.certificateProperties.getByTestId('unarchive-button'));
        this.stateBadge = this.main.locator('tr[data-id="certState"] [data-testid="certificate-status"]');

        this.registrationWidget = widgetTitled(this.main, 'Registration');
    }

    tab(name: DetailTab): Locator {
        return this.tabs.getByRole('tab', { name, exact: true });
    }

    toolbarButton(action: CertificateAction): Locator {
        const buttons: Record<CertificateAction, Locator> = {
            issue: this.issueButton,
            renew: this.renewButton,
            rekey: this.rekeyButton,
            revoke: this.revokeButton,
            complete: this.completeButton,
            delete: this.deleteButton,
            archive: this.archiveButton,
            unarchive: this.unarchiveButton,
        };
        return buttons[action];
    }

    registrationRow(row: 'state' | 'expires' | 'failedAttempts'): Locator {
        const id = { state: 'registrationState', expires: 'registrationExpiresAt', failedAttempts: 'registrationFailedAttempts' }[row];
        return this.registrationWidget.locator(`tr[data-id="${id}"]`).locator('td').last();
    }

    row(uuid: string): Locator {
        return this.main.locator(`tr[data-id="${uuid}"]`);
    }

    async goToDetail(uuid: string, options: { tab?: DetailTab } = {}): Promise<void> {
        logger.info(`Opening certificate ${uuid}${options.tab ? ` tab ${options.tab}` : ''}`);
        await this.page.goto(`/administrator/#/certificates/detail/${uuid}${options.tab ? `?tab=${slug(options.tab)}` : ''}`);
        await expect(this.main).toBeVisible();
        if (options.tab) await expect(this.tab(options.tab)).toHaveAttribute('aria-selected', 'true');
    }

    /** Reloads the Details tab: the page that a create or a lifecycle dialog leaves open does not poll. */
    async openFresh(uuid: string): Promise<void> {
        await this.goToDetail(uuid);
        await this.page.reload();
        await this.openTab('Details');
    }

    async openTab(tab: DetailTab): Promise<void> {
        await this.tab(tab).click();
    }

    /** Starts a lifecycle action: the toolbar button, or the page header's menu entry. */
    async clickAction(action: CertificateAction): Promise<void> {
        await this.header.click(this.toolbarButton(action));
    }

    /** The header lists every action and disables those that do not apply, so `absent` never holds there. */
    async assertToolbar(expected: Partial<Record<CertificateAction, ButtonState>>): Promise<void> {
        await expect(this.certificateProperties, 'the certificate loaded').toBeVisible();
        await this.header.openMenu();
        try {
            await expectButtons((action: CertificateAction) => this.toolbarButton(action), expected, 'toolbar');
        } finally {
            await this.header.closeMenu();
        }
    }

    async assertState(label: string): Promise<void> {
        await expect(this.stateBadge).toHaveText(label);
    }

    async assertRegistration(expected: { state?: string; failedAttempts?: number }): Promise<void> {
        await expect(this.registrationWidget).toBeVisible();
        if (expected.state !== undefined) await expect(this.registrationRow('state')).toHaveText(expected.state);
        if (expected.failedAttempts !== undefined) await expect(this.registrationRow('failedAttempts')).toHaveText(String(expected.failedAttempts));
    }

    async assertNoRegistration(): Promise<void> {
        await expect(this.certificateProperties, 'the detail rendered').toBeVisible();
        await expect(this.registrationWidget).toHaveCount(0);
    }

    async assertRelated(expected: { uuid: string; role: RelationRole; type: RelationType }): Promise<void> {
        const row = this.row(expected.uuid);
        await expect(row, `related row ${expected.uuid}`).toBeVisible();
        await expect(row).toContainText(expected.role);
        await expect(row).toContainText(expected.type);
    }

    async assertApprovalRow(approvalUuid: string, status: 'Pending' | 'Approved' | 'Rejected' | 'Expired'): Promise<void> {
        const row = this.row(approvalUuid);
        await expect(row, `approval row ${approvalUuid}`).toBeVisible();
        await expect(row).toContainText(status);
    }
}
