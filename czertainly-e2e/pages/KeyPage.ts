/**
 * KeyPage — the Key inventory and the key detail.
 *
 * WHAT: the Key inventory: the Create Key dialog ("Generate new" for every key family) and the key detail with two
 *       toolbars: the Key Details widget and the shown item's toolbar.
 * WHY: SMK-006 generates an RSA key and checks the detail; REG-KEY-04 … 09 create per family, enable / disable,
 *       compromise and destroy. The size / curve / level select appears only after the algorithm is chosen, so the
 *       order of the steps lives here. Sign and Verify are `KeyOperationsDialog`.
 * HOW: test ids as the admin UI renders them; selects through their trigger buttons; key rows inside the Key
 *       Details widget (items reuse row ids); the item toolbar has no hook of its own yet (fe-administrator#2325),
 *       so the last tab layout stands in.
 */

import { Locator, Page, Request, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { KeyOperationsDialog } from './KeyOperationsDialog';
import { CreateAnswer, createAnswerOf } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { chooseOption, readSelectOptions, selectOfTrigger } from './ui/select';
import { ButtonState, expectButtons, ToolbarButtons } from './ui/toolbar';
import { widgetTitled } from './ui/widget';
import { FORM_SUBMIT_MS, PAGE_ROUTE_MS } from '../utils/regression/timeouts';

export type { ButtonState } from './ui/toolbar';

const logger = new Logger('KeyPage');

/** Connector attribute fields are prefixed like this in the admin UI's test ids. */
const ATTR = '__attributes__cryptographicKey__.';

/** The key families the Create Key form is driven with (option texts as the software cryptography provider renders them). */
export type KeyFamily = 'rsa-2048' | 'rsa-4096' | 'ec-p256' | 'ml-dsa-65' | 'falcon-1024';

/** How one key family is chosen in the form: the algorithm, then (when the family has one) the size / curve / level select. */
interface KeyFamilyChoice {
    algorithm: string;
    specSelect?: string;
    option?: string | RegExp;
    label: string;
}

export const KEY_FAMILIES: Readonly<Record<KeyFamily, KeyFamilyChoice>> = {
    'rsa-2048': { algorithm: 'RSA', specSelect: 'data_rsaKeySize', option: 'RSA_2048', label: 'RSA 2048' },
    'rsa-4096': { algorithm: 'RSA', specSelect: 'data_rsaKeySize', option: 'RSA_4096', label: 'RSA 4096' },
    'ec-p256': { algorithm: 'ECDSA', specSelect: 'data_ecdsaCurve', option: /secp256r1|P-256/, label: 'EC P-256' },
    // The level option is the provider's reference `MLDSA_65` (or its label `ML-DSA-65`), never a bare number.
    'ml-dsa-65': { algorithm: 'ML-DSA', specSelect: 'data_mldsaLevel', option: /\bML-?DSA[_-]65\b/, label: 'ML-DSA-65' },
    'falcon-1024': { algorithm: 'FALCON', label: 'FALCON-1024' },
};

export type KeyToolbarButton = 'edit' | 'delete' | 'enable' | 'disable' | 'compromise' | 'destroy';
export type ItemToolbarButton = 'delete' | 'enable' | 'disable' | 'usages' | 'compromise' | 'destroy' | 'sign' | 'verify' | 'export' | 'encrypt' | 'decrypt';

/** Item buttons carry an explicit id (`<id>-button`), not the icon id of the key toolbar. */
const ITEM_ID: Record<ItemToolbarButton, string> = { delete: 'delete', enable: 'enable', disable: 'disable', usages: 'key', compromise: 'compromise', destroy: 'destroy', sign: 'sign', verify: 'verify', export: 'export', encrypt: 'encrypt', decrypt: 'decrypt' };

/** What `KeyPage.watchCreates` collects. */
export interface KeyCreateWatch {
    /** How many key-pair create requests the page has sent so far. */
    requests(): number;
    /** Waits until every request sent so far was answered (or failed) and returns the answers. */
    settled(timeout?: number): Promise<CreateAnswer[]>;
}

export class KeyPage {
    readonly page: Page;
    readonly main: Locator;
    /** The Create Key dialog. */
    readonly dialog: Locator;
    /** The submit button of the Create Key dialog (for a double-click probe). */
    readonly submitButton: Locator;
    /** The `Key Details` widget: the key-level rows and toolbar. */
    readonly keyDetails: Locator;
    /** The key-level toolbar buttons by action. */
    readonly keyButtons: ToolbarButtons;
    /**
     * The toolbar of the shown item: the test-id hook `key-item-actions` (requested as fe-administrator#2325) when the
     * admin UI has it, else the last `tab-layout` of the page (the inner item layout is last in document order).
     */
    readonly itemToolbar: Locator;
    /** The Sign Data and Verify Signature dialogs of the shown item. */
    readonly operations: KeyOperationsDialog;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.dialog = page.getByRole('dialog', { name: 'Create Key', exact: true });
        this.submitButton = this.dialog.getByTestId('progress-button');
        this.keyDetails = widgetTitled(this.main, 'Key Details');
        this.keyButtons = new ToolbarButtons(this.keyDetails);
        this.itemToolbar = this.main.getByTestId('key-item-actions').or(this.main.getByTestId('tab-layout').last()).first();
        this.operations = new KeyOperationsDialog(page, this.itemButton('sign'), this.itemButton('verify'));
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/keys');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        logger.info('Opening Create Key');
        await this.main.getByTestId('plus-button').click();
        await expect(this.dialog.getByTestId('text-input-name')).toBeVisible();
    }

    /** The smoke suite's name of `openCreateDialog`. */
    async openCreateModal(): Promise<void> {
        await this.openCreateDialog();
    }

    private async type(testId: string, value: string): Promise<void> {
        const input = this.dialog.getByTestId(testId);
        await input.click();
        await input.fill(value);
    }

    /** The option texts the Token Profile select offers (the form lists enabled profiles only). */
    async offeredTokenProfiles(): Promise<string[]> {
        return readSelectOptions(this.page, selectOfTrigger(this.page, this.dialog.getByTestId('select-tokenProfileSelect-trigger')));
    }

    /**
     * Fills "Generate new": name, Token Profile, type Key pair, alias, the algorithm, then its size / curve / level. Each
     * select reveals the next field.
     */
    private async fillGenerateNew(options: { name: string; tokenProfileName: string; alias: string }, f: KeyFamilyChoice): Promise<void> {
        logger.info(`Filling Create Key: ${options.name} on ${options.tokenProfileName}, ${f.label}`);
        await this.type('text-input-name', options.name);
        await chooseOption(this.page, this.dialog.getByTestId('select-tokenProfileSelect-trigger'), options.tokenProfileName);
        await chooseOption(this.page, this.dialog.getByTestId('select-typeSelect-trigger'), 'Key pair');
        await this.type(`text-input-${ATTR}data_keyAlias`, options.alias);
        await chooseOption(this.page, this.dialog.getByTestId(`select-${ATTR}data_keyAlgorithmSelect-trigger`), f.algorithm);
        if (f.specSelect && f.option !== undefined) await chooseOption(this.page, this.dialog.getByTestId(`select-${ATTR}${f.specSelect}Select-trigger`), f.option);
    }

    /** "Generate new" for any key family of `KEY_FAMILIES`. */
    async fillKeyPair(options: { name: string; tokenProfileName: string; alias: string; family: KeyFamily }): Promise<void> {
        await this.fillGenerateNew(options, KEY_FAMILIES[options.family]);
    }

    /** "Generate new" for an RSA key pair of the given size (the smoke test's form). */
    async fillRsaKeyPair(options: { name: string; tokenProfileName: string; alias: string; rsaSize: '1024' | '2048' | '4096' }): Promise<void> {
        await this.fillGenerateNew(options, { algorithm: 'RSA', specSelect: 'data_rsaKeySize', option: `RSA_${options.rsaSize}`, label: `RSA ${options.rsaSize}` });
    }

    /** Submits the form and returns the new key's UUID from the detail page the platform opens. */
    async submit(): Promise<string> {
        await this.submitButton.click();
        const uuid = await waitForDetailRoute(this.page, 'keys', { timeout: PAGE_ROUTE_MS });
        logger.info(`Key created: ${uuid}`);
        return uuid;
    }

    /**
     * Clicks Create (twice with `doubleClick`, the double-submit probe) and returns the answer of the first key-pair create
     * request: status, the new key's uuid, the request. It does not wait for the redirect: record the uuid first, then
     * `waitForDetailRoute()`. (`submit()` is the smoke suite's variant that waits for the detail page.)
     */
    async submitCreateForm(options: { doubleClick?: boolean } = {}): Promise<CreateAnswer> {
        return submitCreate(this.page, this.dialog, { endpoint: '/keys/keyPair', timeout: FORM_SUBMIT_MS, doubleClick: options.doubleClick });
    }

    /**
     * Starts collecting EVERY key-pair create request of the page and its answer (register it before the click). A double-click probe may
     * send two creates; each accepted one is an object on the tier, so the spec records every answer, not only the first.
     */
    watchCreates(): KeyCreateWatch {
        let sent = 0;
        let failed = 0;
        const answers: Array<Promise<CreateAnswer>> = [];
        const isCreate = (method: string, url: string): boolean => method === 'POST' && /\/keys\/keyPair$/.test(url.split('?')[0]);
        const sentAt = new Map<Request, number>();
        this.page.on('request', (r) => {
            if (!isCreate(r.method(), r.url())) return;
            sent += 1;
            sentAt.set(r, Date.now());
        });
        this.page.on('requestfailed', (r) => { if (isCreate(r.method(), r.url())) failed += 1; });
        this.page.on('response', (r) => { if (isCreate(r.request().method(), r.url())) answers.push(createAnswerOf(r, sentAt.get(r.request()) ?? Date.now())); });
        return {
            requests: () => sent,
            settled: async (timeout = PAGE_ROUTE_MS) => {
                await expect.poll(() => answers.length + failed, { timeout, message: 'every key-pair create request was answered' }).toBeGreaterThanOrEqual(sent);
                return Promise.all(answers);
            },
        };
    }

    /** Waits for the redirect to the new key's detail page after a successful create and returns its uuid. */
    async waitForDetailRoute(timeout = PAGE_ROUTE_MS): Promise<string> {
        return waitForDetailRoute(this.page, 'keys', { timeout });
    }

    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/keys/detail/${uuid}`);
        await expect(this.keyDetails).toBeVisible();
    }

    /**
     * A row of the Key Details table, by the admin UI's `data-id`. Key items reuse ids such as `name`, so the lookup
     * stays inside the Key Details widget.
     */
    private keyDetailRow(dataId: string): Locator {
        return this.keyDetails.locator(`tr[data-id="${dataId}"]`);
    }

    /** The former name of `keyDetailRow` (the smoke test uses it). */
    row(dataId: string): Locator {
        return this.keyDetailRow(dataId);
    }

    /** Switches the key-item tabs to "Public key" or "Private key". */
    async openKeyItem(name: 'Public key' | 'Private key'): Promise<void> {
        const tab = this.main.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    /** A row of the key item shown in the active tab. Both items' tables may stay in the DOM, so only the visible one counts. */
    private itemDetailRow(dataId: string): Locator {
        return this.main.locator(`tr[data-id="${dataId}"]:visible`);
    }

    /** The former name of `itemDetailRow` (the smoke test uses it). */
    itemRow(dataId: string): Locator {
        return this.itemDetailRow(dataId);
    }

    keyButton(button: KeyToolbarButton): Locator {
        return this.keyButtons.button(button);
    }

    itemButton(button: ItemToolbarButton): Locator {
        return this.itemToolbar.getByTestId(`${ITEM_ID[button]}-button`);
    }

    /** Enables the whole key from the Key Details toolbar. The platform enables it at once, no dialog. */
    async enableKey(): Promise<void> {
        logger.info('Enabling the key');
        await this.keyButton('enable').click();
    }

    async disableKey(): Promise<void> {
        logger.info('Disabling the key');
        await this.keyButton('disable').click();
    }

    async assertKeyButtons(expected: Partial<Record<KeyToolbarButton, ButtonState>>): Promise<void> {
        await expectButtons((b: KeyToolbarButton) => this.keyButton(b), expected, 'key toolbar');
    }

    async assertItemButtons(expected: Partial<Record<ItemToolbarButton, ButtonState>>): Promise<void> {
        await expectButtons((b: ItemToolbarButton) => this.itemButton(b), expected, 'item toolbar');
    }

    /** The state badge of the shown item (`Active`, `Compromised`, `Destroyed Compromised`, …). */
    async assertItemState(label: RegExp): Promise<void> {
        await expect(this.itemDetailRow('state')).toContainText(label);
    }

    /** The Enabled row's badge: `Enabled` or `Disabled` as a whole word (`/Enabled/` would also match "Disabled"). */
    async assertItemEnabled(enabled: boolean): Promise<void> {
        // The badge CELL, not the row: the row's label reads "Enabled" whatever the badge says.
        await expect(this.itemDetailRow('enabled').locator('td').last()).toHaveText(enabled ? /^\s*Enabled\s*$/ : /^\s*Disabled\s*$/);
    }

    /** The item's algorithm row. */
    async assertItemAlgorithm(algorithm: RegExp): Promise<void> {
        await expect(this.itemDetailRow('keyAlgorithm')).toContainText(algorithm);
    }

    /** The usages badges of the shown item (lower-case codes as rendered: sign, verify, …). */
    async readItemUsages(): Promise<string[]> {
        // One badge per usage (inline elements: a joined innerText would read "signdecrypt"): read each element's text.
        const texts = await this.itemDetailRow('Usages').locator('td').last().locator('span, div, a').allInnerTexts();
        return texts.map((t) => t.trim().toLowerCase()).filter((t) => /^(sign|verify|encrypt|decrypt|wrap|unwrap)$/.test(t));
    }

    // ------------------------------------------------------------ item dialogs

    private dialogByCaption(caption: string): Locator {
        return this.page.getByRole('dialog', { name: caption, exact: true });
    }

    /** Compromise the shown item: the dialog `Compromised Key` with its reason select and `Yes`. */
    async compromiseKeyItem(reason: string | RegExp = /disclosure/i): Promise<void> {
        await this.itemButton('compromise').click();
        const dialog = this.dialogByCaption('Compromised Key');
        await expect(dialog).toBeVisible();
        await chooseOption(this.page, dialog.getByTestId('select-compromiseReason-trigger'), reason);
        await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
        await expect(dialog).toBeHidden();
    }

    /** Destroy the shown item: the dialog `Destroy Key` and its `Destroy` button. */
    async destroyKeyItem(): Promise<void> {
        await this.itemButton('destroy').click();
        const dialog = this.dialogByCaption('Destroy Key');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Destroy', exact: true }).click();
        await expect(dialog).toBeHidden();
    }
}
