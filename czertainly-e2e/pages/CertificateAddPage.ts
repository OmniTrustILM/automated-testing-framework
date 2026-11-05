/**
 * CertificateAddPage — the Add Certificate form: the Pre-register request type and Create (REG-CERT-12, 13).
 * The Issue-now fields are in `CertificatePage`. The issuance window is a DatePicker without a test id, so its input id is used.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CreateAnswer, createAnswerFrom } from './ui/createAnswer';
import { detailUuidIfOn, waitForDetailRoute } from './ui/detailRoute';
import { fillText } from './ui/form';
import { UUID } from './ui/waitForResponse';
import { ADD_FORM_OUTCOME_MS } from '../utils/regression/timeouts';

const logger = new Logger('CertificateAddPage');

/** Step of the poll that waits for the redirect or the warnings panel; the poll's own budget is 15 seconds. */
const POLL_STEP_MS = 100;

export type FormCreate = 'issue' | 'register';

const CREATE_REQUEST: Record<FormCreate, RegExp> = {
    issue: new RegExp(`/raProfiles/${UUID}/certificates$`),
    register: new RegExp(`/raProfiles/${UUID}/certificates/register$`),
};

export class CertificateAddPage {
    readonly page: Page;
    readonly main: Locator;

    // Request type
    readonly requestTypeRegister: Locator;

    // Issue now: Key Source and the CSR upload
    readonly keySourceTrigger: Locator;
    readonly csrTextarea: Locator;

    // Pre-register: Challenge and Issuance window
    readonly challengeInput: Locator;
    /** A DatePicker drops data-testid: the input has only id="expiresAt" (disabled until a challenge is typed). */
    readonly issuanceWindowInput: Locator;

    // Request Attributes tab
    readonly requestAttributesTab: Locator;
    readonly commonNameInput: Locator;

    // Create (the form's ProgressButton)
    readonly submitButton: Locator;

    // After Create: the "Certificate request accepted with warnings" panel
    readonly warningsPanel: Locator;
    readonly openCertificateButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.requestTypeRegister = this.main.getByTestId('requestType-register');

        this.keySourceTrigger = this.main.getByTestId('keySource-trigger');
        this.csrTextarea = this.main.locator('#__fileUpload__fileContent');

        this.challengeInput = this.main.getByTestId('authorizationSecret');
        this.issuanceWindowInput = this.main.locator('input#expiresAt');

        this.requestAttributesTab = this.main.getByRole('tab', { name: /^Request Attributes/ });
        this.commonNameInput = this.main.locator('[id="__attributes__csrAttributes__.commonName"]');

        this.submitButton = this.main.getByTestId('progress-button');

        this.warningsPanel = this.page.getByTestId('compliance-errors-panel');
        this.openCertificateButton = this.page.getByRole('button', { name: 'Open certificate', exact: true });
    }

    async chooseRequestTypeRegister(): Promise<void> {
        logger.info('Selecting Request Type: Pre-register');
        await this.requestTypeRegister.click();
    }

    async assertRegisterFields(): Promise<void> {
        await expect(this.challengeInput).toBeVisible();
        await expect(this.issuanceWindowInput).toBeVisible();
        await expect(this.keySourceTrigger).toHaveCount(0);
        await expect(this.csrTextarea).toHaveCount(0);
    }

    async fillChallenge(secret: string): Promise<void> {
        await fillText(this.challengeInput, secret);
    }

    async fillRequestCommonName(cn: string): Promise<void> {
        await expect(this.requestAttributesTab).toBeVisible();
        await this.requestAttributesTab.click();
        await expect(this.commonNameInput).toBeVisible();
        await fillText(this.commonNameInput, cn);
    }

    /** Clicks Create and returns the answer of the create request. The redirect is not waited for: the spec records the ledger line first. */
    async submitCreate(kind: FormCreate): Promise<CreateAnswer> {
        logger.info(`Submitting ${kind === 'register' ? 'Pre-register' : 'Issue Certificate'}`);
        await expect(this.submitButton).toBeEnabled();
        return createAnswerFrom(this.page, { method: 'POST', path: CREATE_REQUEST[kind] }, () => this.submitButton.click());
    }

    /**
     * Clicks Create and reaches the new certificate's detail page. When the "accepted with warnings" panel shows instead, the
     * call fails, unless `acceptWarnings` is set: then "Open certificate" is clicked and the warnings are returned.
     */
    async submitIssueFailingOnWarnings(options: { acceptWarnings?: boolean } = {}): Promise<{ uuid: string; warnings: string[] }> {
        logger.info('Submitting Issue Certificate');
        await this.submitButton.click();
        return this.waitForCreatedCertificate(options);
    }

    /** Reaches the new certificate's detail page after Create; call it after the ledger line was written. */
    async waitForCreatedCertificate(options: { acceptWarnings?: boolean } = {}): Promise<{ uuid: string; warnings: string[] }> {
        const acceptWarnings = options.acceptWarnings ?? false;
        await expect(async () => {
            if (detailUuidIfOn(this.page, 'certificates')) return;
            await expect(this.openCertificateButton).toBeVisible({ timeout: POLL_STEP_MS });
        }, 'the detail page opens, or the request is accepted with warnings').toPass({ timeout: ADD_FORM_OUTCOME_MS });
        let warnings: string[] = [];
        if (!detailUuidIfOn(this.page, 'certificates')) {
            warnings = (await this.warningsPanel.locator('li').allTextContents()).map((t) => t.trim()).filter(Boolean);
            if (!warnings.length) warnings = [((await this.warningsPanel.textContent()) ?? '').trim()].filter(Boolean);
            if (!acceptWarnings) throw new Error(`the certificate request was accepted with warnings instead of opening the new certificate: ${warnings.join(' | ')}`);
            logger.warn(`Certificate request accepted with warnings: ${warnings.join(' | ')}`);
            await this.openCertificateButton.click();
        }
        const uuid = await waitForDetailRoute(this.page, 'certificates');
        logger.info(`Issued certificate UUID: ${uuid}`);
        return { uuid, warnings };
    }
}
