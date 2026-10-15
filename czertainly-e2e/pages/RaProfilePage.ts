/**
 * RaProfilePage — the RA profile pages of the admin UI (B1: REG-CFG-05 and REG-CFG-05.2; later REG-CERT-22,
 * REG-COMP-03 / 09, REG-WFL-04 / 05 / 07).
 *
 * The detail page repeats icon-only buttons per titled widget (`plus-button` for compliance and approval profiles,
 * `pencil-button` for the profile, certificate validation and request validation), so every toolbar action is scoped by
 * its widget title (phase-04 A1 / B13). Tabs open by URL (`?tab=<slug>`, the page sets `tabUrlParam="tab"`). Protocol
 * rows are `tr[data-id="acme" | "scep" | "cmp"]` in the `Available Protocols` widget: a status badge (Enabled /
 * Disabled) and one ProgressButton titled Activate or Deactivate.
 *
 * Every method that CHANGES the RA profile through the UI is only called on an RA profile the run created: the spec
 * checks it first with `assertOwnLive` (the browser is not behind the API guard; decision Q1, review R16).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { assertToast, chooseOption, iconButton, widget } from './RegressionUi';

const logger = new Logger('RaProfilePage');

export type RaProfileTab = 'Details' | 'Protocols' | 'Attributes' | 'Validation' | 'Events';
export type Protocol = 'acme' | 'scep' | 'cmp';

const PROTOCOL_LABEL: Record<Protocol, string> = { acme: 'ACME', scep: 'SCEP', cmp: 'CMP' };

export class RaProfilePage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    async goToList(): Promise<void> {
        await this.page.goto('administrator/#/raprofiles');
        await expect(this.main).toBeVisible();
    }

    /** The detail page of one RA profile (`#/raprofiles/detail/<authority>/<uuid>`), optionally on a tab (by URL). */
    async openDetail(authorityUuid: string, raProfileUuid: string, tab?: RaProfileTab): Promise<void> {
        const query = tab ? `?tab=${tab.toLowerCase()}` : '';
        logger.info(`Opening RA profile ${raProfileUuid}${tab ? ` (${tab})` : ''}`);
        await this.page.goto(`administrator/#/raprofiles/detail/${authorityUuid}/${raProfileUuid}${query}`);
        await expect(this.main).toBeVisible();
    }

    async openTab(tab: RaProfileTab): Promise<void> {
        await this.page.getByRole('tab', { name: tab, exact: true }).click();
    }

    get detailsWidget(): Locator {
        return widget(this.main, 'RA Profile Details');
    }

    get protocolsWidget(): Locator {
        return widget(this.main, 'Available Protocols');
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

    /** Row → Deactivate → "Deactivate <PROTOCOL>" → "Yes, deactivate". */
    async deactivateProtocol(protocol: Protocol): Promise<void> {
        logger.info(`Deactivating ${PROTOCOL_LABEL[protocol]}`);
        await expect(this.rowButton(protocol)).toHaveText('Deactivate');
        await this.rowButton(protocol).click();
        const dialog = this.page.getByRole('dialog', { name: `Deactivate ${PROTOCOL_LABEL[protocol]}` });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Yes, deactivate', exact: true }).click();
        await expect(dialog).toBeHidden();
    }

    /**
     * Enable in the `RA Profile Details` widget. The detail page gives its toolbar buttons ids (`edit`, `delete`,
     * `enable`, `disable`, `check-compliance`), so the test id is `<id>-button` (WidgetButtons: `id ?? icon`).
     */
    async enable(): Promise<void> {
        await iconButton(this.detailsWidget, 'enable').click();
    }

    /** Disable in the `RA Profile Details` widget (`disable-button`). */
    async disable(): Promise<void> {
        await iconButton(this.detailsWidget, 'disable').click();
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

    /** The profile's status badge in the `RA Profile Details` widget. */
    async assertEnabled(enabled: boolean): Promise<void> {
        await expect(this.detailsWidget.locator('tr[data-id="enabled"]')).toContainText(enabled ? 'Enabled' : 'Disabled');
    }
}
