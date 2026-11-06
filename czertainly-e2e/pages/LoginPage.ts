/**
 * LoginPage — the sign-in screen and the session (API-GEN-32).
 * It never tries a wrong password, which could lock the shared account. The cookie value is never logged.
 */
import { Locator, Page, expect } from '@playwright/test';
import { TestEnv } from '../utils/env';
import { Logger } from '../utils/Logger';
import { SHELL_VISIBLE_MS, LOGIN_FORM_PROBE_MS } from '../utils/regression/timeouts';

const logger = new Logger('LoginPage');

export interface SessionCookie {
    value: string;
    path: string;
}

export class LoginPage {
    static readonly SESSION_COOKIE = 'session-id';

    // Sign-in: the provider choice, then the provider's credential form
    readonly providerChoice: Locator;
    readonly usernameInput: Locator;
    readonly passwordInput: Locator;
    readonly signInButton: Locator;

    // The app after the sign-in
    readonly shell: Locator;
    readonly userMenuHeader: Locator;

    constructor(private readonly page: Page, private readonly env: TestEnv) {
        // Scope by role + exact name: a partial text match collides on tiers with several "Internal*" providers.
        this.providerChoice = page.getByRole('button', { name: env.localAuthProviderName ?? 'Internal', exact: true });
        this.usernameInput = page.getByRole('textbox', { name: 'Username' });
        this.passwordInput = page.getByRole('textbox', { name: 'Password' });
        this.signInButton = page.getByRole('button', { name: /sign in/i });

        this.shell = page.getByTestId('sidebar-sticky');
        this.userMenuHeader = page.getByTestId('header');
    }

    async goto(): Promise<void> {
        await this.page.goto(new URL('administrator/', this.env.baseUrl).toString());
    }

    async login(): Promise<void> {
        if (this.env.authMode === 'local') {
            await this.loginLocal();
        } else if (this.env.authMode === 'header') {
            await expect(this.shell).toBeVisible({ timeout: SHELL_VISIBLE_MS });
        }
    }

    static async readSessionCookie(page: Page): Promise<SessionCookie | undefined> {
        const cookie = (await page.context().cookies()).find((c) => c.name === LoginPage.SESSION_COOKIE);
        return cookie ? { value: cookie.value, path: cookie.path } : undefined;
    }

    async sessionCookie(): Promise<string | undefined> {
        return (await LoginPage.readSessionCookie(this.page))?.value;
    }

    /** A session that does not survive the reload lands on the login form instead. */
    async reloadKeepingSession(): Promise<void> {
        logger.info('Reloading; the session must survive');
        await this.page.reload();
        await expect(this.shell, 'signed in after the reload').toBeVisible({ timeout: SHELL_VISIBLE_MS });
    }

    async assertSignedInAs(username: string): Promise<void> {
        await expect(this.userMenuHeader, `signed in as ${username}`).toContainText(username);
        await expect(this.passwordInput, 'no login form').toHaveCount(0);
    }

    private async loginLocal(): Promise<void> {
        try {
            await this.usernameInput.waitFor({ state: 'visible', timeout: LOGIN_FORM_PROBE_MS });
            logger.info('Login form visible immediately. Skipping provider selection.');
        } catch {
            logger.info('Login form not visible. Expecting provider selection.');
            await expect(this.providerChoice, 'the provider button is shown').toBeVisible();
            await this.providerChoice.click();
            await expect(this.usernameInput).toBeVisible();
        }

        await this.usernameInput.fill(this.env.username);
        await this.passwordInput.fill(this.env.password);
        await this.signInButton.click();

        await expect(this.shell).toBeVisible();
    }
}
