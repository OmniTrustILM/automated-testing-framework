/**
 * RaProfilePage — Page Object Model for RA profiles (REG-CFG-03, 05; REG-CERT-68).
 *
 * Encapsulates:
 *   - the RA profile list, its Create dialog (`CreateRaProfileDialog`) and the detail with its tabs
 *   - the Available Protocols widget: activate a protocol with a profile, read whether a row is active
 *
 * A method that changes an RA profile is called only on one the run created, which the spec proves first. An `assert…`
 * method never navigates and never clicks a tab.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CreateRaProfileDialog } from './CreateRaProfileDialog';
import { waitForDetailRoute } from './ui/detailRoute';
import { chooseOption } from './ui/select';
import { assertToast } from './ui/toast';
import { toolbarButton } from './ui/toolbar';
import { widgetTitled } from './ui/widget';

const logger = new Logger('RaProfilePage');

export type RaProfileTab = 'Details' | 'Protocols' | 'Attributes' | 'Validation' | 'Events';
export type Protocol = 'acme' | 'scep' | 'cmp';

const PROTOCOL_LABEL: Record<Protocol, string> = { acme: 'ACME', scep: 'SCEP', cmp: 'CMP' };

/** The text a tab shows when the page failed to load it. */
const ERROR_TEXT = /unexpected error|internal server error/i;

export class RaProfilePage {
    readonly page: Page;
    readonly main: Locator;
    /** The Available Protocols widget of the detail. */
    readonly protocolsWidget: Locator;
    /** The Enabled / Disabled badge in the status row of the detail. */
    readonly statusBadge: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.protocolsWidget = widgetTitled(this.main, 'Available Protocols');
        this.statusBadge = this.main.locator('tr[data-id="enabled"] [data-testid="status-badge"]');
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/raprofiles');
        await expect(this.main).toBeVisible();
    }

    /** The list's "+" → the Create RA Profile dialog (the list must be open). */
    async openCreateDialog(): Promise<CreateRaProfileDialog> {
        logger.info('Opening Create RA Profile');
        const dialog = new CreateRaProfileDialog(this.page);
        await toolbarButton(this.page, 'plus').click();
        await expect(dialog.dialog).toBeVisible();
        return dialog;
    }

    /** The detail page of one RA profile (`#/raprofiles/detail/<authority>/<uuid>`), optionally on a tab (by URL). */
    async goToDetail(authorityUuid: string, raProfileUuid: string, tab?: RaProfileTab): Promise<void> {
        const query = tab ? `?tab=${tab.toLowerCase()}` : '';
        logger.info(`Opening RA profile ${raProfileUuid}${tab ? ` (${tab})` : ''}`);
        await this.page.goto(`/administrator/#/raprofiles/detail/${authorityUuid}/${raProfileUuid}${query}`);
        await expect(this.main).toBeVisible();
    }

    /**
     * Waits for the redirect to the new RA profile's detail (`#/raprofiles/detail/<authority>/<uuid>`) and returns its uuid. Call it
     * after the ledger line.
     */
    async waitForDetail(options: { timeout?: number } = {}): Promise<string> {
        return waitForDetailRoute(this.page, 'raprofiles', { segments: 2, timeout: options.timeout });
    }

    async openTab(tab: RaProfileTab): Promise<void> {
        await this.page.getByRole('tab', { name: tab, exact: true }).click();
    }

    /** The page shows no error text (a tab that failed to load shows the platform's error); it never clicks a tab. */
    async assertNoErrorShown(tab: RaProfileTab): Promise<void> {
        await expect(this.main, `the ${tab} tab shows no error`).not.toContainText(ERROR_TEXT);
    }

    /** The detail's Enable button (the RA profile is created disabled). */
    async enable(): Promise<void> {
        await toolbarButton(this.page, 'enable').click();
    }

    /** The status row shows Enabled or Disabled. */
    async assertStatus(status: 'Enabled' | 'Disabled'): Promise<void> {
        await expect(this.statusBadge).toHaveText(status);
    }

    /** The protocol's row in `Available Protocols`. */
    protocolRow(protocol: Protocol): Locator {
        return this.protocolsWidget.locator(`tr[data-id="${protocol}"]`);
    }

    private rowButton(protocol: Protocol): Locator {
        return this.protocolRow(protocol).getByTestId('progress-button');
    }

    /**
     * Protocols tab → the protocol's row → Activate → "Activate <PROTOCOL> protocol" → choose the profile → Activate.
     * The dialog closes on submit whether core accepts or refuses (ProtocolActivationDialogBody); the caller asserts the
     * outcome (`assertProtocolActive` or `assertActivationRefused`).
     */
    async activateProtocol(protocol: Protocol, profileName: string): Promise<void> {
        logger.info(`Activating ${PROTOCOL_LABEL[protocol]} with profile ${profileName}`);
        const row = this.protocolRow(protocol);
        await expect(row).toBeVisible();
        await expect(this.rowButton(protocol)).toHaveText('Activate');
        await this.rowButton(protocol).click();
        const dialog = this.page.getByRole('dialog', { name: `Activate ${PROTOCOL_LABEL[protocol]} protocol` });
        await expect(dialog).toBeVisible();
        await chooseOption(this.page, dialog.getByTestId('select-profilesSelect-trigger'), profileName);
        await dialog.getByRole('button', { name: 'Activate', exact: true }).click();
        await expect(dialog).toBeHidden();
    }

    /** The row shows the protocol active: status Enabled and the Deactivate button. */
    async assertProtocolActive(protocol: Protocol): Promise<void> {
        await expect(this.rowButton(protocol)).toHaveText('Deactivate');
        await expect(this.protocolRow(protocol)).toContainText('Enabled');
    }

    /**
     * The row shows the protocol inactive: status Disabled and the Activate button. (The collapsed detail row carries the
     * text "<PROTOCOL> is not active"; the row itself is the visible state.)
     */
    async assertProtocolInactive(protocol: Protocol): Promise<void> {
        await expect(this.rowButton(protocol)).toHaveText('Activate');
        await expect(this.protocolRow(protocol)).toContainText('Disabled');
        await expect(this.protocolRow(protocol)).not.toContainText('Enabled');
    }

    /** A danger toast with the backend's refusal text (fe: "Failed to activate <PROTOCOL> (<status>): <message>"). */
    async assertActivationRefused(protocol: Protocol, text: RegExp): Promise<string> {
        const card = await assertToast(this.page, new RegExp(`Failed to activate ${PROTOCOL_LABEL[protocol]}`), { severity: 'danger' });
        await expect(card).toContainText(text);
        return (await card.innerText()).trim();
    }
}
