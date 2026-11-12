import { test } from '@playwright/test';
import { loadEnv } from '../../../utils/env';
import { LoginPage } from '../../../pages/LoginPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { certificate } from '../../../utils/regression/inventory/importFixtures';
import { envFor } from '../../../utils/epicOwnership';

for (const account of ['U', 'R'] as const) {
    test(`DIAG ${account} @epic-364 @diag`, async ({ browser }) => {
        const env = loadEnv();
        const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) console.log(`DIAG ${account} ${r.status()} ${r.request().method()} ${r.url()}`); });
        const login = new LoginPage(page, envFor(env, account));
        await login.goto(); await login.login();
        const certs = new CertificatePage(page);
        await page.goto('/administrator/#/certificates');
        await certs.main.waitFor();
        console.log(`DIAG ${account} header buttons: ${await page.locator('main button, main [data-testid]').evaluateAll((e) => e.map((x) => x.getAttribute('data-testid') || x.textContent?.trim()).filter(Boolean).slice(0, 40).join('|'))}`);
        await certs.openImportModal();
        await certs.importFileContent.fill(certificate(`diag-${account}.example.com`).pem);
        await page.waitForTimeout(3000);
        console.log(`DIAG ${account} dialog: ${(await certs.importModal.innerText()).replace(/\s+/g, ' ').slice(0, 800)}`);
        await context.close();
    });
}
