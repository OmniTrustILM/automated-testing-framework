import { Locator, Page, expect } from '@playwright/test';
import { TestEnv } from '../utils/env';
import { Logger } from '../utils/Logger';

const logger = new Logger('LoginPage');

/** An identity-provider account (the admin test user, or the dedicated second identity DED). */
export interface Credentials {
  username: string;
  password: string;
}

export class LoginPage {
  constructor(private readonly page: Page, private readonly env: TestEnv) { }

  async goto(): Promise<void> {
    await this.page.goto(new URL('administrator/', this.env.baseUrl).toString());
  }

  async login(credentials?: Credentials): Promise<void> {
    if (this.env.authMode === 'local') {
      await this.loginLocal(credentials ?? this.env);
    } else if (this.env.authMode === 'header') {
      // Local stack: the dev proxy authenticates every request with the client-certificate header.
      await expect(this.page.getByTestId('sidebar-sticky')).toBeVisible({ timeout: 30_000 });
    } else {
      // await this.loginOidc();
    }
  }

  /**
   * The session cookie core sets after a sign-in (`session-id`, core CookieConfig), or undefined. API-GEN-32's session
   * sentinel compares it before and after a reload; the value is never logged.
   */
  async sessionCookie(): Promise<string | undefined> {
    const cookies = await this.page.context().cookies();
    return cookies.find((c) => c.name === LoginPage.SESSION_COOKIE)?.value;
  }

  static readonly SESSION_COOKIE = 'session-id';

  /**
   * Reload the current page and wait for the signed-in marker (the sidebar) again: a session that does not survive the
   * reload lands on the login form instead (migration risk of core bb20aaba: "sign-in lost on the next request").
   */
  async reloadKeepingSession(): Promise<void> {
    logger.info('Reloading; the session must survive');
    await this.page.reload();
    await expect(this.page.getByTestId('sidebar-sticky'), 'signed in after the reload').toBeVisible({ timeout: 30_000 });
  }

  /** The header's user menu shows the signed-in username (phase-04 D2: the trigger text is the username). */
  async assertSignedInAs(username: string): Promise<void> {
    await expect(this.page.getByTestId('header'), `signed in as ${username}`).toContainText(username);
    await expect(this.page.getByRole('textbox', { name: 'Password' }), 'no login form').toHaveCount(0);
  }

  /**
   * Sign in as another identity (auth-rbac area, B2: REG-AUTH-07 / 08 / 10 sign in as DED). The browser context must be
   * the identity's own, so a stored session of another user cannot answer. Never a wrong-password path: a wrong password
   * tests the identity provider, not ILM, and could lock the shared account.
   */
  async loginAs(credentials: Credentials): Promise<void> {
    await this.goto();
    await this.login(credentials);
  }

  /** The header's user menu: the trigger's text is the signed-in username (phase-04 D2); items `Profile` and `Log out`. */
  private userMenuTrigger(username: string): Locator {
    return this.page.getByTestId('header').getByRole('button', { name: username });
  }

  async openUserMenu(username: string): Promise<void> {
    await this.userMenuTrigger(username).click();
    await expect(this.page.getByRole('menuitem', { name: 'Log out', exact: true }), 'the user menu offers Log out').toBeVisible();
  }

  /** User menu → Log out: the page leaves the app for the provider's end-session and lands on a sign-in screen. */
  async logOut(username: string): Promise<void> {
    await this.openUserMenu(username);
    await this.page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await this.assertLoggedOut();
  }

  /** Signed out: no app shell, and the sign-in page (provider choice) or the provider's credential form is shown. */
  async assertLoggedOut(timeout = 30_000): Promise<void> {
    const loginPage = this.page.getByTestId('login-page');
    const credentialForm = this.page.getByRole('textbox', { name: 'Username' });
    await expect(loginPage.or(credentialForm).first(), 'the sign-in screen is shown').toBeVisible({ timeout });
    await expect(this.page.getByTestId('sidebar-sticky'), 'no authenticated shell').toHaveCount(0);
  }

  /**
   * Open the app again and expect a CREDENTIAL prompt, not a silent sign-in: after a sign-out the identity provider's own
   * session must be gone too (ilm#426 step 4), so the provider asks for credentials. Stops at the prompt.
   */
  async assertCredentialPromptAfterOpen(timeout = 30_000): Promise<void> {
    await this.goto();
    const credentialForm = this.page.getByRole('textbox', { name: 'Username' });
    const providerChoice = this.page.getByRole('button', { name: this.env.localAuthProviderName ?? 'Internal', exact: true });
    await expect(credentialForm.or(providerChoice).or(this.page.getByTestId('sidebar-sticky')).first()).toBeVisible({ timeout });
    if (await providerChoice.isVisible().catch(() => false)) await providerChoice.click();
    await expect(credentialForm, 'the provider asks for credentials (no silent single sign-on)').toBeVisible({ timeout });
    await expect(this.page.getByTestId('sidebar-sticky')).toHaveCount(0);
  }

  private async loginLocal(credentials: Credentials): Promise<void> {
    const usernameInput = this.page.getByRole('textbox', { name: 'Username' });
    const passwordInput = this.page.getByRole('textbox', { name: 'Password' });
    const submitBtn = this.page.getByRole('button', { name: /sign in/i });

    try {
      await usernameInput.waitFor({ state: 'visible', timeout: 2000 });
      logger.info('Login form visible immediately. Skipping provider selection.');
    } catch {
      const providerName = this.env.localAuthProviderName ?? 'Internal';
      // Scope by role + exact name — partial text match collides on envs with
      // multiple "Internal*" identity providers (e.g. Internal, Internal2, Internal-userinfo).
      const providerBtn = this.page.getByRole('button', { name: providerName, exact: true });

      logger.info(`Login form not visible. Expecting provider selection: "${providerName}"`);
      await expect(providerBtn, `Provider "${providerName}" button should be visible`).toBeVisible();
      await providerBtn.click();

      await expect(usernameInput).toBeVisible();
    }

    await usernameInput.fill(credentials.username);
    await passwordInput.fill(credentials.password);
    await submitBtn.click();

    await expect(this.page.getByTestId('sidebar-sticky')).toBeVisible();
  }
}