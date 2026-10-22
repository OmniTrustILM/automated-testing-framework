/**
 * CertificateDetailPage — the detail page of one certificate.
 *
 * WHAT: the detail page of one certificate: the properties widget and its toolbar, the state badge, the
 *       Registration widget and the rows of the Related Certificates and Approvals tabs.
 * WHY: REG-CERT-07 / 10 / 12 / 16 read the state and the toolbar decision table after each lifecycle action.
 *       Asserts never navigate: the spec opens the page or tab first. The dialogs the toolbar opens are their own
 *       classes.
 * HOW: tabs by URL slug (no click race); `openFresh` reloads the Details tab because the page a create leaves open does not
 *       poll; the widget by its heading; toolbar buttons through the shared icon map; rows by data id.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { ButtonState, expectButtons, ToolbarButtonName, ToolbarButtons } from './ui/toolbar';
import { widgetTitled } from './ui/widget';

const logger = new Logger('CertificateDetailPage');

/** The certificate actions of the detail toolbar. */
export type CertificateAction = Extract<ToolbarButtonName, 'issue' | 'renew' | 'rekey' | 'revoke' | 'complete' | 'delete' | 'archive' | 'unarchive'>;
export type DetailTab = 'Details' | 'Request' | 'Attributes' | 'Validation' | 'Approvals' | 'Locations' | 'History' | 'Event History' | 'Flow' | 'Related Certificates' | 'Comments';
export type RelationRole = 'Successor' | 'Predecessor';
export type RelationType = 'Renewal' | 'Rekey' | 'Replacement' | 'Pending';

const slug = (tab: string): string => tab.toLowerCase().replace(/\s+/g, '-');

export class CertificateDetailPage {
    readonly page: Page;
    readonly main: Locator;
    readonly tablist: Locator;
    /** The properties widget of the detail page (`Certificate Properties`, or `CSR Properties` before issuance). */
    readonly propertiesWidget: Locator;
    /** The state label shown in the Details tab (`certificate-status` of the `certState` row). */
    readonly stateBadge: Locator;
    readonly registrationWidget: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.tablist = page.getByRole('tablist');
        this.propertiesWidget = widgetTitled(this.main, /^(Certificate|CSR) Properties$/);
        this.stateBadge = this.main.locator('tr[data-id="certState"] [data-testid="certificate-status"]');
        this.registrationWidget = widgetTitled(this.main, 'Registration');
    }

    /** Opens the detail page of a certificate, on a tab when given (by its URL slug `?tab=<slug>`: no race with a click). */
    async goToDetail(uuid: string, options: { tab?: DetailTab } = {}): Promise<void> {
        logger.info(`Opening certificate ${uuid}${options.tab ? ` tab ${options.tab}` : ''}`);
        await this.page.goto(`/administrator/#/certificates/detail/${uuid}${options.tab ? `?tab=${slug(options.tab)}` : ''}`);
        await expect(this.main).toBeVisible();
        if (options.tab) await expect(this.tablist.getByRole('tab', { name: options.tab, exact: true })).toHaveAttribute('aria-selected', 'true');
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
        await this.tablist.getByRole('tab', { name: tab, exact: true }).click();
    }

    /** The toolbar buttons of the properties widget, by action name. */
    get toolbar(): ToolbarButtons {
        return new ToolbarButtons(this.propertiesWidget);
    }

    /** The toolbar decision table (which action the certificate state allows): each named action is enabled or disabled. */
    async assertToolbar(expected: Partial<Record<CertificateAction, ButtonState>>): Promise<void> {
        await expectButtons(this.toolbar, expected, 'toolbar');
    }

    /** The Details tab (open) shows the state label. */
    async assertState(label: string): Promise<void> {
        await expect(this.stateBadge).toHaveText(label);
    }

    registrationRow(row: 'state' | 'expires' | 'failedAttempts'): Locator {
        const id = { state: 'registrationState', expires: 'registrationExpiresAt', failedAttempts: 'registrationFailedAttempts' }[row];
        return this.registrationWidget.locator(`tr[data-id="${id}"]`).locator('td').last();
    }

    /** The Details tab (open) shows the Registration widget with the expected state and failed attempts. */
    async assertRegistration(expected: { state?: string; failedAttempts?: number }): Promise<void> {
        await expect(this.registrationWidget).toBeVisible();
        if (expected.state !== undefined) await expect(this.registrationRow('state')).toHaveText(expected.state);
        if (expected.failedAttempts !== undefined) await expect(this.registrationRow('failedAttempts')).toHaveText(String(expected.failedAttempts));
    }

    /** The Details tab (open) rendered and shows no Registration widget. */
    async assertNoRegistration(): Promise<void> {
        await expect(this.propertiesWidget, 'the detail rendered').toBeVisible();
        await expect(this.registrationWidget).toHaveCount(0);
    }

    /** The Expires row as a Date (the widget formats the ISO date; parsed back). */
    async registrationExpires(): Promise<Date> {
        const text = (await this.registrationRow('expires').innerText()).trim();
        const t = Date.parse(text);
        if (Number.isNaN(t)) throw new Error(`Registration Expires "${text}" is not a date`);
        return new Date(t);
    }

    /** The row of a related certificate or an approval in the open tab (`tr[data-id=<uuid>]`). */
    row(uuid: string): Locator {
        return this.main.locator(`tr[data-id="${uuid}"]`);
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
