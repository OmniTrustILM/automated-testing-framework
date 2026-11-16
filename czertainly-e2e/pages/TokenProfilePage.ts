/**
 * TokenProfilePage — the Token Profiles list, the Create Token Profile dialog and the profile detail (REG-KEY-03).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText, setSwitch } from './ui/form';
import { chooseOption, chooseOptions, selectOfTrigger } from './ui/select';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { FORM_SUBMIT_MS, PAGE_ROUTE_MS } from '../utils/regression/timeouts';
import { actAndReadAnswer, UUID } from './ui/waitForResponse';
import { widgetTitled } from './ui/widget';

const logger = new Logger('TokenProfilePage');

export class TokenProfilePage {
    readonly page: Page;
    readonly main: Locator;

    // Token Profiles list
    readonly addTokenProfileButton: Locator;

    // Create Token Profile dialog
    readonly createTokenProfileDialog: Locator;
    readonly nameInput: Locator;
    /** A hidden checkbox input: `setSwitch` clicks its label. */
    readonly enabledSwitch: Locator;
    readonly tokenTrigger: Locator;
    readonly usagesTrigger: Locator;
    readonly createButton: Locator;

    // Token Profile Details
    readonly profileDetails: Locator;
    readonly enabledRow: Locator;
    readonly enableButton: Locator;
    readonly disableButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.addTokenProfileButton = this.main.getByTestId('plus-button');

        this.createTokenProfileDialog = page.getByRole('dialog', { name: 'Create Token Profile', exact: true });
        this.nameInput = this.createTokenProfileDialog.getByTestId('text-input-name');
        this.enabledSwitch = this.createTokenProfileDialog.getByTestId('switch-enabledSwitch-input');
        this.tokenTrigger = this.createTokenProfileDialog.getByTestId('select-tokenSelect-trigger');
        this.usagesTrigger = this.createTokenProfileDialog.getByTestId('select-usagesSelect-trigger');
        this.createButton = this.createTokenProfileDialog.getByTestId('progress-button').last();

        this.profileDetails = widgetTitled(this.main, 'Token Profile Details');
        this.enabledRow = this.profileDetails.locator('tr[data-id="enabled"]');
        this.enableButton = this.profileDetails.getByTestId('check-button');
        this.disableButton = this.profileDetails.getByTestId('times-button');
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/tokenprofiles');
        await expect(this.addTokenProfileButton).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        logger.info('Opening Create Token Profile');
        await this.addTokenProfileButton.click();
        await expect(this.nameInput).toBeVisible();
    }

    /**
     * Name, the token (required) and the usages (by the option's value: its text runs the label into a description); sets Enabled when
     * asked (the form starts with it on). The usages multi-select is closed with Escape.
     */
    async fillProfile(opts: { name: string; tokenName: string; usages: string[]; enabled?: boolean }): Promise<void> {
        await fillText(this.nameInput, opts.name);
        if (opts.enabled !== undefined) await setSwitch(this.createTokenProfileDialog, this.enabledSwitch, opts.enabled);
        await chooseOption(this.page, this.tokenTrigger, opts.tokenName);
        await chooseOptions(this.page, selectOfTrigger(this.page, this.usagesTrigger), opts.usages.map((usage) => ({ value: usage })));
        await fillRequiredCustomAttributes(this.page, this.createTokenProfileDialog, 'qa', await customAttributesDefined(this.page, 'tokenProfiles'));
    }

    /** Returns the answer of `POST /v1/tokens/<token>/tokenProfiles`; record it, then `waitForCreateDialogClosed`. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: /\/v1\/tokens\/[0-9a-f-]{36}\/tokenProfiles$/, timeout: FORM_SUBMIT_MS });
    }

    async waitForCreateDialogClosed(timeout = PAGE_ROUTE_MS): Promise<void> {
        await expect(this.createTokenProfileDialog).toBeHidden({ timeout });
    }

    async goToDetail(tokenUuid: string, profileUuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/tokenprofiles/detail/${tokenUuid}/${profileUuid}`);
        await expect(this.profileDetails).toBeVisible();
    }

    /** The badge cell as a whole word: `/Enabled/` would also match "Disabled". */
    async assertProfileEnabled(enabled: boolean): Promise<void> {
        await expect(this.enabledRow.locator('td').last()).toHaveText(enabled ? /^\s*Enabled\s*$/ : /^\s*Disabled\s*$/);
    }

    /** Clicks Enable and returns the answer of the enable request; the caller asserts it. */
    async enableProfile(): Promise<ApiAnswer> {
        return actAndReadAnswer(this.page, { method: 'PATCH', path: new RegExp(`/v1/tokens/${UUID}/tokenProfiles/${UUID}/enable$`) }, () => this.enableButton.click());
    }
}
