/**
 * KeyPage — Page Object for the Key Inventory: the Create Key modal and the key detail page.
 *
 * WHAT: opens Create Key, fills the "Generate new" form (name, Token Profile, key type and the
 * connector's attributes: alias, algorithm, RSA size), submits it, and reads the detail page the
 * platform lands on: the key's own rows, its attributes, and the rows of each key item.
 *
 * WHY: SMK-006 drives the form a user fills in. The connector attributes are rendered from the
 * provider's definitions, and the RSA size only appears once RSA is chosen, so the order of the
 * steps matters and lives here rather than in the test.
 *
 * HOW: test ids as the FE renders them. Selects are driven through their `-trigger` button, not
 * the hidden native <select>, and text inputs are clicked before fill (both see
 * reference_ilm_fe_playwright_patterns). The list is opened by URL, not through the sidebar.
 *
 * B3 (platform area, REG-KEY-04…09): `fillKeyPair(family)` for every §3 family, the two toolbars as SEPARATE scopes —
 * `keyActions()` is the `Key Details` widget (phase-04 E3), `itemActions()` the item-level toolbar (E4; until the
 * fe-administrator hook request R2 (`key-item-actions`, fe-administrator#2325) lands, the item toolbar is the last
 * `tab-layout` on the page, which holds the shown item) — no method uses a bare `getByTestId('compromise-button')`;
 * compromise / destroy / sign / verify dialogs by caption (E5); state / enabled badges by row id.
 */

import { Download, Page, Locator, expect } from '@playwright/test';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';
import { chooseOption, iconButton, widget } from './RegressionUi';

const logger = new Logger('KeyPage');

/** The bytes of a download (Playwright keeps it under the test output; the suite never writes it anywhere else). */
async function readDownload(download: Download): Promise<Buffer> {
    const file = await download.path();
    if (!file) throw new Error(`download ${download.suggestedFilename()} has no file (${(await download.failure()) ?? 'no failure reported'})`);
    return fs.readFileSync(file);
}

/** Connector attribute fields are prefixed like this in the FE's test ids. */
const ATTR = '__attributes__cryptographicKey__.';

/** The §3 families REG-KEY-04 / 06 drive through the form (option texts as the SCP renders them). */
export type UiKeyFamily = 'rsa-2048' | 'rsa-4096' | 'ec-p256' | 'ml-dsa-65' | 'falcon-1024';

export const UI_FAMILY: Readonly<Record<UiKeyFamily, { algorithm: string; specSelect?: string; option?: string | RegExp; label: string }>> = {
    'rsa-2048': { algorithm: 'RSA', specSelect: 'data_rsaKeySize', option: 'RSA_2048', label: 'RSA 2048' },
    'rsa-4096': { algorithm: 'RSA', specSelect: 'data_rsaKeySize', option: 'RSA_4096', label: 'RSA 4096' },
    'ec-p256': { algorithm: 'ECDSA', specSelect: 'data_ecdsaCurve', option: /secp256r1|P-256/, label: 'EC P-256' },
    'ml-dsa-65': { algorithm: 'ML-DSA', specSelect: 'data_mldsaLevel', option: /65|MLDSA_65|\b3\b/, label: 'ML-DSA-65' },
    'falcon-1024': { algorithm: 'FALCON', label: 'FALCON-1024' },
};

export type KeyToolbarButton = 'edit' | 'delete' | 'enable' | 'disable' | 'compromise' | 'destroy';
export type ItemToolbarButton = 'delete' | 'enable' | 'disable' | 'usages' | 'compromise' | 'destroy' | 'sign' | 'verify' | 'export';

const KEY_ICON: Record<KeyToolbarButton, string> = { edit: 'pencil', delete: 'trash', enable: 'check', disable: 'times', compromise: 'compromise', destroy: 'destroy' };
/** Item buttons carry an explicit id (`id ?? icon`-button): delete, enable, disable, key, compromise, destroy, sign, verify, export. */
const ITEM_ID: Record<ItemToolbarButton, string> = { delete: 'delete', enable: 'enable', disable: 'disable', usages: 'key', compromise: 'compromise', destroy: 'destroy', sign: 'sign', verify: 'verify', export: 'export' };

export type ButtonState = 'enabled' | 'disabled' | 'absent';

export class KeyPage {
    readonly page: Page;
    readonly main: Locator;
    readonly dialog: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.dialog = page.getByRole('dialog');
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/keys');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateModal(): Promise<void> {
        logger.info('Opening Create Key');
        await this.main.getByTestId('plus-button').click();
        await expect(this.dialog.getByTestId('text-input-name')).toBeVisible();
    }

    private async choose(selectId: string, option: string | RegExp): Promise<void> {
        await chooseOption(this.page, this.dialog.getByTestId(`select-${selectId}-trigger`), option);
    }

    private async type(testId: string, value: string): Promise<void> {
        const input = this.dialog.getByTestId(testId);
        await input.click();
        await input.fill(value);
    }

    /** The option texts the Token Profile select offers (REG-KEY-03: enabled profiles only). */
    async tokenProfileOptions(): Promise<string[]> {
        const trigger = this.dialog.getByTestId('select-tokenProfileSelect-trigger');
        await trigger.click();
        const listbox = this.page.getByRole('listbox').last();
        await expect(listbox.getByRole('option').first()).toBeVisible();
        const texts = (await listbox.getByRole('option').allInnerTexts()).map((t) => t.trim());
        await this.page.keyboard.press('Escape');
        await expect(listbox).toBeHidden();
        return texts;
    }

    /** Fills "Generate new" for an RSA key pair. Each select reveals the next field. */
    async fillRsaKeyPair(options: { name: string; tokenProfileName: string; alias: string; rsaSize: '1024' | '2048' | '4096' }): Promise<void> {
        logger.info(`Filling Create Key: ${options.name} on ${options.tokenProfileName}, RSA ${options.rsaSize}`);
        await this.type('text-input-name', options.name);
        await this.choose('tokenProfileSelect', options.tokenProfileName);
        await this.choose('typeSelect', 'Key pair');
        await this.type(`text-input-${ATTR}data_keyAlias`, options.alias);
        await this.choose(`${ATTR}data_keyAlgorithmSelect`, 'RSA');
        await this.choose(`${ATTR}data_rsaKeySizeSelect`, `RSA_${options.rsaSize}`);
    }

    /** Fills "Generate new" for any §3 family (REG-KEY-04): the algorithm, then the family's size / curve / level option when it has one. */
    async fillKeyPair(options: { name: string; tokenProfileName: string; alias: string; family: UiKeyFamily }): Promise<void> {
        const f = UI_FAMILY[options.family];
        logger.info(`Filling Create Key: ${options.name} on ${options.tokenProfileName}, ${f.label}`);
        await this.type('text-input-name', options.name);
        await this.choose('tokenProfileSelect', options.tokenProfileName);
        await this.choose('typeSelect', 'Key pair');
        await this.type(`text-input-${ATTR}data_keyAlias`, options.alias);
        await this.choose(`${ATTR}data_keyAlgorithmSelect`, f.algorithm);
        if (f.specSelect && f.option !== undefined) await this.choose(`${ATTR}${f.specSelect}Select`, f.option);
    }

    /** Submits the form and returns the new key's UUID from the detail page the platform opens. */
    async submit(): Promise<string> {
        await this.dialog.getByTestId('progress-button').click();
        await expect(this.page).toHaveURL(/\/keys\/detail\/[0-9a-f-]{36}/, { timeout: 30_000 });
        const uuid = /\/keys\/detail\/([0-9a-f-]{36})/.exec(this.page.url())![1];
        logger.info(`Key created: ${uuid}`);
        return uuid;
    }

    /** The submit button of the Create Key dialog (for the double-click probe of REG-KEY-04). */
    submitButton(): Locator {
        return this.dialog.getByTestId('progress-button');
    }

    async openDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/keys/detail/${uuid}`);
        await expect(this.keyDetails()).toBeVisible();
    }

    /** The `Key Details` widget: the key-level toolbar and rows (phase-04 E3). */
    keyDetails(): Locator {
        return widget(this.main, 'Key Details');
    }

    /** The key-level toolbar scope. */
    keyActions(): Locator {
        return this.keyDetails();
    }

    /**
     * A row of the Key Details table, by the FE's `data-id`. Key items reuse ids such as `name`,
     * so the lookup stays inside the Key Details widget.
     */
    row(dataId: string): Locator {
        return this.keyDetails().locator(`tr[data-id="${dataId}"]`);
    }

    /** Switches the key-item tabs to "Public key" or "Private key". */
    async openKeyItem(name: 'Public key' | 'Private key'): Promise<void> {
        const tab = this.main.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    /**
     * The item-level scope: the wrapper hook `key-item-actions` (R2, fe-administrator#2325) when the FE has it, else the
     * last `tab-layout` of the page (the inner item layout is last in document order; phase-04 E4 workaround).
     */
    itemActions(): Locator {
        const hook = this.main.getByTestId('key-item-actions');
        return hook.or(this.main.getByTestId('tab-layout').last()).first();
    }

    /**
     * A row of the key item shown in the active tab. Both items' tables may stay in the DOM, so
     * only the visible one counts.
     */
    itemRow(dataId: string): Locator {
        return this.main.locator(`tr[data-id="${dataId}"]:visible`);
    }

    keyButton(button: KeyToolbarButton): Locator {
        return iconButton(this.keyActions(), KEY_ICON[button]);
    }

    itemButton(button: ItemToolbarButton): Locator {
        return this.itemActions().getByTestId(`${ITEM_ID[button]}-button`);
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

    private async assertState(scope: 'key' | 'item', button: KeyToolbarButton | ItemToolbarButton, state: ButtonState): Promise<void> {
        const b = scope === 'key' ? this.keyButton(button as KeyToolbarButton) : this.itemButton(button as ItemToolbarButton);
        if (state === 'absent') {
            await expect(b, `${scope} toolbar ${button} absent`).toHaveCount(0);
            return;
        }
        await expect(b, `${scope} toolbar ${button}`).toBeVisible();
        if (state === 'enabled') await expect(b, `${scope} toolbar ${button} enabled`).toBeEnabled();
        else await expect(b, `${scope} toolbar ${button} disabled`).toBeDisabled();
    }

    async assertKeyButtons(expected: Partial<Record<KeyToolbarButton, ButtonState>>): Promise<void> {
        for (const [button, state] of Object.entries(expected) as Array<[KeyToolbarButton, ButtonState]>) await this.assertState('key', button, state);
    }

    async assertItemButtons(expected: Partial<Record<ItemToolbarButton, ButtonState>>): Promise<void> {
        for (const [button, state] of Object.entries(expected) as Array<[ItemToolbarButton, ButtonState]>) await this.assertState('item', button, state);
    }

    /** The state badge of the shown item (`Active`, `Compromised`, `Destroyed Compromised`, …). */
    async assertItemState(label: RegExp): Promise<void> {
        await expect(this.itemRow('state')).toContainText(label);
    }

    /** The Enabled row's badge: `Enabled` or `Disabled` as a whole word (`/Enabled/` would also match "Disabled"). */
    async assertItemEnabled(enabled: boolean): Promise<void> {
        // The badge CELL, not the row: the row's label reads "Enabled" whatever the badge says.
        await expect(this.itemRow('enabled').locator('td').last()).toHaveText(enabled ? /^\s*Enabled\s*$/ : /^\s*Disabled\s*$/);
    }

    /** The item's algorithm row. */
    async assertItemAlgorithm(algorithm: RegExp): Promise<void> {
        await expect(this.itemRow('keyAlgorithm')).toContainText(algorithm);
    }

    /** The usages badges of the shown item (lower-case codes as rendered: sign, verify, …). */
    async itemUsages(): Promise<string[]> {
        // One badge per usage (inline elements: a joined innerText would read "signdecrypt"): read each element's text.
        const texts = await this.itemRow('Usages').locator('td').last().locator('span, div, a').allInnerTexts();
        return texts.map((t) => t.trim().toLowerCase()).filter((t) => /^(sign|verify|encrypt|decrypt|wrap|unwrap)$/.test(t));
    }

    // ------------------------------------------------------------ dialogs (phase-04 E5)

    private dialogByCaption(caption: string | RegExp): Locator {
        return this.page.getByRole('dialog').filter({ hasText: caption }).last();
    }

    /** Compromise the shown ITEM: the dialog `Compromised Key` with its reason select and `Yes`. */
    async compromiseItem(reason: string | RegExp = /disclosure/i): Promise<void> {
        await this.itemButton('compromise').click();
        const dialog = this.dialogByCaption('Compromised Key');
        await expect(dialog).toBeVisible();
        await chooseOption(this.page, dialog.getByTestId('select-compromiseReason-trigger'), reason);
        await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
        await expect(dialog).toBeHidden();
    }

    /** Destroy the shown ITEM: the dialog `Destroy Key` and its `Destroy` button. */
    async destroyItem(): Promise<void> {
        await this.itemButton('destroy').click();
        const dialog = this.dialogByCaption('Destroy Key');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Destroy', exact: true }).click();
        await expect(dialog).toBeHidden();
    }

    /**
     * Opens `Sign Data`, types the data into the Data text area (the FE base64-encodes typed text, FileUpload.tsx:122),
     * chooses the signature algorithm when the form asks, submits. The FE delivers the signature as a DOWNLOAD
     * (`signature.sign`, ducks/cryptographic-operations.ts signDataSuccess): the raw signature bytes are returned.
     */
    async signItem(data: string, signatureOption?: string | RegExp): Promise<Buffer> {
        await this.itemButton('sign').click();
        const dialog = this.dialogByCaption('Sign Data');
        await expect(dialog).toBeVisible();
        const box = dialog.locator('[id="data__fileUpload__fileContent"]');
        await box.click();
        await box.fill(data);
        await this.chooseSignatureAttributes(dialog, signatureOption);
        const download = this.page.waitForEvent('download', { timeout: 30_000 });
        await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
        const file = await download;
        expect(file.suggestedFilename(), 'the FE downloads the signature').toMatch(/\.sign$/);
        await expect(dialog).toBeHidden();
        return readDownload(file);
    }

    /**
     * Opens `Verify Signature`, types the data, chooses the signature FILE (the raw bytes `signItem` returned), submits.
     * The FE delivers the result as a DOWNLOAD (`verification-result.json`, verifyDataSuccess): returns `result` of
     * the first verification (true = verified).
     */
    async verifyItem(data: string, signature: Buffer, signatureOption?: string | RegExp): Promise<boolean> {
        await this.itemButton('verify').click();
        const dialog = this.dialogByCaption('Verify Signature');
        await expect(dialog).toBeVisible();
        const dataBox = dialog.locator('[id="data__fileUpload__fileContent"]');
        await dataBox.click();
        await dataBox.fill(data);
        await dialog.locator('[id="signature__fileUpload__file"]').setInputFiles({ name: 'signature.sign', mimeType: 'application/octet-stream', buffer: signature });
        await expect(dialog.locator('[id="signature__fileUpload__fileContent"]')).not.toHaveValue('');
        await this.chooseSignatureAttributes(dialog, signatureOption);
        const download = this.page.waitForEvent('download', { timeout: 30_000 });
        await dialog.getByRole('button', { name: 'Verify', exact: true }).click();
        const file = await download;
        expect(file.suggestedFilename(), 'the FE downloads the verification result').toMatch(/verification-result\.json$/);
        await expect(dialog).toBeHidden();
        const body = JSON.parse((await readDownload(file)).toString('utf8')) as { verifications?: Array<{ result?: boolean }> };
        const result = body.verifications?.[0]?.result;
        expect(typeof result, 'the verification result carries a boolean').toBe('boolean');
        return result === true;
    }

    /** The v2 `signatureAlgorithm` select of the sign / verify dialog (when the connector asks for attributes). */
    private async chooseSignatureAttributes(dialog: Locator, option?: string | RegExp): Promise<void> {
        const triggers = dialog.locator('button[aria-haspopup="listbox"]');
        if (!(await triggers.count())) return;
        for (const trigger of await triggers.all()) {
            if (/^Select /.test((await trigger.innerText()).trim())) await chooseOption(this.page, trigger, option ?? /.+/);
        }
    }

    /** The signature the platform shows after Sign (the `Signature` result dialog / alert), or the announced text. */
    async readSignatureResult(): Promise<string> {
        const result = this.page.getByRole('dialog').filter({ hasText: /Signature|Signed/i }).last().getByRole('textbox').first();
        if (await result.isVisible().catch(() => false)) {
            const text = await result.inputValue();
            await this.page.keyboard.press('Escape');
            return text.trim();
        }
        const pre = this.page.getByRole('dialog').last().locator('pre, code, textarea').first();
        const text = (await pre.innerText().catch(() => '')).trim();
        await this.page.keyboard.press('Escape').catch(() => {});
        return text;
    }
}
