/**
 * RaProfilePage — the RA profile list, detail with its tabs and the Available Protocols widget (REG-CFG-03, 05).
 * A method that changes an RA profile is called only on one the run created. An `assert…` method never navigates.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CreateRaProfileDialog } from './CreateRaProfileDialog';
import { waitForDetailRoute } from './ui/detailRoute';
import { chooseOption } from './ui/select';
import { assertToast } from './ui/toast';
import { widgetTitled } from './ui/widget';

const logger = new Logger('RaProfilePage');

export type RaProfileTab = 'Details' | 'Protocols' | 'Attributes' | 'Validation' | 'Events';
export type Protocol = 'acme' | 'scep' | 'cmp';

const PROTOCOL_LABEL: Record<Protocol, string> = { acme: 'ACME', scep: 'SCEP', cmp: 'CMP' };

const ERROR_TEXT = /unexpected error|internal server error/i;

export class RaProfilePage {
    readonly page: Page;
    readonly main: Locator;

    // RA Profiles list
    readonly addRaProfileButton: Locator;

    // RA profile detail
    readonly enableButton: Locator;
    readonly statusBadge: Locator;

    // Available Protocols (Protocols tab)
    readonly availableProtocols: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.addRaProfileButton = this.main.getByTestId('plus-button').first();

        this.enableButton = this.main.getByTestId('enable-button').first();
        this.statusBadge = this.main.locator('tr[data-id="enabled"] [data-testid="status-badge"]');

        this.availableProtocols = widgetTitled(this.main, 'Available Protocols');
    }

    tab(name: RaProfileTab): Locator {
        return this.page.getByRole('tab', { name, exact: true });
    }

    protocolRow(protocol: Protocol): Locator {
        return this.availableProtocols.locator(`tr[data-id="${protocol}"]`);
    }

    protocolActivationButton(protocol: Protocol): Locator {
        return this.protocolRow(protocol).getByTestId('progress-button');
    }

    activateProtocolDialog(protocol: Protocol): Locator {
        return this.page.getByRole('dialog', { name: `Activate ${PROTOCOL_LABEL[protocol]} protocol` });
    }

    activateDialogProfileTrigger(protocol: Protocol): Locator {
        return this.activateProtocolDialog(protocol).getByTestId('select-profilesSelect-trigger');
    }

    activateDialogButton(protocol: Protocol): Locator {
        return this.activateProtocolDialog(protocol).getByRole('button', { name: 'Activate', exact: true });
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/raprofiles');
        await expect(this.main).toBeVisible();
    }

    async openCreateDialog(): Promise<CreateRaProfileDialog> {
        logger.info('Opening Create RA Profile');
        const dialog = new CreateRaProfileDialog(this.page);
        await this.addRaProfileButton.click();
        await expect(dialog.dialog).toBeVisible();
        return dialog;
    }

    async goToDetail(authorityUuid: string, raProfileUuid: string, tab?: RaProfileTab): Promise<void> {
        const query = tab ? `?tab=${tab.toLowerCase()}` : '';
        logger.info(`Opening RA profile ${raProfileUuid}${tab ? ` (${tab})` : ''}`);
        await this.page.goto(`/administrator/#/raprofiles/detail/${authorityUuid}/${raProfileUuid}${query}`);
        await expect(this.main).toBeVisible();
    }

    /** Waits for the redirect to the new RA profile's detail and returns its uuid. Call it after the ledger line. */
    async waitForDetail(options: { timeout?: number } = {}): Promise<string> {
        return waitForDetailRoute(this.page, 'raprofiles', { segments: 2, timeout: options.timeout });
    }

    async openTab(tab: RaProfileTab): Promise<void> {
        await this.tab(tab).click();
    }

    /** The page shows no error text; it never clicks a tab. */
    async assertNoErrorShown(tab: RaProfileTab): Promise<void> {
        await expect(this.main, `the ${tab} tab shows no error`).not.toContainText(ERROR_TEXT);
    }

    async enable(): Promise<void> {
        await this.enableButton.click();
    }

    async assertStatus(status: 'Enabled' | 'Disabled'): Promise<void> {
        await expect(this.statusBadge).toHaveText(status);
    }

    /** The dialog closes on submit whether core accepts or refuses; the caller asserts the outcome. */
    async activateProtocol(protocol: Protocol, profileName: string): Promise<void> {
        logger.info(`Activating ${PROTOCOL_LABEL[protocol]} with profile ${profileName}`);
        await expect(this.protocolRow(protocol)).toBeVisible();
        await expect(this.protocolActivationButton(protocol)).toHaveText('Activate');
        await this.protocolActivationButton(protocol).click();
        await expect(this.activateProtocolDialog(protocol)).toBeVisible();
        await chooseOption(this.page, this.activateDialogProfileTrigger(protocol), profileName);
        await this.activateDialogButton(protocol).click();
        await expect(this.activateProtocolDialog(protocol)).toBeHidden();
    }

    async assertProtocolActive(protocol: Protocol): Promise<void> {
        await expect(this.protocolActivationButton(protocol)).toHaveText('Deactivate');
        await expect(this.protocolRow(protocol)).toContainText('Enabled');
    }

    /** The row shows the protocol inactive: status Disabled and the Activate button. */
    async assertProtocolInactive(protocol: Protocol): Promise<void> {
        await expect(this.protocolActivationButton(protocol)).toHaveText('Activate');
        await expect(this.protocolRow(protocol)).toContainText('Disabled');
        await expect(this.protocolRow(protocol)).not.toContainText('Enabled');
    }

    async assertActivationRefused(protocol: Protocol, text: RegExp): Promise<string> {
        const card = await assertToast(this.page, new RegExp(`Failed to activate ${PROTOCOL_LABEL[protocol]}`), { severity: 'danger' });
        await expect(card).toContainText(text);
        return (await card.innerText()).trim();
    }
}
