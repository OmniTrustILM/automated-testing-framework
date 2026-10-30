/**
 * TokenProfilePage — Page Object Model for token profiles (REG-KEY-03).
 *
 * Encapsulates:
 *   - the Token Profiles list and the Create Token Profile dialog
 *   - the profile detail with its toolbar
 *
 * The enable switch is a hidden input, so its label is clicked. The spec records the new profile's uuid before the
 * dialog closes.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText, setSwitch } from './ui/form';
import { chooseOption, chooseOptions, selectOfTrigger } from './ui/select';
import { ToolbarButtons } from './ui/toolbar';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { FORM_SUBMIT_MS, PAGE_ROUTE_MS } from '../utils/regression/timeouts';
import { actAndWaitForApi, answerFrom, UUID } from './ui/waitForResponse';
import { widgetTitled } from './ui/widget';

const logger = new Logger('TokenProfilePage');

export type ProfileButton = 'edit' | 'delete' | 'enable' | 'disable' | 'usages';

export class TokenProfilePage {
    readonly main: Locator;
    /** The Create Token Profile dialog. */
    readonly dialog: Locator;
    /** The enable switch of the create form (a hidden checkbox input). */
    readonly enabledSwitch: Locator;
    /** The `Token Profile Details` widget: the profile rows and toolbar. */
    readonly profileDetails: Locator;
    private readonly profileButtons: ToolbarButtons;

    constructor(readonly page: Page) {
        this.main = page.locator('main');
        this.dialog = page.getByRole('dialog', { name: 'Create Token Profile', exact: true });
        this.enabledSwitch = this.dialog.getByTestId('switch-enabledSwitch-input');
        this.profileDetails = widgetTitled(this.main, 'Token Profile Details');
        this.profileButtons = new ToolbarButtons(this.profileDetails);
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/tokenprofiles');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        logger.info('Opening Create Token Profile');
        await this.main.getByTestId('plus-button').click();
        await expect(this.dialog.getByTestId('text-input-name')).toBeVisible();
    }

    /** Fills name, the token (required) and the usages; switches Enabled on when asked. */
    async fillProfile(opts: { name: string; tokenName: string; usages: string[]; enabled?: boolean }): Promise<void> {
        await fillText(this.dialog.getByTestId('text-input-name'), opts.name);
        if (opts.enabled) {
            await setSwitch(this.dialog, 'enabledSwitch', true);
        }
        await chooseOption(this.page, this.dialog.getByTestId('select-tokenSelect-trigger'), opts.tokenName);
        await this.chooseUsages(opts.usages);
        await fillRequiredCustomAttributes(this.page, this.dialog, 'qa', await customAttributesDefined(this.page, 'tokenProfiles'));
    }

    /** The Key Usages multi-select: open once, click each option (the popover stays open), Escape, wait until hidden. */
    private async chooseUsages(usages: string[]): Promise<void> {
        await chooseOptions(this.page, selectOfTrigger(this.page, this.dialog.getByTestId('select-usagesSelect-trigger')), usages.map((usage) => new RegExp(`^${usage}\\b`, 'i')));
    }

    /**
     * Submits the Create Token Profile dialog and returns the answer of `POST /v1/tokens/<token>/tokenProfiles` (status, the new
     * profile's uuid, the request). It does not wait for the dialog to close: record the uuid first, then `waitForCreateDialogClosed()`.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.dialog, { endpoint: /\/v1\/tokens\/[0-9a-f-]{36}\/tokenProfiles$/, timeout: FORM_SUBMIT_MS });
    }

    /** Waits until the Create Token Profile dialog has closed after a successful create. */
    async waitForCreateDialogClosed(timeout = PAGE_ROUTE_MS): Promise<void> {
        await expect(this.dialog).toBeHidden({ timeout });
    }

    async goToDetail(tokenUuid: string, profileUuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/tokenprofiles/detail/${tokenUuid}/${profileUuid}`);
        await expect(this.profileDetails).toBeVisible();
    }

    private profileRow(dataId: string): Locator {
        return this.profileDetails.locator(`tr[data-id="${dataId}"]`);
    }

    profileButton(button: ProfileButton): Locator {
        return this.profileButtons.button(button);
    }

    /** The Enabled row of the profile detail shows a `Disabled` / `Enabled` badge. */
    async assertProfileEnabled(enabled: boolean): Promise<void> {
        // Whole words: `/Enabled/` would also match "Disabled".
        await expect(this.profileRow('enabled').locator('td').last()).toHaveText(enabled ? /^\s*Enabled\s*$/ : /^\s*Disabled\s*$/);
    }

    /** Clicks Enable in the profile toolbar and returns the answer of the enable request; the caller asserts it. */
    async enableProfile(): Promise<ApiAnswer> {
        const startedAt = Date.now();
        const response = await actAndWaitForApi(this.page, { method: 'PATCH', path: new RegExp(`/v1/tokens/${UUID}/tokenProfiles/${UUID}/enable$`) }, () => this.profileButton('enable').click());
        return answerFrom(response, startedAt);
    }
}
