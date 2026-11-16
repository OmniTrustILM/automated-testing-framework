/**
 * TokenPage — the Tokens list, the Create Token dialog with the connector's attribute form, and the token detail (REG-KEY-01).
 * The attribute form asks "new or existing" only when the provider already holds tokens, so both selects are tried.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { waitForListRows } from './ui/list';
import { chooseOption } from './ui/select';
import { ButtonState, expectButtons } from './ui/toolbar';
import { widgetTitled } from './ui/widget';
import { ATTRIBUTE_FORM_MS, FORM_SUBMIT_MS, PAGE_ROUTE_MS } from '../utils/regression/timeouts';

const logger = new Logger('TokenPage');

const TOKEN_ATTR = '__attributes__token__.';

export type TokenButton = 'edit' | 'delete' | 'reload' | 'sync' | 'activate' | 'deactivate' | 'random';

export class TokenPage {
    readonly page: Page;
    readonly main: Locator;

    // Tokens list
    readonly addTokenButton: Locator;

    // Create Token dialog
    readonly createTokenDialog: Locator;
    readonly nameInput: Locator;
    readonly tokenProviderTrigger: Locator;
    readonly storeKindTrigger: Locator;
    readonly optionsTrigger: Locator;
    readonly createTokenActionTrigger: Locator;
    readonly newTokenNameInput: Locator;
    readonly tokenCodeInput: Locator;
    readonly createButton: Locator;

    // Token Details
    readonly tokenDetails: Locator;
    readonly statusRow: Locator;
    readonly editButton: Locator;
    readonly deleteButton: Locator;
    readonly reloadButton: Locator;
    readonly syncButton: Locator;
    readonly activateButton: Locator;
    readonly deactivateButton: Locator;
    readonly randomButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.addTokenButton = this.main.getByTestId('plus-button');

        this.createTokenDialog = page.getByRole('dialog', { name: 'Create Token', exact: true });
        this.nameInput = this.createTokenDialog.getByTestId('text-input-name');
        this.tokenProviderTrigger = this.createTokenDialog.getByTestId('select-tokenProviderSelect-trigger');
        this.storeKindTrigger = this.createTokenDialog.getByTestId('select-storeKindSelect-trigger');
        this.optionsTrigger = this.createTokenDialog.getByTestId(`select-${TOKEN_ATTR}data_optionsSelect-trigger`);
        this.createTokenActionTrigger = this.createTokenDialog.getByTestId(`select-${TOKEN_ATTR}data_createTokenActionSelect-trigger`);
        this.newTokenNameInput = this.createTokenDialog.getByTestId(`text-input-${TOKEN_ATTR}data_newTokenName`);
        this.tokenCodeInput = this.createTokenDialog.getByTestId(`text-input-${TOKEN_ATTR}data_tokenCode`);
        this.createButton = this.createTokenDialog.getByTestId('progress-button').last();

        this.tokenDetails = widgetTitled(this.main, 'Token Details');
        this.statusRow = this.tokenDetails.locator('tr[data-id="status"]');
        this.editButton = this.tokenDetails.getByTestId('pencil-button');
        this.deleteButton = this.tokenDetails.getByTestId('trash-button');
        this.reloadButton = this.tokenDetails.getByTestId('reload-button');
        this.syncButton = this.tokenDetails.getByTestId('refresh-button');
        this.activateButton = this.tokenDetails.getByTestId('check-button');
        this.deactivateButton = this.tokenDetails.getByTestId('times-button');
        this.randomButton = this.tokenDetails.getByTestId('random-button');
    }

    tokenLink(name: string): Locator {
        return this.main.getByRole('link', { name, exact: true }).first();
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/tokens');
        await expect(this.addTokenButton).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        logger.info('Opening Create Token');
        await this.addTokenButton.click();
        await expect(this.nameInput).toBeVisible();
    }

    /**
     * A software token: name, the provider, (the kind on a v1 provider), then the connector attributes: action `new`, the provider-side
     * name and the activation code. Returns the fields it filled.
     */
    async fillSoftwareToken(opts: { name: string; connectorName: string; alias: string; activationCode: string; kind?: string }): Promise<string[]> {
        const filled: string[] = [];
        await fillText(this.nameInput, opts.name);
        await chooseOption(this.page, this.tokenProviderTrigger, opts.connectorName);
        if (opts.kind) await chooseOption(this.page, this.storeKindTrigger, opts.kind);
        // The attribute form renders after the schema loads: the action select (or the options select first) marks it.
        await expect(this.optionsTrigger.or(this.createTokenActionTrigger).first()).toBeVisible({ timeout: ATTRIBUTE_FORM_MS });
        if (await this.optionsTrigger.isVisible()) {
            await chooseOption(this.page, this.optionsTrigger, /new/i);
            filled.push('data_options');
        }
        if (await this.createTokenActionTrigger.isVisible()) {
            await chooseOption(this.page, this.createTokenActionTrigger, /new/i);
            filled.push('data_createTokenAction');
        }
        await expect(this.newTokenNameInput).toBeVisible();
        await fillText(this.newTokenNameInput, opts.alias);
        filled.push('data_newTokenName');
        await expect(this.tokenCodeInput).toBeVisible();
        await fillText(this.tokenCodeInput, opts.activationCode);
        filled.push('data_tokenCode');
        filled.push(...(await fillRequiredCustomAttributes(this.page, this.createTokenDialog, 'qa', await customAttributesDefined(this.page, 'tokens'))));
        return filled;
    }

    /** Returns the answer of `POST /v1/tokens`; record it, then `waitForCreateDialogClosed`. */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, { endpoint: '/v1/tokens', timeout: FORM_SUBMIT_MS });
    }

    async waitForCreateDialogClosed(timeout = PAGE_ROUTE_MS): Promise<void> {
        await expect(this.createTokenDialog).toBeHidden({ timeout });
    }

    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/tokens/detail/${uuid}`);
        await expect(this.tokenDetails).toBeVisible();
    }

    /** The status badge text (`Connected`, `Disconnected`, `Warning`, `Unknown`, `Activated`, `Deactivated`) is one of `oneOf`. */
    async assertStatusBadge(oneOf: readonly string[]): Promise<string> {
        await expect(this.statusRow).toContainText(new RegExp(oneOf.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
        const text = (await this.statusRow.innerText()).replace(/^\s*Status\s*/i, '').trim();
        expect(oneOf.some((s) => text.includes(s)), `token status badge "${text}" is one of ${oneOf.join(', ')}`).toBe(true);
        return text;
    }

    async assertButtons(expected: Partial<Record<TokenButton, Exclude<ButtonState, 'absent'>>>): Promise<void> {
        const buttons: Record<TokenButton, Locator> = {
            edit: this.editButton,
            delete: this.deleteButton,
            reload: this.reloadButton,
            sync: this.syncButton,
            activate: this.activateButton,
            deactivate: this.deactivateButton,
            random: this.randomButton,
        };
        await expectButtons((b: TokenButton) => buttons[b], expected, 'token toolbar');
    }

    async assertListed(name: string): Promise<void> {
        await waitForListRows(this.page);
        await expect(this.tokenLink(name)).toBeVisible();
    }
}
