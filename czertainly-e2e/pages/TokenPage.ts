/**
 * TokenPage — the Tokens list, dialog and detail.
 *
 * WHAT: the Tokens list, the Create Token dialog (provider and the connector's attribute form) and the token detail
 *       with its status badge and toolbar.
 * WHY: REG-KEY-01 creates a v2 software token in the form and checks the v2 status and which toolbar actions are disabled.
 * HOW: the attribute form renders after the provider's schema loads, and asks "new or existing" only when the
 *       provider already holds tokens — both selects are tried; the create answer carries the new token's uuid, so a
 *       spec records it before the dialog closes (`waitForCreateDialogClosed`).
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate } from './ui/detailRoute';
import { customAttributesDefined, fillRequiredCustomAttributes, fillText } from './ui/form';
import { waitForListRows } from './ui/list';
import { chooseOption } from './ui/select';
import { ButtonState, expectButtons, ToolbarButtons } from './ui/toolbar';
import { widgetTitled } from './ui/widget';
import { ATTRIBUTE_FORM_MS, FORM_SUBMIT_MS, PAGE_ROUTE_MS } from '../utils/regression/timeouts';

const logger = new Logger('TokenPage');

/** The AttributeEditor prefix of the token form (`__attributes__token__.<attribute name>`). */
const TOKEN_ATTR = '__attributes__token__.';

export type TokenButton = 'edit' | 'delete' | 'reload' | 'sync' | 'activate' | 'deactivate' | 'random';

export class TokenPage {
    readonly main: Locator;
    /** The Create Token dialog. */
    readonly dialog: Locator;
    /** The `Token Details` widget: the token rows and toolbar. */
    readonly tokenDetails: Locator;
    private readonly tokenButtons: ToolbarButtons;

    constructor(readonly page: Page) {
        this.main = page.locator('main');
        this.dialog = page.getByRole('dialog', { name: 'Create Token', exact: true });
        this.tokenDetails = widgetTitled(this.main, 'Token Details');
        this.tokenButtons = new ToolbarButtons(this.tokenDetails);
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/tokens');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
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
        await expect(options.or(action).first()).toBeVisible({ timeout: ATTRIBUTE_FORM_MS });
        // Either select may be absent (it depends on the tokens the provider already holds); isVisible() never throws.
        if (await options.isVisible()) {
            await chooseOption(this.page, options, /new/i);
            filled.push('data_options');
        }
        if (await action.isVisible()) {
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
        filled.push(...(await fillRequiredCustomAttributes(this.page, this.dialog, 'qa', await customAttributesDefined(this.page, 'tokens'))));
        return filled;
    }

    /**
     * Submits the Create Token dialog and returns the answer of `POST /v1/tokens` (status, the new token's uuid, the request).
     * It does not wait for the dialog to close: record the uuid first, then `waitForCreateDialogClosed()`.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        return submitCreate(this.page, this.dialog, { endpoint: '/v1/tokens', timeout: FORM_SUBMIT_MS });
    }

    /** Waits until the Create Token dialog has closed after a successful create. */
    async waitForCreateDialogClosed(timeout = PAGE_ROUTE_MS): Promise<void> {
        await expect(this.dialog).toBeHidden({ timeout });
    }

    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/tokens/detail/${uuid}`);
        await expect(this.tokenDetails).toBeVisible();
    }

    /** A row of the Token Details table by its `data-id` (`status`, `name`, `kind`, `cryptographyProviderName`, …). */
    private tokenRow(dataId: string): Locator {
        return this.tokenDetails.locator(`tr[data-id="${dataId}"]`);
    }

    private tokenButton(button: TokenButton): Locator {
        return this.tokenButtons.button(button);
    }

    /** The status badge text of the detail (`Connected`, `Disconnected`, `Warning`, `Unknown`, `Activated`, `Deactivated`). */
    async readStatusBadge(): Promise<string> {
        return (await this.tokenRow('status').innerText()).replace(/^\s*Status\s*/i, '').trim();
    }

    async assertStatusBadge(oneOf: readonly string[]): Promise<string> {
        const text = await this.readStatusBadge();
        expect(oneOf.some((s) => text.includes(s)), `token status badge "${text}" is one of ${oneOf.join(', ')}`).toBe(true);
        return text;
    }

    async assertButtons(expected: Partial<Record<TokenButton, Exclude<ButtonState, 'absent'>>>): Promise<void> {
        await expectButtons((b: TokenButton) => this.tokenButton(b), expected, 'token toolbar');
    }

    /** The token is listed (a link with its name) on the list page that is open. */
    async assertListed(name: string): Promise<void> {
        await waitForListRows(this.page);
        await expect(this.main.getByRole('link', { name, exact: true }).first()).toBeVisible();
    }
}
