/**
 * CertificateAddPage — the Add Certificate form.
 *
 * WHAT: the Add Certificate form on its own route: the Pre-register request type with Challenge and Issuance
 *       window, the Request Attributes common name, and Create with its two successful outcomes (redirect, or the
 *       "accepted with warnings" panel).
 * WHY: REG-CERT-12 / 13 pre-register in the form; REG-USE-04 and REG-CERT-16 need the warnings outcome. The
 *       Issue-now fields stay on the smoke facade `CertificatePage`.
 * HOW: test ids of the form; the issuance window is a DatePicker without a test id (its input id is used, FE
 *       test-id request); the new certificate's uuid is read from the detail route.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { CreateAnswer, createAnswerFrom } from './ui/createAnswer';
import { detailUuidIfOn, waitForDetailRoute } from './ui/detailRoute';
import { fillText } from './ui/form';
import { UUID } from './ui/waitForResponse';
import { ADD_FORM_OUTCOME_MS } from '../utils/regression/timeouts';

const logger = new Logger('CertificateAddPage');

/**
 * One step of the poll that waits for the redirect or the warnings panel: the poll's own 15 seconds are the budget, this is only its look.
 */
const POLL_STEP_MS = 100;

/** The two creates of the form: Issue now and Pre-register. */
export type FormCreate = 'issue' | 'register';

/** The v2 operations request each create sends (`…/raProfiles/{id}/certificates`, and `…/certificates/register`). */
const CREATE_REQUEST: Record<FormCreate, RegExp> = {
    issue: new RegExp(`/raProfiles/${UUID}/certificates$`),
    register: new RegExp(`/raProfiles/${UUID}/certificates/register$`),
};

export class CertificateAddPage {
    readonly page: Page;
    readonly main: Locator;
    readonly requestTypeRegister: Locator;
    readonly keySourceTrigger: Locator;
    readonly csrTextarea: Locator;
    /** Create (the form's ProgressButton). */
    readonly submitButton: Locator;
    readonly challengeInput: Locator;
    /**
     * A type=date TextInput renders a DatePicker that drops data-testid: the input has only id="expiresAt" (disabled until a challenge is
     * typed).
     */
    readonly issuanceWindowInput: Locator;
    /** The Request Attributes tab's Common Name field (`__attributes__csrAttributes__.commonName`). */
    readonly requestCommonName: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.requestTypeRegister = this.main.getByTestId('requestType-register');
        this.keySourceTrigger = this.main.getByTestId('keySource-trigger');
        this.csrTextarea = this.main.locator('#__fileUpload__fileContent');
        this.submitButton = this.main.getByTestId('progress-button');
        this.challengeInput = this.main.getByTestId('authorizationSecret');
        this.issuanceWindowInput = this.main.locator('input#expiresAt');
        this.requestCommonName = this.main.locator('[id="__attributes__csrAttributes__.commonName"]');
    }

    async chooseRequestTypeRegister(): Promise<void> {
        logger.info('Selecting Request Type: Pre-register');
        await this.requestTypeRegister.click();
    }

    /** Pre-register hides Key Source and the CSR upload and shows the Challenge and Issuance window fields. */
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
        const tab = this.main.getByRole('tab', { name: /^Request Attributes/ });
        await expect(tab).toBeVisible();
        await tab.click();
        await expect(this.requestCommonName).toBeVisible();
        await fillText(this.requestCommonName, cn);
    }

    /**
     * Clicks Create and returns the answer of the create request (`kind`: Issue now or Pre-register): its status, the new
     * certificate's uuid and the request. The redirect is NOT waited for: the spec records the ledger line from this answer
     * first, then calls `waitForCreatedCertificate`.
     */
    async submitCreate(kind: FormCreate): Promise<CreateAnswer> {
        logger.info(`Submitting ${kind === 'register' ? 'Pre-register' : 'Issue Certificate'}`);
        await expect(this.submitButton).toBeEnabled();
        return createAnswerFrom(this.page, { method: 'POST', path: CREATE_REQUEST[kind] }, () => this.submitButton.click());
    }

    /**
     * Click Create and reach the new certificate's detail page. Two outcomes of a successful issue: the redirect to
     * `/certificates/detail/<uuid>`, or (lenient validation that let the request through) the "Certificate request
     * accepted with warnings" panel (`compliance-errors-panel`) with an "Open certificate" button in place of Create.
     * With `acceptWarnings: true` that button is clicked and the warning messages are returned so the spec can annotate
     * them; by default (the smoke suite's rule) the panel FAILS the call with the warnings in the message. A failed issue
     * stays on the form: the wait below times out.
     */
    async submitIssueFailingOnWarnings(options: { acceptWarnings?: boolean } = {}): Promise<{ uuid: string; warnings: string[] }> {
        logger.info('Submitting Issue Certificate');
        await this.submitButton.click();
        return this.waitForCreatedCertificate(options);
    }

    /**
     * After Create: reaches the new certificate's detail page (see `submitIssueFailingOnWarnings` for the two outcomes). Call it
     * after the ledger line was written from the answer of `submitCreate`.
     */
    async waitForCreatedCertificate(options: { acceptWarnings?: boolean } = {}): Promise<{ uuid: string; warnings: string[] }> {
        const acceptWarnings = options.acceptWarnings ?? false;
        const openCertificate = this.page.getByRole('button', { name: 'Open certificate', exact: true });
        await expect(async () => {
            if (detailUuidIfOn(this.page, 'certificates')) return;
            await expect(openCertificate).toBeVisible({ timeout: POLL_STEP_MS });
        }, 'the detail page opens, or the request is accepted with warnings').toPass({ timeout: ADD_FORM_OUTCOME_MS });
        let warnings: string[] = [];
        if (!detailUuidIfOn(this.page, 'certificates')) {
            const panel = this.page.getByTestId('compliance-errors-panel');
            warnings = (await panel.locator('li').allTextContents()).map((t) => t.trim()).filter(Boolean);
            if (!warnings.length) warnings = [((await panel.textContent()) ?? '').trim()].filter(Boolean);
            if (!acceptWarnings) throw new Error(`the certificate request was accepted with warnings instead of opening the new certificate: ${warnings.join(' | ')}`);
            logger.warn(`Certificate request accepted with warnings: ${warnings.join(' | ')}`);
            await openCertificate.click();
        }
        const uuid = await waitForDetailRoute(this.page, 'certificates');
        logger.info(`Issued certificate UUID: ${uuid}`);
        return { uuid, warnings };
    }
}
