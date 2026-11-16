/**
 * LoginPage — the sign-in screen and the session (API-GEN-32).
 * It never tries a wrong password, which could lock the shared account. The cookie value is never logged.
 */
import { Locator, Page, expect } from '@playwright/test';
import { TestEnv } from '../utils/env';
import { Logger } from '../utils/Logger';
import { SHELL_VISIBLE_MS, LOGIN_FORM_PROBE_MS } from '../utils/regression/timeouts';

const logger = new Logger('LoginPage');

export interface Credentials {
    username: string;
    password: string;
}

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
    readonly signInPage: Locator;

    // The app after the sign-in
    readonly shell: Locator;
    readonly userMenuHeader: Locator;
    readonly logOutItem: Locator;

    constructor(private readonly page: Page, private readonly env: TestEnv) {
        // Scope by role + exact name: a partial text match collides on tiers with several "Internal*" providers.
        this.providerChoice = page.getByRole('button', { name: env.localAuthProviderName ?? 'Internal', exact: true });
        this.usernameInput = page.getByRole('textbox', { name: 'Username' });
        this.passwordInput = page.getByRole('textbox', { name: 'Password' });
        this.signInButton = page.getByRole('button', { name: /sign in/i });
        this.signInPage = page.getByTestId('login-page');

        this.shell = page.getByTestId('sidebar-sticky');
        this.userMenuHeader = page.getByTestId('header');
        this.logOutItem = page.getByRole('menuitem', { name: 'Log out', exact: true });
    }

    /** The header's user menu: its trigger text is the signed-in username. */
    userMenuTrigger(username: string): Locator {
        return this.userMenuHeader.getByRole('button', { name: username });
    }

    async goto(): Promise<void> {
        await this.page.goto(new URL('administrator/', this.env.baseUrl).toString());
    }

    /** Without `credentials` signs in as the suite's admin test user. */
    async login(credentials?: Credentials): Promise<void> {
        if (this.env.authMode === 'local') {
            await this.loginLocal(credentials ?? this.env);
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

    async assertNoLoginForm(): Promise<void> {
        await expect(this.passwordInput, 'no login form').toHaveCount(0);
        await expect(this.signInPage, 'no sign-in page').toHaveCount(0);
    }

    /** User menu → Log out: the provider's end-session, then a sign-in screen. */
    async logOut(username: string): Promise<void> {
        await this.userMenuTrigger(username).click();
        await expect(this.logOutItem, 'the user menu offers Log out').toBeVisible();
        await this.logOutItem.click();
        await this.assertLoggedOut();
    }

    async assertLoggedOut(): Promise<void> {
        await expect(this.signInPage.or(this.usernameInput).first(), 'the sign-in screen is shown')
            .toBeVisible({ timeout: SHELL_VISIBLE_MS });
        await expect(this.shell, 'no authenticated shell').toHaveCount(0);
    }

    /** Opens the app after a sign-out and takes the provider choice when offered; `assertCredentialPrompt` judges what came up. */
    async goToAppForCredentials(): Promise<void> {
        await this.goto();
        await expect(this.usernameInput.or(this.providerChoice).or(this.shell).first()).toBeVisible({ timeout: SHELL_VISIBLE_MS });
        if (await this.providerChoice.isVisible()) await this.providerChoice.click();
    }

    /** After a sign-out the provider's own session must be gone too: no silent single sign-on. */
    async assertCredentialPrompt(): Promise<void> {
        await expect(this.usernameInput, 'the provider asks for credentials (no silent single sign-on)')
            .toBeVisible({ timeout: SHELL_VISIBLE_MS });
        await expect(this.shell).toHaveCount(0);
    }

    private async loginLocal(credentials: Credentials): Promise<void> {
        try {
            await this.usernameInput.waitFor({ state: 'visible', timeout: LOGIN_FORM_PROBE_MS });
            logger.info('Login form visible immediately. Skipping provider selection.');
        } catch {
            logger.info('Login form not visible. Expecting provider selection.');
            await expect(this.providerChoice, 'the provider button is shown').toBeVisible();
            await this.providerChoice.click();
            await expect(this.usernameInput).toBeVisible();
        }

        await this.usernameInput.fill(credentials.username);
        await this.passwordInput.fill(credentials.password);
        await this.signInButton.click();

        await expect(this.shell).toBeVisible();
    }
}
