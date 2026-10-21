/**
 * CertificateAddPage — the Add Certificate form (`#/certificates/add`, its own URL): the Pre-register request type with
 * its Challenge, Issuance window and Request Attributes common name, and Create with its two successful outcomes (the
 * redirect to the new certificate, or the "accepted with warnings" panel). The Issue-now fields (RA profile, key
 * source, CSR) stay on CertificatePage, which the smoke suite uses.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { fillText } from './ui/form';

const logger = new Logger('CertificateAddPage');

const DETAIL_URL = /\/certificates\/detail\/[a-f0-9-]+/;

export class CertificateAddPage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    get requestTypeRegister(): Locator {
        return this.main.getByTestId('requestType-register');
    }

    get keySourceTrigger(): Locator {
        return this.main.getByTestId('keySource-trigger');
    }

    get csrTextarea(): Locator {
        return this.main.locator('#__fileUpload__fileContent');
    }

    /** Create (the form's ProgressButton). */
    get submitButton(): Locator {
        return this.main.getByTestId('progress-button');
    }

    async chooseRequestTypeRegister(): Promise<void> {
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
     * Create on the Pre-register form; returns the new certificate's uuid (either outcome of `submitIssueWithWarnings`).
     * The caller records the run's certificates of the common name in a `finally` around this call.
     */
    async submitPreRegistration(): Promise<string> {
        logger.info('Submitting Pre-register');
        await expect(this.submitButton).toBeEnabled();
        return (await this.submitIssueWithWarnings()).uuid;
    }

    /**
     * Click Create and reach the new certificate's detail page. Two outcomes of a successful issue: the redirect to
     * `/certificates/detail/<uuid>`, or (lenient validation that let the request through) the "Certificate request
     * accepted with warnings" panel (`compliance-errors-panel`) with an "Open certificate" button in place of Create;
     * that button is clicked and the warning messages are returned so the spec can annotate them. A failed issue stays
     * on the form: the wait below times out.
     */
    async submitIssueWithWarnings(): Promise<{ uuid: string; warnings: string[] }> {
        logger.info('Submitting Issue Certificate');
        await this.submitButton.click();
        const openCertificate = this.page.getByRole('button', { name: 'Open certificate', exact: true });
        await expect(async () => {
            if (DETAIL_URL.test(this.page.url())) return;
            await expect(openCertificate).toBeVisible({ timeout: 100 });
        }, 'the detail page opens, or the request is accepted with warnings').toPass({ timeout: 15_000 });
        let warnings: string[] = [];
        if (!DETAIL_URL.test(this.page.url())) {
            const panel = this.page.getByTestId('compliance-errors-panel');
            warnings = (await panel.locator('li').allTextContents()).map((t) => t.trim()).filter(Boolean);
            if (!warnings.length) warnings = [((await panel.textContent()) ?? '').trim()].filter(Boolean);
            logger.warn(`Certificate request accepted with warnings: ${warnings.join(' | ')}`);
            await openCertificate.click();
            await expect(this.page).toHaveURL(DETAIL_URL);
        }
        const url = this.page.url();
        const match = url.match(/\/certificates\/detail\/([a-f0-9-]+)/);
        if (!match) throw new Error(`Could not extract certificate UUID from URL: ${url}`);
        logger.info(`Issued certificate UUID: ${match[1]}`);
        return { uuid: match[1], warnings };
    }
}
