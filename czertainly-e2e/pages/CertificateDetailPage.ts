/**
 * CertificateDetailPage — the detail page of one certificate (REG-CERT-07, 10, 12, 16).
 *
 * Encapsulates:
 *   - the Certificate Properties widget with its toolbar, and the state badge
 *   - the Registration widget and the rows of the Related Certificates and Approvals tabs
 *
 * Asserts never navigate: the spec opens the page or tab first. The dialogs the toolbar opens are their own classes.
 * `openFresh` reloads the Details tab, because the page a create leaves open does not poll.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { ButtonState, expectButtons } from './ui/toolbar';
import { widgetTitled } from './ui/widget';

const logger = new Logger('CertificateDetailPage');

/** The certificate actions of the detail toolbar. */
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
    /** The state label shown in the Details tab (`certificate-status` of the `certState` row). */
    readonly stateBadge: Locator;

    // Registration
    readonly registrationWidget: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // Tabs
        this.tabs = page.getByRole('tablist');

        // Details tab: Certificate Properties (CSR Properties before issuance), its toolbar and the state badge
        this.certificateProperties = widgetTitled(this.main, /^(Certificate|CSR) Properties$/);
        this.issueButton = this.certificateProperties.getByTestId('cubes-button');
        this.renewButton = this.certificateProperties.getByTestId('retweet-button');
        this.rekeyButton = this.certificateProperties.getByTestId('rekey-button');
        this.revokeButton = this.certificateProperties.getByTestId('minus-square-button');
        this.completeButton = this.certificateProperties.getByTestId('check-button');
        this.deleteButton = this.certificateProperties.getByTestId('trash-button');
        this.archiveButton = this.certificateProperties.getByTestId('archive-button');
        this.unarchiveButton = this.certificateProperties.getByTestId('unarchive-button');
        this.stateBadge = this.main.locator('tr[data-id="certState"] [data-testid="certificate-status"]');

        // Registration
        this.registrationWidget = widgetTitled(this.main, 'Registration');
    }

    tab(name: DetailTab): Locator {
        return this.tabs.getByRole('tab', { name, exact: true });
    }

    /** The toolbar button of a certificate action. */
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

    /** The value cell of a Registration widget row. */
    registrationRow(row: 'state' | 'expires' | 'failedAttempts'): Locator {
        const id = { state: 'registrationState', expires: 'registrationExpiresAt', failedAttempts: 'registrationFailedAttempts' }[row];
        return this.registrationWidget.locator(`tr[data-id="${id}"]`).locator('td').last();
    }

    /** The row of a related certificate or an approval in the open tab (`tr[data-id=<uuid>]`). */
    row(uuid: string): Locator {
        return this.main.locator(`tr[data-id="${uuid}"]`);
    }

    /** Opens the detail page of a certificate, on a tab when given (by its URL slug `?tab=<slug>`: no race with a click). */
    async goToDetail(uuid: string, options: { tab?: DetailTab } = {}): Promise<void> {
        logger.info(`Opening certificate ${uuid}${options.tab ? ` tab ${options.tab}` : ''}`);
        await this.page.goto(`/administrator/#/certificates/detail/${uuid}${options.tab ? `?tab=${slug(options.tab)}` : ''}`);
        await expect(this.main).toBeVisible();
        if (options.tab) await expect(this.tab(options.tab)).toHaveAttribute('aria-selected', 'true');
    }

    /**
     * Opens the Details tab of a certificate after a reload: the detail page that a create or a lifecycle dialog leaves open does not
     * poll, so the state it shows is the one from before.
     */
    async openFresh(uuid: string): Promise<void> {
        await this.goToDetail(uuid);
        await this.page.reload();
        await this.openTab('Details');
    }

    /** Click a tab of the page that is open. */
    async openTab(tab: DetailTab): Promise<void> {
        await this.tab(tab).click();
    }

    /** The toolbar decision table (which action the certificate state allows): each named action is enabled or disabled. */
    async assertToolbar(expected: Partial<Record<CertificateAction, ButtonState>>): Promise<void> {
        await expectButtons((action: CertificateAction) => this.toolbarButton(action), expected, 'toolbar');
    }

    /** The Details tab (open) shows the state label. */
    async assertState(label: string): Promise<void> {
        await expect(this.stateBadge).toHaveText(label);
    }

    /** The Details tab (open) shows the Registration widget with the expected state and failed attempts. */
    async assertRegistration(expected: { state?: string; failedAttempts?: number }): Promise<void> {
        await expect(this.registrationWidget).toBeVisible();
        if (expected.state !== undefined) await expect(this.registrationRow('state')).toHaveText(expected.state);
        if (expected.failedAttempts !== undefined) await expect(this.registrationRow('failedAttempts')).toHaveText(String(expected.failedAttempts));
    }

    /** The Details tab (open) rendered and shows no Registration widget. */
    async assertNoRegistration(): Promise<void> {
        await expect(this.certificateProperties, 'the detail rendered').toBeVisible();
        await expect(this.registrationWidget).toHaveCount(0);
    }

    /** The open Related Certificates tab lists the certificate in the given role with the relation type badge. */
    async assertRelated(expected: { uuid: string; role: RelationRole; type: RelationType }): Promise<void> {
        const row = this.row(expected.uuid);
        await expect(row, `related row ${expected.uuid}`).toBeVisible();
        await expect(row).toContainText(expected.role);
        await expect(row).toContainText(expected.type);
    }

    /** The open Approvals tab shows the approval with the status badge text. */
    async assertApprovalRow(approvalUuid: string, status: 'Pending' | 'Approved' | 'Rejected' | 'Expired'): Promise<void> {
        const row = this.row(approvalUuid);
        await expect(row, `approval row ${approvalUuid}`).toBeVisible();
        await expect(row).toContainText(status);
    }
}
