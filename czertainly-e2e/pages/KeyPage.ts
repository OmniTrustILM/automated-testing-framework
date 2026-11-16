/**
 * KeyPage — the Key Inventory: the Create Key modal ("Generate new" form) and the key detail page (SMK-006).
 * The RSA size appears only once RSA is chosen, so the order of the steps lives here.
 */

import { Download, Locator, Page, Request, Response, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CreateAnswer, createAnswerOf } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { fillText } from './ui/form';
import { chooseOption, readSelectOptions, selectOfTrigger } from './ui/select';
import { ButtonState, expectButtons } from './ui/toolbar';
import { widgetTitled } from './ui/widget';
import { FORM_SUBMIT_MS, PAGE_ROUTE_MS } from '../utils/regression/timeouts';
import { Family, FAMILIES, SCP_ATTR } from '../utils/regression/platform/cryptoAlgorithmCases';

const logger = new Logger('KeyPage');

const ATTR = '__attributes__cryptographicKey__.';

/** The key families the Create Key form is driven with. */
export type KeyFamily = Extract<Family, 'rsa-2048' | 'rsa-4096' | 'ec-p256' | 'ml-dsa-65' | 'falcon-1024'>;

/** The option each family takes in its size / curve / level select, as the software cryptography provider renders it. */
export const KEY_FORM_OPTIONS: Readonly<Record<KeyFamily, string | RegExp | undefined>> = {
    'rsa-2048': 'RSA_2048',
    'rsa-4096': 'RSA_4096',
    'ec-p256': /secp256r1|P-256/,
    // The level option is the provider's reference `MLDSA_65` (or its label `ML-DSA-65`), never a bare number.
    'ml-dsa-65': /\bML-?DSA[_-]65\b/,
    'falcon-1024': undefined,
};

export type KeyButton = 'enable' | 'disable';
/** Item buttons carry an explicit id (`<id>-button`), not the icon id of the key toolbar. */
export type ItemButton = 'enable' | 'disable' | 'compromise' | 'destroy' | 'sign' | 'verify' | 'encrypt' | 'decrypt';

/** How long the UI may take from the click to the download of a signature or a verification result. */
const DOWNLOAD_MS = 30_000;
/** The signature selects come with the connector's answer and may render apart: their count must hold this long. */
const SELECTS_SETTLE_MS = 2_000;
/** A dialog without any select is taken only after this long: the first select may come seconds after the dialog. */
const NO_SELECT_MS = 10_000;
const SELECTS_LOAD_MS = 30_000;

export interface KeyCreateWatch {
    /** How many key-pair create requests the page has sent so far. */
    requests(): number;
    /** Waits until every request sent so far was answered (or failed) and returns the answers. */
    settled(timeout?: number): Promise<CreateAnswer[]>;
    stop(): void;
}

export class KeyPage {
    readonly page: Page;
    readonly main: Locator;

    // Create Key dialog
    readonly dialog: Locator;
    readonly submitButton: Locator;
    readonly createButton: Locator;
    readonly nameInput: Locator;
    readonly tokenProfileTrigger: Locator;
    readonly typeTrigger: Locator;
    readonly keyAliasInput: Locator;
    readonly keyAlgorithmTrigger: Locator;

    // Key Details: the key-level rows and toolbar
    readonly keyDetails: Locator;
    readonly enableKeyButton: Locator;
    readonly disableKeyButton: Locator;

    /** The shown item's toolbar: the hook `key-item-actions` (fe-administrator#2325) when the UI has it, else the last tab layout. */
    readonly itemToolbar: Locator;

    // Sign Data dialog
    readonly signDataDialog: Locator;
    readonly signDataTextarea: Locator;
    readonly signDataSelectTriggers: Locator;
    readonly confirmSignButton: Locator;

    // Verify Signature dialog
    readonly verifySignatureDialog: Locator;
    readonly verifyDataTextarea: Locator;
    readonly signatureFileInput: Locator;
    readonly verifySignatureSelectTriggers: Locator;
    readonly confirmVerifyButton: Locator;

    // Compromised Key dialog
    readonly compromisedKeyDialog: Locator;
    readonly compromiseReasonTrigger: Locator;
    readonly confirmCompromiseButton: Locator;

    // Destroy Key dialog
    readonly destroyKeyDialog: Locator;
    readonly confirmDestroyButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.dialog = page.getByRole('dialog', { name: 'Create Key', exact: true });
        this.submitButton = this.dialog.getByTestId('progress-button');
        this.createButton = this.submitButton.last();
        this.nameInput = this.dialog.getByTestId('text-input-name');
        this.tokenProfileTrigger = this.dialog.getByTestId('select-tokenProfileSelect-trigger');
        this.typeTrigger = this.dialog.getByTestId('select-typeSelect-trigger');
        this.keyAliasInput = this.dialog.getByTestId(`text-input-${ATTR}data_keyAlias`);
        this.keyAlgorithmTrigger = this.dialog.getByTestId(`select-${ATTR}data_keyAlgorithmSelect-trigger`);

        this.keyDetails = widgetTitled(this.main, 'Key Details');
        this.enableKeyButton = this.keyDetails.getByTestId('check-button');
        this.disableKeyButton = this.keyDetails.getByTestId('times-button');

        this.itemToolbar = this.main.getByTestId('key-item-actions').or(this.main.getByTestId('tab-layout').last()).first();

        this.signDataDialog = page.getByRole('dialog', { name: 'Sign Data', exact: true });
        this.signDataTextarea = this.signDataDialog.locator('[id="data__fileUpload__fileContent"]');
        this.signDataSelectTriggers = this.signDataDialog.locator('button[aria-haspopup="listbox"]');
        this.confirmSignButton = this.signDataDialog.getByRole('button', { name: 'Sign', exact: true });

        this.verifySignatureDialog = page.getByRole('dialog', { name: 'Verify Signature', exact: true });
        this.verifyDataTextarea = this.verifySignatureDialog.locator('[id="data__fileUpload__fileContent"]');
        this.signatureFileInput = this.verifySignatureDialog.locator('[id="signature__fileUpload__file"]');
        this.verifySignatureSelectTriggers = this.verifySignatureDialog.locator('button[aria-haspopup="listbox"]');
        this.confirmVerifyButton = this.verifySignatureDialog.getByRole('button', { name: 'Verify', exact: true });

        this.compromisedKeyDialog = page.getByRole('dialog', { name: 'Compromised Key', exact: true });
        this.compromiseReasonTrigger = this.compromisedKeyDialog.getByTestId('select-compromiseReason-trigger');
        this.confirmCompromiseButton = this.compromisedKeyDialog.getByRole('button', { name: 'Yes', exact: true });

        this.destroyKeyDialog = page.getByRole('dialog', { name: 'Destroy Key', exact: true });
        this.confirmDestroyButton = this.destroyKeyDialog.getByRole('button', { name: 'Destroy', exact: true });
    }

    /** The size / curve / level select of a key family (`data_rsaKeySize`, `data_ecdsaCurve`, …). */
    keySpecTrigger(specSelect: string): Locator {
        return this.dialog.getByTestId(`select-${ATTR}${specSelect}Select-trigger`);
    }

    itemButton(button: ItemButton): Locator {
        return this.itemToolbar.getByTestId(`${button}-button`);
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/keys');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateModal(): Promise<void> {
        logger.info('Opening Create Key');
        await this.main.getByTestId('plus-button').click();
        await expect(this.nameInput).toBeVisible();
    }

    /** Each select reveals the next field. */
    async fillRsaKeyPair(options: { name: string; tokenProfileName: string; alias: string; rsaSize: '1024' | '2048' | '4096' }): Promise<void> {
        logger.info(`Filling Create Key: ${options.name} on ${options.tokenProfileName}, RSA ${options.rsaSize}`);
        await fillText(this.nameInput, options.name);
        await chooseOption(this.page, this.tokenProfileTrigger, options.tokenProfileName);
        await chooseOption(this.page, this.typeTrigger, 'Key pair');
        await fillText(this.keyAliasInput, options.alias);
        await chooseOption(this.page, this.keyAlgorithmTrigger, 'RSA');
        await chooseOption(this.page, this.keySpecTrigger(SCP_ATTR.rsaKeySize.name), `RSA_${options.rsaSize}`);
    }

    async submit(): Promise<string> {
        await this.submitButton.click();
        const uuid = await waitForDetailRoute(this.page, 'keys', { timeout: PAGE_ROUTE_MS });
        logger.info(`Key created: ${uuid}`);
        return uuid;
    }

    /** Key items reuse ids such as `name`, so the lookup stays inside the Key Details widget. */
    row(dataId: string): Locator {
        return this.keyDetails.locator(`tr[data-id="${dataId}"]`);
    }

    async openKeyItem(name: 'Public key' | 'Private key'): Promise<void> {
        const tab = this.main.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
    }

    /** Both items' tables may stay in the DOM, so only the visible one counts. */
    itemRow(dataId: string): Locator {
        return this.main.locator(`tr[data-id="${dataId}"]:visible`);
    }

    async enableKey(): Promise<void> {
        logger.info('Enabling the key');
        await this.enableKeyButton.click();
    }

    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/keys/detail/${uuid}`);
        await expect(this.keyDetails).toBeVisible();
    }

    /** The option texts the Token Profile select offers (the form lists enabled profiles only). */
    async offeredTokenProfiles(): Promise<string[]> {
        return readSelectOptions(this.page, selectOfTrigger(this.page, this.tokenProfileTrigger));
    }

    /** "Generate new" for a family of `KEY_FORM_OPTIONS`; each select reveals the next field. */
    async fillKeyPair(options: { name: string; tokenProfileName: string; alias: string; family: KeyFamily }): Promise<void> {
        const f = FAMILIES[options.family];
        const option = KEY_FORM_OPTIONS[options.family];
        logger.info(`Filling Create Key: ${options.name} on ${options.tokenProfileName}, ${f.label}`);
        await fillText(this.nameInput, options.name);
        await chooseOption(this.page, this.tokenProfileTrigger, options.tokenProfileName);
        await chooseOption(this.page, this.typeTrigger, 'Key pair');
        await fillText(this.keyAliasInput, options.alias);
        await chooseOption(this.page, this.keyAlgorithmTrigger, f.algorithm);
        if (option !== undefined) await chooseOption(this.page, this.keySpecTrigger(SCP_ATTR[f.spec[0].attribute].name), option);
    }

    /** Clicks Create (twice with `doubleClick`) and returns the first create answer; the redirect is not waited for. */
    async submitCreateForm(options: { doubleClick?: boolean } = {}): Promise<CreateAnswer> {
        return submitCreate(this.page, this.createButton, {
            endpoint: '/keys/keyPair',
            timeout: FORM_SUBMIT_MS,
            doubleClick: options.doubleClick,
        });
    }

    /**
     * Collects EVERY key-pair create request of the page and its answer (register it before the click): a double click may send two
     * creates, and each accepted one is an object on the tier.
     */
    watchCreates(): KeyCreateWatch {
        let sent = 0;
        let failed = 0;
        const answers: Array<Promise<CreateAnswer>> = [];
        const isCreate = (method: string, url: string): boolean => method === 'POST' && /\/keys\/keyPair$/.test(url.split('?')[0]);
        const sentAt = new Map<Request, number>();
        const onRequest = (r: Request): void => {
            if (!isCreate(r.method(), r.url())) return;
            sent += 1;
            sentAt.set(r, Date.now());
        };
        const onFailed = (r: Request): void => { if (isCreate(r.method(), r.url())) failed += 1; };
        const onResponse = (r: Response): void => {
            if (isCreate(r.request().method(), r.url())) answers.push(createAnswerOf(r, sentAt.get(r.request()) ?? Date.now()));
        };
        this.page.on('request', onRequest);
        this.page.on('requestfailed', onFailed);
        this.page.on('response', onResponse);
        return {
            requests: () => sent,
            settled: async (timeout = PAGE_ROUTE_MS) => {
                await expect
                    .poll(() => answers.length + failed, { timeout, message: 'every key-pair create request was answered' })
                    .toBeGreaterThanOrEqual(sent);
                return Promise.all(answers);
            },
            stop: () => {
                this.page.off('request', onRequest);
                this.page.off('requestfailed', onFailed);
                this.page.off('response', onResponse);
            },
        };
    }

    async disableKey(): Promise<void> {
        logger.info('Disabling the key');
        await this.disableKeyButton.click();
    }

    async assertKeyButtons(expected: Partial<Record<KeyButton, ButtonState>>): Promise<void> {
        const buttons: Record<KeyButton, Locator> = { enable: this.enableKeyButton, disable: this.disableKeyButton };
        await expectButtons((b: KeyButton) => buttons[b], expected, 'key toolbar');
    }

    async assertItemButtons(expected: Partial<Record<ItemButton, ButtonState>>): Promise<void> {
        await expectButtons((b: ItemButton) => this.itemButton(b), expected, 'item toolbar');
    }

    /** The state badge CELL of the shown item (`Active`, `Compromised`, `Destroyed Compromised`, …), without the row's label. */
    async assertItemState(label: RegExp, timeout?: number): Promise<void> {
        await expect(this.itemRow('state').locator('td').last()).toContainText(label, timeout === undefined ? undefined : { timeout });
    }

    /** The badge CELL, as a whole word: the row's label reads "Enabled" whatever the badge says. */
    async assertItemEnabled(enabled: boolean): Promise<void> {
        await expect(this.itemRow('enabled').locator('td').last()).toHaveText(enabled ? /^\s*Enabled\s*$/ : /^\s*Disabled\s*$/);
    }

    async assertItemAlgorithm(algorithm: RegExp): Promise<void> {
        await expect(this.itemRow('keyAlgorithm')).toContainText(algorithm);
    }

    /**
     * Sign Data on the shown private item: types `data` (the UI base64-encodes it), chooses the signature attributes; the download.
     * The selects come with the connector's answer, seconds after the dialog.
     */
    async signWithKey(data: string, signatureOption?: string | RegExp): Promise<Download> {
        await this.itemButton('sign').click();
        await this.signDataDialog.waitFor({ state: 'visible' });
        await this.signDataTextarea.click();
        await this.signDataTextarea.fill(data);
        await this.chooseEmptySelects(this.signDataSelectTriggers, signatureOption);
        const download = this.page.waitForEvent('download', { timeout: DOWNLOAD_MS });
        await this.confirmSignButton.click();
        const file = await download;
        await this.signDataDialog.waitFor({ state: 'hidden' });
        return file;
    }

    /** Verify Signature on the shown public item with `signature` (the bytes of the signature download); the verification download. */
    async verifyWithKey(data: string, signature: Buffer, signatureOption?: string | RegExp): Promise<Download> {
        await this.itemButton('verify').click();
        await this.verifySignatureDialog.waitFor({ state: 'visible' });
        await this.verifyDataTextarea.click();
        await this.verifyDataTextarea.fill(data);
        await this.signatureFileInput.setInputFiles({ name: 'signature.sign', mimeType: 'application/octet-stream', buffer: signature });
        // The file input fills the content box asynchronously: wait until it holds the signature.
        await this.page.waitForFunction(
            () => ((document.getElementById('signature__fileUpload__fileContent') as HTMLInputElement | null)?.value ?? '') !== '',
        );
        await this.chooseEmptySelects(this.verifySignatureSelectTriggers, signatureOption);
        const download = this.page.waitForEvent('download', { timeout: DOWNLOAD_MS });
        await this.confirmVerifyButton.click();
        const file = await download;
        await this.verifySignatureDialog.waitFor({ state: 'hidden' });
        return file;
    }

    /**
     * The signature attributes, when the connector asks for any: once the number of selects holds still, every select still showing
     * "Select …" gets an option, until none is left.
     */
    private async chooseEmptySelects(triggers: Locator, option?: string | RegExp): Promise<void> {
        const start = Date.now();
        let count = -1;
        let since = start;
        await expect
            .poll(async () => {
                const n = await triggers.count();
                if (n !== count) [count, since] = [n, Date.now()];
                return Date.now() - since >= SELECTS_SETTLE_MS && (n > 0 || Date.now() - start >= NO_SELECT_MS);
            }, { message: 'the signature selects stopped appearing', timeout: SELECTS_LOAD_MS, intervals: [250] })
            .toBe(true);
        const empty = async (): Promise<Locator[]> => {
            const out: Locator[] = [];
            for (const trigger of await triggers.all()) if (/^Select /.test((await trigger.innerText()).trim())) out.push(trigger);
            return out;
        };
        await expect(async () => {
            for (const trigger of await empty()) await chooseOption(this.page, trigger, option ?? /.+/);
            expect(await empty(), 'every signature select has a choice').toHaveLength(0);
        }).toPass({ timeout: SELECTS_LOAD_MS });
    }

    async compromiseKeyItem(reason: string | RegExp = /disclosure/i): Promise<void> {
        await this.itemButton('compromise').click();
        await expect(this.compromisedKeyDialog).toBeVisible();
        await chooseOption(this.page, this.compromiseReasonTrigger, reason);
        await this.confirmCompromiseButton.click();
        await expect(this.compromisedKeyDialog).toBeHidden();
    }

    async destroyKeyItem(): Promise<void> {
        await this.itemButton('destroy').click();
        await expect(this.destroyKeyDialog).toBeVisible();
        await this.confirmDestroyButton.click();
        await expect(this.destroyKeyDialog).toBeHidden();
    }
}
