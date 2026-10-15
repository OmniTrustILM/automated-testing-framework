/**
 * CertificateLifecyclePage — the lifecycle half of the certificate pages (B2 / B3, cert-lifecycle area): the detail
 * toolbar (phase-04 B3), the Renew / Rekey / Revoke / Complete dialogs (B5–B8), the Registration widget (B9), the
 * Approvals and Related Certificates tabs (B10) and the Pre-register form fields (B1).
 *
 * Phase-05 planned these as an UPDATE of `CertificatePage`; they are delivered as a subclass so the shared file is not
 * touched by this area (the merge pass may fold them in). Every method that CHANGES a certificate is called only on a
 * certificate the run created: the spec checks it first with `assertOwnLive` (the browser is not behind the API guard;
 * decision Q1, review R16).
 *
 * Locators (fe-administrator origin/main): toolbar icons `retweet` / `rekey` / `minus-square` / `check` / `cubes`
 * scoped by the `Certificate Properties` / `CSR Properties` widget (A1 / A2); dialogs by their caption; `Select` ids
 * `select-<id>-trigger` (or `<dataTestId>-trigger`), `TextInput` ids `text-input-<id>` (or the given `dataTestId`),
 * `Switch` ids `switch-<id>-input`, `FileUpload` textarea `#<id>__fileUpload__fileContent`; tabs by role, Registration
 * rows `tr[data-id=registrationState|registrationExpiresAt|registrationFailedAttempts]`.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { SanSet, sameSans } from '../utils/regression/pki';
import { CertificatePage } from './CertificatePage';
import { chooseOption, fillText, iconButton, widget } from './RegressionUi';

const logger = new Logger('CertificateLifecyclePage');

/** The detail toolbar actions and their icon ids (WidgetButtons `data-testid="<icon>-button"`, phase-04 B3). */
export const TOOLBAR_ICONS = {
    issue: 'cubes',
    renew: 'retweet',
    rekey: 'rekey',
    revoke: 'minus-square',
    complete: 'check',
    delete: 'trash',
    archive: 'archive',
    unarchive: 'unarchive',
} as const;

export type ToolbarAction = keyof typeof TOOLBAR_ICONS;
export type ButtonState = 'enabled' | 'disabled';
export type DetailTab = 'Details' | 'Request' | 'Attributes' | 'Validation' | 'Approvals' | 'Locations' | 'History' | 'Event History' | 'Flow' | 'Related Certificates' | 'Comments';

const slug = (tab: string): string => tab.toLowerCase().replace(/\s+/g, '-');

export class CertificateLifecyclePage extends CertificatePage {
    constructor(page: Page) {
        super(page);
    }

    // ------------------------------------------------------------------ detail page: toolbar and tabs

    /** The properties widget of the detail page (`Certificate Properties`, or `CSR Properties` before issuance). */
    get propertiesWidget(): Locator {
        return widget(this.main, /^(Certificate|CSR) Properties$/);
    }

    toolbarButton(action: ToolbarAction): Locator {
        return iconButton(this.propertiesWidget, TOOLBAR_ICONS[action]);
    }

    /** The §7.6 decision table: each named toolbar action is enabled or disabled. */
    async assertToolbar(expected: Partial<Record<ToolbarAction, ButtonState>>): Promise<void> {
        for (const [action, state] of Object.entries(expected) as Array<[ToolbarAction, ButtonState]>) {
            const button = this.toolbarButton(action);
            await expect(button, `toolbar ${action}`).toBeVisible();
            if (state === 'enabled') await expect(button, `toolbar ${action} enabled`).toBeEnabled();
            else await expect(button, `toolbar ${action} disabled`).toBeDisabled();
        }
    }

    /** Open a detail tab by its URL slug (`?tab=<slug>`, phase-04 A10) and reload: no race with a click. */
    async openDetailTab(uuid: string, tab: DetailTab): Promise<void> {
        logger.info(`Opening certificate ${uuid} tab ${tab}`);
        await this.page.goto(`/administrator/#/certificates/detail/${uuid}?tab=${slug(tab)}`);
        await expect(this.main).toBeVisible();
        await expect(this.tablist.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    }

    /** The state label shown in the Details tab (`certificate-status` of the `certState` row). */
    get stateBadge(): Locator {
        return this.main.locator('tr[data-id="certState"] [data-testid="certificate-status"]');
    }

    async assertState(label: string): Promise<void> {
        await this.openTab('Details');
        await expect(this.stateBadge).toHaveText(label);
    }

    // ------------------------------------------------------------------ Renew dialog (B5)

    get renewDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Renew Certificate' });
    }

    async openRenewDialog(): Promise<Locator> {
        logger.info('Opening the Renew dialog');
        await this.toolbarButton('renew').click();
        await expect(this.renewDialog).toBeVisible();
        return this.renewDialog;
    }

    /** The "Register instead of renewing now" switch (fe#2281) is off: the dialog renews. */
    async assertRenewRegisterOff(): Promise<void> {
        const sw = this.renewDialog.getByTestId('switch-registerSuccessor-input');
        await expect(sw).toBeVisible();
        await expect(sw).not.toBeChecked();
    }

    /** The Challenge field of the renew dialog (shown only for a certificate with an active registration, fe#1857). */
    get renewChallenge(): Locator {
        return this.renewDialog.getByTestId('text-input-renewAuthorizationSecret');
    }

    /**
     * Paste a CSR into the renew dialog. With a platform private key the CSR is optional behind the "Upload new CSR ?"
     * switch; an externally keyed certificate always shows the upload (fe `allowWithoutFile = privateKeyAvailability`).
     */
    async pasteRenewCsr(csrPem: string): Promise<void> {
        const uploadSwitch = this.renewDialog.getByTestId('switch-uploadCsr-input');
        if (await uploadSwitch.isVisible().catch(() => false)) {
            if (!(await uploadSwitch.isChecked())) await uploadSwitch.click();
        }
        const textarea = this.renewDialog.locator('#__fileUpload__fileContent');
        await expect(textarea).toBeVisible();
        await textarea.fill(csrPem);
    }

    /** Submit the renew dialog and return the uuid the renew call answered (`POST …/renew` → `{uuid}`). */
    async submitRenew(): Promise<{ status: number; uuid?: string }> {
        const answer = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/certificates\/[0-9a-f-]{36}\/renew$/.test(new URL(r.url()).pathname));
        await this.renewDialog.getByTestId('renewSubmit').click();
        const res = await answer;
        let uuid: string | undefined;
        try {
            uuid = (JSON.parse(await res.text()) as { uuid?: string }).uuid;
        } catch {
            uuid = undefined;
        }
        return { status: res.status(), uuid };
    }

    get renewDialogError(): Locator {
        return this.renewDialog.getByTestId('renewDialogError');
    }

    // ------------------------------------------------------------------ Rekey dialog (B6)

    get rekeyDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Rekey Certificate' });
    }

    async openRekeyDialog(): Promise<Locator> {
        logger.info('Opening the Rekey dialog');
        await this.toolbarButton('rekey').click();
        await expect(this.rekeyDialog).toBeVisible();
        return this.rekeyDialog;
    }

    /** Key Source → External, then the CSR into the upload. */
    async fillRekeyExternal(csrPem: string): Promise<void> {
        await chooseOption(this.page, this.rekeyDialog.getByTestId('select-uploadCsr-trigger'), 'External');
        const textarea = this.rekeyDialog.locator('#__fileUpload__fileContent');
        await expect(textarea).toBeVisible();
        await textarea.fill(csrPem);
    }

    get rekeySubmit(): Locator {
        return this.rekeyDialog.getByRole('button', { name: /^(Rekey|Register)$/ });
    }

    /** Submit the rekey dialog and return the rekey call's answer (`POST …/rekey`). */
    async submitRekey(): Promise<{ status: number; uuid?: string; text: string }> {
        const answer = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/certificates\/[0-9a-f-]{36}\/rekey$/.test(new URL(r.url()).pathname));
        await expect(this.rekeySubmit).toBeEnabled();
        await this.rekeySubmit.click();
        const res = await answer;
        const text = await res.text();
        let uuid: string | undefined;
        try {
            uuid = (JSON.parse(text) as { uuid?: string }).uuid;
        } catch {
            uuid = undefined;
        }
        return { status: res.status(), uuid, text };
    }

    get rekeyDialogError(): Locator {
        return this.rekeyDialog.getByTestId('rekeyDialogError');
    }

    async closeRekeyDialog(): Promise<void> {
        await this.rekeyDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(this.rekeyDialog).toBeHidden();
    }

    // ------------------------------------------------------------------ Revoke dialog (B7)

    get revokeDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Revoke Certificate' });
    }

    async openRevokeDialog(): Promise<Locator> {
        logger.info('Opening the Revoke dialog');
        await this.toolbarButton('revoke').click();
        await expect(this.revokeDialog).toBeVisible();
        return this.revokeDialog;
    }

    get revokeReasonTrigger(): Locator {
        return this.revokeDialog.getByTestId('select-revokeReason-trigger');
    }

    /**
     * The reason options the dialog offers (labels, in the order shown): read from the hidden native `<select id="revokeReason">`
     * the Select component mirrors for tests (every option but the "Choose" placeholder), no popover interaction.
     */
    async revokeReasonLabels(): Promise<string[]> {
        const options = this.revokeDialog.locator('select#revokeReason option');
        await expect(options.first()).toBeAttached();
        const labels: string[] = [];
        for (const o of await options.all()) {
            if ((await o.getAttribute('value')) === '') continue;
            labels.push(((await o.textContent()) ?? '').trim());
        }
        return labels;
    }

    /** The dialog offers exactly these labels (order-insensitive, no extras). */
    async assertRevokeReasons(expected: readonly string[]): Promise<void> {
        const shown = await this.revokeReasonLabels();
        expect([...shown].sort(), 'revoke reasons').toEqual([...expected].sort());
    }

    async chooseRevokeReason(label: string): Promise<void> {
        await chooseOption(this.page, this.revokeReasonTrigger, label);
    }

    /** Submit the revoke dialog and return the revoke call's status (`POST …/revoke` → 204). */
    async submitRevoke(): Promise<number> {
        const answer = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/certificates\/[0-9a-f-]{36}\/revoke$/.test(new URL(r.url()).pathname));
        await this.revokeDialog.getByTestId('revokeSubmit').click();
        return (await answer).status();
    }

    // ------------------------------------------------------------------ Complete dialog (B8)

    get completeDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Complete Certificate Registration' });
    }

    async openCompleteDialog(): Promise<Locator> {
        logger.info('Opening the Complete dialog');
        await this.toolbarButton('complete').click();
        await expect(this.completeDialog).toBeVisible();
        return this.completeDialog;
    }

    /** Challenge (when the registration has one) and the CSR (Key Source External = upload). */
    async fillComplete(opts: { secret?: string; csrPem: string }): Promise<void> {
        if (opts.secret !== undefined) {
            const secret = this.completeDialog.getByTestId('completeAuthorizationSecret');
            await expect(secret).toBeVisible();
            await fillText(secret, opts.secret);
        }
        const textarea = this.completeDialog.locator('#completeCsrUpload__fileUpload__fileContent');
        await expect(textarea).toBeVisible();
        await textarea.fill(opts.csrPem);
    }

    /** Submit the complete dialog; returns the completion call's answer (`POST …/certificates/{uuid}/issue`). */
    async submitComplete(): Promise<{ status: number; text: string }> {
        const answer = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/certificates\/[0-9a-f-]{36}\/issue$/.test(new URL(r.url()).pathname));
        const submit = this.completeDialog.getByTestId('completeRegisteredSubmit');
        await expect(submit).toBeEnabled();
        await submit.click();
        const res = await answer;
        return { status: res.status(), text: await res.text() };
    }

    get completeDialogError(): Locator {
        return this.completeDialog.getByTestId('completeRegisteredError');
    }

    async closeCompleteDialog(): Promise<void> {
        await this.completeDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(this.completeDialog).toBeHidden();
    }

    // ------------------------------------------------------------------ Registration widget (B9)

    get registrationWidget(): Locator {
        return widget(this.main, 'Registration');
    }

    registrationRow(row: 'state' | 'expires' | 'failedAttempts'): Locator {
        const id = { state: 'registrationState', expires: 'registrationExpiresAt', failedAttempts: 'registrationFailedAttempts' }[row];
        return this.registrationWidget.locator(`tr[data-id="${id}"]`).locator('td').last();
    }

    async assertRegistration(expected: { state?: string; failedAttempts?: number }): Promise<void> {
        await this.openTab('Details');
        await expect(this.registrationWidget).toBeVisible();
        if (expected.state !== undefined) await expect(this.registrationRow('state')).toHaveText(expected.state);
        if (expected.failedAttempts !== undefined) await expect(this.registrationRow('failedAttempts')).toHaveText(String(expected.failedAttempts));
    }

    async assertNoRegistration(): Promise<void> {
        await this.openTab('Details');
        await expect(this.propertiesWidget, 'the detail rendered').toBeVisible();
        await expect(this.registrationWidget).toHaveCount(0);
    }

    /** The Expires row as a Date (the widget formats the ISO date; parsed back). */
    async registrationExpires(): Promise<Date> {
        const text = (await this.registrationRow('expires').innerText()).trim();
        const t = Date.parse(text);
        if (Number.isNaN(t)) throw new Error(`Registration Expires "${text}" is not a date`);
        return new Date(t);
    }

    // ------------------------------------------------------------------ Related Certificates tab (B10)

    /** The row of a related certificate (`tr[data-id=<uuid>]`). */
    relatedRow(uuid: string): Locator {
        return this.main.locator(`tr[data-id="${uuid}"]`);
    }

    /** The Related Certificates tab lists `uuid` as the given role with the relation type badge (`Renewal` / `Rekey`). */
    async assertRelated(certificateUuid: string, expected: { uuid: string; role: 'Successor' | 'Predecessor'; type: 'Renewal' | 'Rekey' | 'Replacement' | 'Pending' }): Promise<void> {
        await this.openDetailTab(certificateUuid, 'Related Certificates');
        const row = this.relatedRow(expected.uuid);
        await expect(row, `related row ${expected.uuid}`).toBeVisible();
        await expect(row).toContainText(expected.role);
        await expect(row).toContainText(expected.type);
    }

    async assertNoRelated(certificateUuid: string, uuid: string): Promise<void> {
        await this.openDetailTab(certificateUuid, 'Related Certificates');
        await expect(this.relatedRow(uuid)).toHaveCount(0);
    }

    // ------------------------------------------------------------------ Approvals tab (B10)

    /** The Approvals tab row of an approval (`tr[data-id=<approval uuid>]`) shows the status badge text. */
    async assertApprovalRow(certificateUuid: string, approvalUuid: string, status: 'Pending' | 'Approved' | 'Rejected' | 'Expired'): Promise<void> {
        await this.openDetailTab(certificateUuid, 'Approvals');
        const row = this.main.locator(`tr[data-id="${approvalUuid}"]`);
        await expect(row, `approval row ${approvalUuid}`).toBeVisible();
        await expect(row).toContainText(status);
    }

    // ------------------------------------------------------------------ Add Certificate form: Pre-register (B1)

    get requestTypeRegister(): Locator {
        return this.main.getByTestId('requestType-register');
    }

    async selectRequestTypeRegister(): Promise<void> {
        logger.info('Selecting Request Type: Pre-register');
        await this.requestTypeRegister.click();
    }

    get challengeInput(): Locator {
        return this.main.getByTestId('authorizationSecret');
    }

    get issuanceWindowInput(): Locator {
        // A type=date TextInput renders a DatePicker that drops data-testid: the input has only id="expiresAt" (disabled until a challenge is typed).
        return this.main.locator('input#expiresAt');
    }

    /** Pre-register hides Key Source and the CSR upload and shows the Challenge and Issuance window fields (PR-11). */
    async assertRegisterFields(): Promise<void> {
        await expect(this.challengeInput).toBeVisible();
        await expect(this.issuanceWindowInput).toBeVisible();
        await expect(this.keySourceTrigger).toHaveCount(0);
        await expect(this.csrTextarea).toHaveCount(0);
    }

    async fillChallenge(secret: string): Promise<void> {
        await fillText(this.challengeInput, secret);
    }

    /** The Request Attributes tab's Common Name field (`__attributes__csrAttributes__.commonName`). */
    get requestCommonName(): Locator {
        return this.main.locator('[id="__attributes__csrAttributes__.commonName"]');
    }

    async fillRequestCommonName(cn: string): Promise<void> {
        const tab = this.main.getByRole('tab', { name: /^Request Attributes/ });
        await expect(tab).toBeVisible();
        await tab.click();
        await expect(this.requestCommonName).toBeVisible();
        await fillText(this.requestCommonName, cn);
    }

    /**
     * Create and return the new certificate's uuid: the redirect to `certificates/detail/<uuid>`, or the "accepted with
     * warnings" panel's Open certificate (the same two outcomes `CertificatePage.submitIssueWithWarnings` handles since
     * the B1 live-run incident fix). The caller records the run's certificates of the CN in a `finally` around this call.
     */
    async submitRegister(): Promise<string> {
        logger.info('Submitting Pre-register');
        await expect(this.submitButton).toBeEnabled();
        return (await this.submitIssueWithWarnings()).uuid;
    }

    /** The SAN widget equals the expected set (helper for the lifecycle rows that re-check the SANs). */
    async assertSanSet(expected: SanSet): Promise<void> {
        const shown = await this.sanValues();
        expect(sameSans(shown, expected), `Details SANs ${JSON.stringify(shown)} = ${JSON.stringify(expected)}`).toBe(true);
    }
}
