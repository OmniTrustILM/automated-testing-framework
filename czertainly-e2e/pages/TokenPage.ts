/**
 * TokenPage — the Tokens and Token Profiles pages of the admin UI (REG-KEY-01 / 03, platform area B3):
 * list → Create Token dialog (provider select, the connector's attribute form) → token detail (status badge, the
 * `Token Details` toolbar: Edit / Delete / Reload Status / Sync Keys / Activate / Deactivate / Generate Random, phase-04 E1)
 * and list → Create Token Profile dialog (name, enable switch, token select, usages) → profile detail (toolbar Edit /
 * Delete / Enable / Disable / Update Key Usages).
 *
 * Locators (phase-04 §3.5 E1 / E2): `text-input-name`, `select-tokenProviderSelect-trigger`, `select-storeKindSelect-trigger`,
 * `__attributes__token__.<name>` fields of the AttributeEditor, `progress-button`; the detail toolbar icons are unique
 * inside the `Token Details` widget (`RegressionUi.widget` + `iconButton`), never a page-wide `.first()`. Status and
 * toolbar oracles come from `tokens/detail/index.tsx:145-170` (A2 r3, K6): on a v2 token Sync, Activate, Deactivate
 * and Generate Random are disabled.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { chooseOption, fillRequiredCustomAttributes, fillText, iconButton, submitButton, waitForListRows, widget } from './RegressionUi';

const logger = new Logger('TokenPage');

/** The AttributeEditor prefix of the token form (`__attributes__token__.<attribute name>`). */
const TOKEN_ATTR = '__attributes__token__.';

export type TokenButton = 'edit' | 'delete' | 'reload' | 'sync' | 'activate' | 'deactivate' | 'random';
const TOKEN_ICON: Record<TokenButton, string> = { edit: 'pencil', delete: 'trash', reload: 'reload', sync: 'refresh', activate: 'check', deactivate: 'times', random: 'random' };

export type ProfileButton = 'edit' | 'delete' | 'enable' | 'disable' | 'usages';
const PROFILE_ICON: Record<ProfileButton, string> = { edit: 'pencil', delete: 'trash', enable: 'check', disable: 'times', usages: 'key' };

export class TokenPage {
    readonly main: Locator;
    readonly dialog: Locator;

    constructor(readonly page: Page) {
        this.main = page.locator('main');
        this.dialog = page.getByRole('dialog').last();
    }

    // ------------------------------------------------------------ tokens

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/tokens');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreate(): Promise<void> {
        logger.info('Opening Create Token');
        await this.main.getByTestId('plus-button').click();
        await expect(this.dialog.getByTestId('text-input-name')).toBeVisible();
    }

    /**
     * Fills the Create Token dialog for a software token: name, the provider by its registration name, (the kind on a
     * v1 provider), then the connector attributes: the action `new`, the provider-side name and the activation code
     * (`data_options` = Create new Token when the provider already holds tokens). Returns the fields it filled.
     */
    async fillSoftwareToken(opts: { name: string; connectorName: string; alias: string; activationCode: string; kind?: string }): Promise<string[]> {
        const filled: string[] = [];
        await fillText(this.dialog.getByTestId('text-input-name'), opts.name);
        await chooseOption(this.page, this.dialog.getByTestId('select-tokenProviderSelect-trigger'), opts.connectorName);
        if (opts.kind) await chooseOption(this.page, this.dialog.getByTestId('select-storeKindSelect-trigger'), opts.kind);
        // The attribute form renders after the schema loads: the action select (or the options select first) marks it.
        const options = this.dialog.getByTestId(`select-${TOKEN_ATTR}data_optionsSelect-trigger`);
        const action = this.dialog.getByTestId(`select-${TOKEN_ATTR}data_createTokenActionSelect-trigger`);
        await expect(options.or(action).first()).toBeVisible({ timeout: 20_000 });
        if (await options.isVisible().catch(() => false)) {
            await chooseOption(this.page, options, /new/i);
            filled.push('data_options');
        }
        if (await action.isVisible().catch(() => false)) {
            await chooseOption(this.page, action, /new/i);
            filled.push('data_createTokenAction');
        }
        const nameInput = this.dialog.getByTestId(`text-input-${TOKEN_ATTR}data_newTokenName`);
        await expect(nameInput).toBeVisible();
        await fillText(nameInput, opts.alias);
        filled.push('data_newTokenName');
        const code = this.dialog.getByTestId(`text-input-${TOKEN_ATTR}data_tokenCode`).or(this.dialog.locator(`[id="${TOKEN_ATTR}data_tokenCode"]`)).first();
        await expect(code).toBeVisible();
        await fillText(code, opts.activationCode);
        filled.push('data_tokenCode');
        filled.push(...(await fillRequiredCustomAttributes(this.page, this.dialog, 'qa')));
        return filled;
    }

    /** Submits the dialog; the list shows the new token (its link) and the detail opens. Returns the token uuid. */
    async submitCreate(name: string): Promise<string> {
        await submitButton(this.dialog).click();
        await expect(this.dialog).toBeHidden({ timeout: 30_000 });
        await waitForListRows(this.page);
        const link = this.main.getByRole('link', { name, exact: true }).first();
        await expect(link).toBeVisible({ timeout: 30_000 });
        const href = (await link.getAttribute('href')) ?? '';
        const uuid = /detail\/([0-9a-f-]{36})/.exec(href)?.[1];
        if (!uuid) throw new Error(`token row ${name}: no detail link with a uuid (href ${href})`);
        return uuid;
    }

    async openDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/tokens/detail/${uuid}`);
        await expect(this.tokenDetails()).toBeVisible();
    }

    tokenDetails(): Locator {
        return widget(this.main, 'Token Details');
    }

    /** A row of the Token Details table by its `data-id` (`status`, `name`, `kind`, `cryptographyProviderName`, …). */
    tokenRow(dataId: string): Locator {
        return this.tokenDetails().locator(`tr[data-id="${dataId}"]`);
    }

    tokenButton(button: TokenButton): Locator {
        return iconButton(this.tokenDetails(), TOKEN_ICON[button]);
    }

    /** The status badge text of the detail (`Connected`, `Disconnected`, `Warning`, `Unknown`, `Activated`, `Deactivated`). */
    async statusBadge(): Promise<string> {
        return (await this.tokenRow('status').innerText()).replace(/^\s*Status\s*/i, '').trim();
    }

    async assertStatusBadge(oneOf: readonly string[]): Promise<string> {
        const text = await this.statusBadge();
        expect(oneOf.some((s) => text.includes(s)), `token status badge "${text}" is one of ${oneOf.join(', ')}`).toBe(true);
        return text;
    }

    async assertButtons(expected: Partial<Record<TokenButton, 'enabled' | 'disabled'>>): Promise<void> {
        for (const [button, state] of Object.entries(expected) as Array<[TokenButton, 'enabled' | 'disabled']>) {
            const b = this.tokenButton(button);
            await expect(b, `token toolbar ${button}`).toBeVisible();
            if (state === 'enabled') await expect(b, `token toolbar ${button} enabled`).toBeEnabled();
            else await expect(b, `token toolbar ${button} disabled`).toBeDisabled();
        }
    }

    /** Clicks Reload Status and waits for the detail to settle (the row re-renders). */
    async reloadStatus(): Promise<void> {
        await this.tokenButton('reload').click();
        await expect(this.tokenRow('status')).toBeVisible();
    }

    async assertListed(name: string): Promise<void> {
        await this.goToList();
        await waitForListRows(this.page);
        await expect(this.main.getByRole('link', { name, exact: true }).first()).toBeVisible();
    }

    // ------------------------------------------------------------ token profiles

    async goToProfileList(): Promise<void> {
        await this.page.goto('/administrator/#/tokenprofiles');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateProfile(): Promise<void> {
        logger.info('Opening Create Token Profile');
        await this.main.getByTestId('plus-button').click();
        await expect(this.dialog.getByTestId('text-input-name')).toBeVisible();
    }

    /** The form's three fields of REG-KEY-03: name, the token (required), the usages; the enable switch when asked. */
    async fillProfile(opts: { name: string; tokenName: string; usages: string[]; enabled?: boolean }): Promise<void> {
        await fillText(this.dialog.getByTestId('text-input-name'), opts.name);
        if (opts.enabled) await this.dialog.getByTestId('switch-enabledSwitch-input').check({ force: true });
        await chooseOption(this.page, this.dialog.getByTestId('select-tokenSelect-trigger'), opts.tokenName);
        await this.chooseUsages(opts.usages);
        await fillRequiredCustomAttributes(this.page, this.dialog, 'qa');
    }

    /** The Key Usages multi-select: open once, click each option (the popover stays open), Escape, wait until hidden. */
    async chooseUsages(usages: string[]): Promise<void> {
        const trigger = this.dialog.getByTestId('select-usagesSelect-trigger');
        await expect(trigger).toBeEnabled();
        await trigger.click();
        const listbox = this.page.getByRole('listbox').last();
        await expect(listbox.getByRole('option').first()).toBeVisible();
        for (const usage of usages) {
            const option = listbox.getByRole('option', { name: new RegExp(`^${usage}\\b`, 'i') }).first();
            await expect(option).toBeVisible();
            await option.click();
        }
        await this.page.keyboard.press('Escape');
        await expect(listbox).toBeHidden();
    }

    enableSwitch(): Locator {
        return this.dialog.getByTestId('switch-enabledSwitch-input');
    }

    async submitCreateProfile(name: string): Promise<string> {
        await submitButton(this.dialog).click();
        await expect(this.dialog).toBeHidden({ timeout: 30_000 });
        await waitForListRows(this.page);
        const link = this.main.getByRole('link', { name, exact: true }).first();
        await expect(link).toBeVisible({ timeout: 30_000 });
        const href = (await link.getAttribute('href')) ?? '';
        const uuid = /detail\/(?:[0-9a-f-]{36}\/)?([0-9a-f-]{36})\/?$/.exec(href)?.[1] ?? /([0-9a-f-]{36})(?!.*[0-9a-f-]{36})/.exec(href)?.[1];
        if (!uuid) throw new Error(`token profile row ${name}: no detail link with a uuid (href ${href})`);
        return uuid;
    }

    async openProfileDetail(tokenUuid: string, profileUuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/tokenprofiles/detail/${tokenUuid}/${profileUuid}`);
        await expect(this.profileDetails()).toBeVisible();
    }

    profileDetails(): Locator {
        return widget(this.main, 'Token Profile Details');
    }

    profileRow(dataId: string): Locator {
        return this.profileDetails().locator(`tr[data-id="${dataId}"]`);
    }

    profileButton(button: ProfileButton): Locator {
        return iconButton(this.profileDetails(), PROFILE_ICON[button]);
    }

    /** The Enabled row of the profile detail shows a `Disabled` / `Enabled` badge. */
    async assertProfileEnabled(enabled: boolean): Promise<void> {
        // Whole words: `/Enabled/` would also match "Disabled".
        await expect(this.profileRow('enabled').locator('td').last()).toHaveText(enabled ? /^\s*Enabled\s*$/ : /^\s*Disabled\s*$/);
    }

    async enableProfile(): Promise<void> {
        await this.profileButton('enable').click();
        await this.assertProfileEnabled(true);
    }
}
