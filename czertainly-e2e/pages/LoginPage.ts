/**
 * LoginPage — the sign-in screen, the session and sign-out.
 *
 * WHAT: the sign-in screen (provider choice, credential form), the session cookie, the header's user menu and
 *       sign-out.
 * WHY: every UI test signs in through it; REG-AUTH-01 checks the session across reloads and tabs, REG-AUTH-08 signs
 *       in as the dedicated second identity in its own context, REG-AUTH-99 signs out and expects a credential
 *       prompt (no silent single sign-on).
 * HOW: `signIn` is the admin sign-in of the `signedIn` fixture, for the specs that test the sign-in itself; the form by roles,
 *       the shell by its test id; never a wrong-password attempt (that tests the identity provider and could lock the shared
 *       account); the cookie value is read, never logged.
 */
import { Locator, Page, expect } from '@playwright/test';
import { TestEnv } from '../utils/env';
import { Logger } from '../utils/Logger';
import { SHELL_VISIBLE_MS, LOGIN_FORM_PROBE_MS } from '../utils/regression/timeouts';

const logger = new Logger('LoginPage');

/** An identity-provider account (the admin test user, or the dedicated second identity). */
export interface Credentials {
    username: string;
    password: string;
}

export interface SessionCookie {
    value: string;
    path: string;
}

export class LoginPage {
    /** The session cookie core sets after a sign-in (core CookieConfig). */
    static readonly SESSION_COOKIE = 'session-id';

    /** The signed-in marker: the sidebar. */
    readonly shell: Locator;
    readonly credentialForm: Locator;
    readonly passwordInput: Locator;
    readonly signInPage: Locator;
    readonly userMenuHeader: Locator;
    readonly logOutItem: Locator;
    /** The identity provider's button on the provider choice. */
    readonly providerChoice: Locator;

    constructor(private readonly page: Page, private readonly env: TestEnv) {
        this.shell = page.getByTestId('sidebar-sticky');
        this.credentialForm = page.getByRole('textbox', { name: 'Username' });
        this.passwordInput = page.getByRole('textbox', { name: 'Password' });
        this.signInPage = page.getByTestId('login-page');
        this.userMenuHeader = page.getByTestId('header');
        this.logOutItem = page.getByRole('menuitem', { name: 'Log out', exact: true });
        // Scope by role + exact name: a partial text match collides on tiers with several "Internal*" providers.
        this.providerChoice = page.getByRole('button', { name: env.localAuthProviderName ?? 'Internal', exact: true });
    }

    async goto(): Promise<void> {
        await this.page.goto(new URL('administrator/', this.env.baseUrl).toString());
    }

    /**
     * Opens the app and signs in as the suite's admin test user (the sign-in the `signedIn` fixture does; for the specs that test
     * the sign-in itself).
     */
    async signIn(): Promise<void> {
        await this.goto();
        await this.login();
    }

    async login(credentials?: Credentials): Promise<void> {
        if (this.env.authMode === 'local') {
            await this.loginLocal(credentials ?? this.env);
        } else if (this.env.authMode === 'header') {
            // Local stack: the dev proxy authenticates every request with the client-certificate header.
            await expect(this.shell).toBeVisible({ timeout: SHELL_VISIBLE_MS });
        }
    }

    /** A page's session cookie (value and path), or undefined (no sign-in, or signed out). Never logged. */
    static async readSessionCookie(page: Page): Promise<SessionCookie | undefined> {
        const cookie = (await page.context().cookies()).find((c) => c.name === LoginPage.SESSION_COOKIE);
        return cookie ? { value: cookie.value, path: cookie.path } : undefined;
    }

    /** The value of the session cookie, or undefined; the migration sentinel compares it before and after a reload. */
    async sessionCookie(): Promise<string | undefined> {
        return (await LoginPage.readSessionCookie(this.page))?.value;
    }

    /**
     * Reload the current page and wait for the signed-in marker (the sidebar) again: a session that does not survive the
     * reload lands on the login form instead (a migration risk: "sign-in lost on the next request").
     */
    async reloadKeepingSession(): Promise<void> {
        logger.info('Reloading; the session must survive');
        await this.page.reload();
        await expect(this.shell, 'signed in after the reload').toBeVisible({ timeout: SHELL_VISIBLE_MS });
    }

    /** The header's user menu shows the signed-in username (the trigger text is the username). */
    async assertSignedInAs(username: string): Promise<void> {
        await expect(this.userMenuHeader, `signed in as ${username}`).toContainText(username);
        await expect(this.passwordInput, 'no login form').toHaveCount(0);
    }

    /**
     * Sign in as another identity (the restricted-user rows). The browser context must be the identity's own, so a stored
     * session of another user cannot answer. Never a wrong-password path: a wrong password tests the identity provider, not
     * ILM, and could lock the shared account.
     */
    async loginAs(credentials: Credentials): Promise<void> {
        await this.goto();
        await this.login(credentials);
    }

    /** The header's user menu: the trigger's text is the signed-in username; items `Profile` and `Log out`. */
    private userMenuTrigger(username: string): Locator {
        return this.userMenuHeader.getByRole('button', { name: username });
    }

    async openUserMenu(username: string): Promise<void> {
        await this.userMenuTrigger(username).click();
        await expect(this.logOutItem, 'the user menu offers Log out').toBeVisible();
    }

    /** User menu → Log out: the page leaves the app for the provider's end-session and lands on a sign-in screen. */
    async logOut(username: string): Promise<void> {
        await this.openUserMenu(username);
        await this.logOutItem.click();
        await this.assertLoggedOut();
    }

    /** Signed out: no app shell, and the sign-in page (provider choice) or the provider's credential form is shown. */
    async assertLoggedOut(timeout = SHELL_VISIBLE_MS): Promise<void> {
        await expect(this.signInPage.or(this.credentialForm).first(), 'the sign-in screen is shown').toBeVisible({ timeout });
        await expect(this.shell, 'no authenticated shell').toHaveCount(0);
    }

    /**
     * Opens the app again after a sign-out and takes the provider choice when it is offered, so that the next screen is the
     * provider's credential form. Stops there: `assertCredentialPrompt` judges what came up.
     */
    async goToAppForCredentials(timeout = SHELL_VISIBLE_MS): Promise<void> {
        await this.goto();
        await expect(this.credentialForm.or(this.providerChoice).or(this.shell).first()).toBeVisible({ timeout });
        if (await this.providerChoice.isVisible()) await this.providerChoice.click();
    }

    /**
     * The provider asks for credentials and the app shell is not shown: after a sign-out the identity provider's own session
     * must be gone too, so there is no silent single sign-on.
     */
    async assertCredentialPrompt(timeout = SHELL_VISIBLE_MS): Promise<void> {
        await expect(this.credentialForm, 'the provider asks for credentials (no silent single sign-on)').toBeVisible({ timeout });
        await expect(this.shell).toHaveCount(0);
    }

    private async loginLocal(credentials: Credentials): Promise<void> {
        const submitBtn = this.page.getByRole('button', { name: /sign in/i });

        try {
            await this.credentialForm.waitFor({ state: 'visible', timeout: LOGIN_FORM_PROBE_MS });
            logger.info('Login form visible immediately. Skipping provider selection.');
        } catch {
            logger.info('Login form not visible. Expecting provider selection.');
            await expect(this.providerChoice, 'the provider button is shown').toBeVisible();
            await this.providerChoice.click();
            await expect(this.credentialForm).toBeVisible();
        }

        await this.credentialForm.fill(credentials.username);
        await this.passwordInput.fill(credentials.password);
        await submitBtn.click();

        await expect(this.shell).toBeVisible();
    }
}
