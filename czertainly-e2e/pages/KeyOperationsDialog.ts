/**
 * KeyOperationsDialog — the Sign Data and Verify Signature dialogs of a key item (REG-KEY-06).
 *
 * REG-KEY-06 signs with the private item and verifies with the public one. The UI answers with downloads, returned as
 * they are: the spec reads and judges them, and nothing is written to disk here. The dialogs are opened from the item
 * toolbar buttons the key page hands in. Any still-empty select gets an option (the signature algorithm, when the
 * connector asks).
 */
import { Download, Locator, Page } from '@playwright/test';
import { chooseOption } from './ui/select';

/** How long the UI may take from the click to the download of a signature or a verification result. */
const DOWNLOAD_MS = 30_000;

export class KeyOperationsDialog {
    /** `signButton` / `verifyButton`: the Sign and Verify buttons of the item toolbar that open the dialogs. */
    constructor(readonly page: Page, private readonly signButton: Locator, private readonly verifyButton: Locator) {}

    private dialog(caption: string): Locator {
        return this.page.getByRole('dialog', { name: caption, exact: true });
    }

    /** Types the data into the Data text area; the admin UI base64-encodes typed text before it sends it. */
    private async typeData(dialog: Locator, data: string): Promise<void> {
        const box = dialog.locator('[id="data__fileUpload__fileContent"]');
        await box.click();
        await box.fill(data);
    }

    /** Chooses an option in every still-empty select of the dialog (the signature algorithm, when the connector asks for one). */
    private async chooseSignatureAttributes(dialog: Locator, option?: string | RegExp): Promise<void> {
        for (const trigger of await dialog.locator('button[aria-haspopup="listbox"]').all()) {
            if (/^Select /.test((await trigger.innerText()).trim())) await chooseOption(this.page, trigger, option ?? /.+/);
        }
    }

    /** Sign Data: types `data`, chooses the signature attributes, submits; returns the signature download. */
    async signWithKey(data: string, signatureOption?: string | RegExp): Promise<Download> {
        await this.signButton.click();
        const dialog = this.dialog('Sign Data');
        await dialog.waitFor({ state: 'visible' });
        await this.typeData(dialog, data);
        await this.chooseSignatureAttributes(dialog, signatureOption);
        const download = this.page.waitForEvent('download', { timeout: DOWNLOAD_MS });
        await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
        const file = await download;
        await dialog.waitFor({ state: 'hidden' });
        return file;
    }

    /**
     * Verify Signature: types `data`, attaches `signature` (the bytes of the signature download) as the signature file,
     * chooses the signature attributes, submits; returns the verification-result download.
     */
    async verifyWithKey(data: string, signature: Buffer, signatureOption?: string | RegExp): Promise<Download> {
        await this.verifyButton.click();
        const dialog = this.dialog('Verify Signature');
        await dialog.waitFor({ state: 'visible' });
        await this.typeData(dialog, data);
        await dialog.locator('[id="signature__fileUpload__file"]').setInputFiles({ name: 'signature.sign', mimeType: 'application/octet-stream', buffer: signature });
        // The file input fills the content box asynchronously: wait until it holds the signature.
        await this.page.waitForFunction(() => ((document.getElementById('signature__fileUpload__fileContent') as HTMLInputElement | null)?.value ?? '') !== '');
        await this.chooseSignatureAttributes(dialog, signatureOption);
        const download = this.page.waitForEvent('download', { timeout: DOWNLOAD_MS });
        await dialog.getByRole('button', { name: 'Verify', exact: true }).click();
        const file = await download;
        await dialog.waitFor({ state: 'hidden' });
        return file;
    }
}
