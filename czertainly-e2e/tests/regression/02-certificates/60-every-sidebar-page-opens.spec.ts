/**
 * REG-CERT-60 — Every sidebar page opens (release checklist: Certificates, navigation). ilm#428, ilm#442.
 *
 * WHAT: In five classes (dashboards, search lists, lists without a search, bare-array lists, settings pages), for each page:
 *       1. Open it through the sidebar (a page already open is reloaded).
 *       2. Its own list or statistics request answers 200 with the expected shape (single object, paged object or bare array).
 *       3. The main content is visible and shows no error text; there are no console errors, page errors, 5xx, unexpected 4xx
 *          or failed requests.
 *       4. At the end: no write left the browser.
 * WHY: a page that does not open, or opens with a 5xx or a console error, is the first thing an operator meets after an
 *      upgrade; this extends the smoke check of the same name with the status codes and the list shapes.
 * HOW: read-only on a shared tier: no PUT, PATCH or DELETE and no POST that is not a list or search request; no row action is
 *      clicked. An entry that a deployment flag or a missing listing hides (Proxies, Trusted Certificates, Crypto Assets) is
 *      recorded as not offered with its reason instead of failing. The only allowed 4xx is the branding probe of an unbranded
 *      tier. Findings are collected softly so one broken page does not hide the others.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { AppShell } from '../../../pages/AppShell';
import { Navigation } from '../../../pages/Navigation';
import { AllowedClientError, BrowserGuards, ListShape, listShapeProblems } from '../../../utils/regression/browserGuards';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { Page, Response } from '@playwright/test';
import { actAndWaitForApi } from '../../../pages/ui/waitForResponse';
import { SWEEP_LIST_REQUEST_MS, SWEEP_SIGN_IN_MS, SWEEP_PAGE_MS } from '../../../utils/regression/timeouts';

interface SweepPage {
    name: string;
    /** Sidebar parent button, absent for a top-level link. */
    parent?: string;
    /** Sidebar link text. */
    link: string;
    /** The route in the URL hash (`#/<route>`), anchored so that `#/secrets` never matches `#/dashboard/secrets`. */
    url: RegExp;
    /** The sidebar entry's test id (`sidebar-<slug>` or `sidebar-<parent>-<last segment>`), used only for optional pages. */
    sidebarId: string;
    /** The request the page sends on first load. */
    list: { method: 'GET' | 'POST'; path: RegExp };
    shape: ListShape;
    /** Named reason this entry may be absent from the sidebar; absent = the page is required. */
    optional?: string;
}

const route = (r: string): RegExp => new RegExp(`#/${r}(?:[?/]|$)`, 'i');
const get = (path: string): SweepPage['list'] => ({ method: 'GET', path: new RegExp(`${path}$`) });
const post = (path: string): SweepPage['list'] => ({ method: 'POST', path: new RegExp(`${path}$`) });

const FLAG_PROXIES = 'the Proxies entry is offered only when the deployment sets ENABLE_PROXIES=true (fe utils/feature-flags.ts)';
const FLAG_TRUSTED = 'the Trusted Certificates entry is offered only when the deployment sets ENABLE_TRUSTED_CERTIFICATES=true (fe utils/feature-flags.ts)';
const LISTING_CRYPTO = 'the Crypto Assets entries are offered only to a user whose profile lists the cryptoAssets listing (the admin UI router)';

const DASHBOARDS: SweepPage[] = [
    { name: 'Dashboard > Certificates', parent: 'Dashboard', link: 'Certificates', url: route('dashboard/certificates'), sidebarId: 'sidebar-dashboard-certificates', list: get('/v1/statistics'), shape: 'single' },
    { name: 'Dashboard > Secrets', parent: 'Dashboard', link: 'Secrets', url: route('dashboard/secrets'), sidebarId: 'sidebar-dashboard-secrets', list: get('/v1/statistics'), shape: 'single' },
    { name: 'Dashboard > Signing Records', parent: 'Dashboard', link: 'Signing Records', url: route('dashboard/signing-records'), sidebarId: 'sidebar-dashboard-signing-records', list: get('/v1/statistics/signingRecords'), shape: 'single' },
    { name: 'Dashboard > Crypto Assets', parent: 'Dashboard', link: 'Crypto Assets', url: route('dashboard/crypto-assets'), sidebarId: 'sidebar-dashboard-crypto-assets', list: get('/v1/statistics/cryptoAssets'), shape: 'single', optional: LISTING_CRYPTO },
];

/** Lists that search: a POST with the search body, a filter catalogue and (for 8 of them) saved views. */
const SEARCH_LISTS: SweepPage[] = [
    { name: 'Certificates', link: 'Certificates', url: route('certificates'), sidebarId: 'sidebar-certificates', list: post('/v1/certificates'), shape: 'paged' },
    { name: 'Keys', link: 'Keys', url: route('keys'), sidebarId: 'sidebar-keys', list: post('/v1/keys'), shape: 'paged' },
    { name: 'Discoveries', link: 'Discoveries', url: route('discoveries'), sidebarId: 'sidebar-discoveries', list: post('/v1/discoveries/list'), shape: 'paged' },
    { name: 'Connectors', link: 'Connectors', url: route('connectors'), sidebarId: 'sidebar-connectors', list: post('/v2/connectors/list'), shape: 'paged' },
    { name: 'Secrets', link: 'Secrets', url: route('secrets'), sidebarId: 'sidebar-secrets', list: post('/v1/secrets'), shape: 'paged' },
    { name: 'CBOMs', link: 'CBOMs', url: route('cboms'), sidebarId: 'sidebar-cboms', list: post('/v1/cboms'), shape: 'paged' },
    { name: 'Crypto Assets', link: 'Crypto Assets', url: route('cryptoassets'), sidebarId: 'sidebar-cryptoassets', list: post('/v1/cryptoAssets'), shape: 'paged', optional: LISTING_CRYPTO },
    { name: 'Signing Records', link: 'Signing Records', url: route('signingrecords'), sidebarId: 'sidebar-signingrecords', list: post('/v1/signingRecords'), shape: 'paged' },
    { name: 'Profiles > Vault Profiles', parent: 'Profiles', link: 'Vault Profiles', url: route('vaultprofiles'), sidebarId: 'sidebar-profiles-vaultprofiles', list: post('/v1/vaultProfiles/list'), shape: 'paged' },
    { name: 'Profiles > Signing Profiles', parent: 'Profiles', link: 'Signing Profiles', url: route('signingprofiles'), sidebarId: 'sidebar-profiles-signingprofiles', list: post('/v1/signingProfiles/list'), shape: 'paged' },
    { name: 'Inventory > Entities', parent: 'Inventory', link: 'Entities', url: route('entities'), sidebarId: 'sidebar-inventory-entities', list: post('/v1/entities/list'), shape: 'paged' },
    { name: 'Inventory > Locations', parent: 'Inventory', link: 'Locations', url: route('locations'), sidebarId: 'sidebar-inventory-locations', list: post('/v1/locations'), shape: 'paged' },
    { name: 'Inventory > Vaults', parent: 'Inventory', link: 'Vaults', url: route('vaults'), sidebarId: 'sidebar-inventory-vaults', list: post('/v1/vaults/list'), shape: 'paged' },
    { name: 'Protocols > TSP Profiles', parent: 'Protocols', link: 'TSP Profiles', url: route('tspprofiles'), sidebarId: 'sidebar-protocols-tspprofiles', list: post('/v1/tspProfiles/list'), shape: 'paged' },
    { name: 'Settings > Custom OIDs', parent: 'Settings', link: 'Custom OIDs', url: route('custom-oids'), sidebarId: 'sidebar-settings-custom-oids', list: post('/v1/oids/list'), shape: 'paged' },
    { name: 'Settings > Time Quality', parent: 'Settings', link: 'Time Quality', url: route('timequalityconfigurations'), sidebarId: 'sidebar-settings-timequalityconfigurations', list: post('/v1/timeQualityConfigurations/list'), shape: 'paged' },
    { name: 'Audit Logs', link: 'Audit Logs', url: route('auditlogs'), sidebarId: 'sidebar-auditlogs', list: post('/v1/auditLogs'), shape: 'paged' },
];

/** Lists that page without a search: a GET with `itemsPerPage` / `pageNumber`. */
const PAGED_LISTS: SweepPage[] = [
    { name: 'Profiles > Notification Profiles', parent: 'Profiles', link: 'Notification Profiles', url: route('notificationprofiles'), sidebarId: 'sidebar-profiles-notificationprofiles', list: get('/v1/notificationProfiles'), shape: 'paged' },
    { name: 'Approvals > Approval Profiles', parent: 'Approvals', link: 'Approval Profiles', url: route('approvalprofiles'), sidebarId: 'sidebar-approvals-approvalprofiles', list: get('/v1/approvalProfiles'), shape: 'paged' },
    { name: 'Approvals > Approval List', parent: 'Approvals', link: 'Approval List', url: route('approvals'), sidebarId: 'sidebar-approvals-approvals', list: get('/v1/approvals/user'), shape: 'paged' },
    { name: 'Scheduler', link: 'Scheduler', url: route('jobs'), sidebarId: 'sidebar-jobs', list: get('/v1/scheduler/jobs'), shape: 'paged' },
];

/** Lists the API answers as a bare array. */
const BARE_LISTS: SweepPage[] = [
    { name: 'Proxies', link: 'Proxies', url: route('proxies'), sidebarId: 'sidebar-proxies', list: get('/v1/proxies'), shape: 'bare', optional: FLAG_PROXIES },
    { name: 'Access Control > Users', parent: 'Access Control', link: 'Users', url: route('users'), sidebarId: 'sidebar-access-control-users', list: get('/v1/users'), shape: 'bare' },
    { name: 'Access Control > Roles', parent: 'Access Control', link: 'Roles', url: route('roles'), sidebarId: 'sidebar-access-control-roles', list: get('/v1/roles'), shape: 'bare' },
    { name: 'Profiles > RA Profiles', parent: 'Profiles', link: 'RA Profiles', url: route('raprofiles'), sidebarId: 'sidebar-profiles-raprofiles', list: get('/v1/raProfiles'), shape: 'bare' },
    { name: 'Profiles > Token Profiles', parent: 'Profiles', link: 'Token Profiles', url: route('tokenprofiles'), sidebarId: 'sidebar-profiles-tokenprofiles', list: get('/v1/tokenProfiles'), shape: 'bare' },
    { name: 'Profiles > Compliance Profiles', parent: 'Profiles', link: 'Compliance Profiles', url: route('complianceprofiles'), sidebarId: 'sidebar-profiles-complianceprofiles', list: get('/v2/complianceProfiles'), shape: 'bare' },
    { name: 'Inventory > Credentials', parent: 'Inventory', link: 'Credentials', url: route('credentials'), sidebarId: 'sidebar-inventory-credentials', list: get('/v1/credentials'), shape: 'bare' },
    { name: 'Inventory > Authorities', parent: 'Inventory', link: 'Authorities', url: route('authorities'), sidebarId: 'sidebar-inventory-authorities', list: get('/v1/authorities'), shape: 'bare' },
    { name: 'Inventory > Tokens', parent: 'Inventory', link: 'Tokens', url: route('tokens'), sidebarId: 'sidebar-inventory-tokens', list: get('/v1/tokens'), shape: 'bare' },
    { name: 'Inventory > Groups', parent: 'Inventory', link: 'Groups', url: route('groups'), sidebarId: 'sidebar-inventory-groups', list: get('/v1/groups'), shape: 'bare' },
    { name: 'Protocols > ACME Accounts', parent: 'Protocols', link: 'ACME Accounts', url: route('acmeaccounts'), sidebarId: 'sidebar-protocols-acmeaccounts', list: get('/v1/acmeAccounts'), shape: 'bare' },
    { name: 'Protocols > ACME Profiles', parent: 'Protocols', link: 'ACME Profiles', url: route('acmeprofiles'), sidebarId: 'sidebar-protocols-acmeprofiles', list: get('/v1/acmeProfiles'), shape: 'bare' },
    { name: 'Protocols > CMP Profiles', parent: 'Protocols', link: 'CMP Profiles', url: route('cmpprofiles'), sidebarId: 'sidebar-protocols-cmpprofiles', list: get('/v1/cmpProfiles'), shape: 'bare' },
    { name: 'Protocols > SCEP Profiles', parent: 'Protocols', link: 'SCEP Profiles', url: route('scepprofiles'), sidebarId: 'sidebar-protocols-scepprofiles', list: get('/v1/scepProfiles'), shape: 'bare' },
    { name: 'Settings > Custom Attributes', parent: 'Settings', link: 'Custom Attributes', url: route('customattributes'), sidebarId: 'sidebar-settings-customattributes', list: get('/v1/attributes/custom'), shape: 'bare' },
    { name: 'Settings > Global Metadata', parent: 'Settings', link: 'Global Metadata', url: route('globalmetadata'), sidebarId: 'sidebar-settings-globalmetadata', list: get('/v1/attributes/metadata'), shape: 'bare' },
    { name: 'Settings > Trusted Certificates', parent: 'Settings', link: 'Trusted Certificates', url: route('trustedcertificates'), sidebarId: 'sidebar-settings-trustedcertificates', list: get('/v1/trustedCertificates'), shape: 'bare', optional: FLAG_TRUSTED },
    { name: 'Workflows > Rules', parent: 'Workflows', link: 'Rules', url: route('rules'), sidebarId: 'sidebar-workflows-rules', list: get('/v1/workflows/rules'), shape: 'bare' },
    { name: 'Workflows > Actions', parent: 'Workflows', link: 'Actions', url: route('actions'), sidebarId: 'sidebar-workflows-actions', list: get('/v1/workflows/actions'), shape: 'bare' },
    { name: 'Workflows > Triggers', parent: 'Workflows', link: 'Triggers', url: route('triggers'), sidebarId: 'sidebar-workflows-triggers', list: get('/v1/workflows/triggers'), shape: 'bare' },
];

/** Settings pages: one object. (Events lists the notification instances, a bare array, on its first tab.) */
const SETTINGS: SweepPage[] = [
    { name: 'Settings > Platform', parent: 'Settings', link: 'Platform', url: route('settings'), sidebarId: 'sidebar-settings-settings', list: get('/v1/settings/platform'), shape: 'single' },
    { name: 'Settings > Events', parent: 'Settings', link: 'Events', url: route('events'), sidebarId: 'sidebar-settings-events', list: get('/v1/notificationInstances'), shape: 'bare' },
    { name: 'Settings > Logging', parent: 'Settings', link: 'Logging', url: route('loggingsettings'), sidebarId: 'sidebar-settings-loggingsettings', list: get('/v1/settings/logging'), shape: 'single' },
    { name: 'Settings > Authentication', parent: 'Settings', link: 'Authentication', url: route('authenticationsettings'), sidebarId: 'sidebar-settings-authenticationsettings', list: get('/v1/settings/authentication'), shape: 'single' },
];

const CLASSES: Array<{ id: string; behaviour: string; pages: SweepPage[] }> = [
    { id: 'dashboards', behaviour: 'dashboards answer their statistics', pages: DASHBOARDS },
    { id: 'search-lists', behaviour: 'search lists answer a paged object', pages: SEARCH_LISTS },
    { id: 'paged-lists', behaviour: 'lists without a search answer a paged object', pages: PAGED_LISTS },
    { id: 'bare-lists', behaviour: 'lists answer a bare array', pages: BARE_LISTS },
    { id: 'settings', behaviour: 'settings pages answer their object', pages: SETTINGS },
];

/** 4xx a sidebar page is known to cause today, each with its filed bug: EMPTY: no sidebar page causes a 4xx today. */
const KNOWN_4XX: AllowedClientError[] = [];

/** 4xx the shell provokes by design: the FE contract that makes the status the oracle is the `expected` text. */
const SHELL_EXPECTED_4XX: AllowedClientError[] = [
    { method: 'GET', path: /\/v1\/branding$/, status: 404, expected: 'an unbranded tier answers 404: "no branding", silent by design (the FE branding module)', reason: 'the theme provider asks for the branding on every full page load' },
];

/** The POST requests the sweep's pages send that only read: their own list requests and the search / saved-view calls. */
const READ_POSTS: RegExp[] = [
    ...new Set([...DASHBOARDS, ...SEARCH_LISTS, ...PAGED_LISTS, ...BARE_LISTS, ...SETTINGS].filter((p) => p.list.method === 'POST').map((p) => p.list.path.source)),
].map((src) => new RegExp(src));

const RULE = 'ilm#428 step 1 (every page loads with no error), ilm#442 steps 5-6 (per-page API status codes, console errors); the smoke navigation check is extended with status codes and list shapes, not replaced';

/** Opens one page through the sidebar and answers the response of its list request (a page already open is reloaded). */
async function openPage(page: Page, nav: Navigation, p: SweepPage): Promise<Response> {
    return actAndWaitForApi(page, { method: p.list.method, path: p.list.path, timeout: SWEEP_LIST_REQUEST_MS }, () => (p.url.test(page.url()) ? page.reload() : nav.openViaSidebar(p.link, p.url, p.parent)));
}

test.describe('page sweep', { tag: tags.regression }, () => {
    for (const c of CLASSES) {
        test(`${c.behaviour} and every page opens once`,
            testMeta({ id: 'REG-CERT-60', row: c.id, prio: 'P2', issue: ['ilm#428', 'ilm#442'], rule: RULE }),
            async ({ signedIn: page }, testInfo) => {
                const budgetMs = SWEEP_SIGN_IN_MS + c.pages.length * SWEEP_PAGE_MS; // the sign-in plus up to 30 s per page
                test.setTimeout(budgetMs);
                const guards = new BrowserGuards(page, { allow: [...SHELL_EXPECTED_4XX, ...KNOWN_4XX], readPosts: READ_POSTS });
                const nav = new Navigation(page);
                const shell = new AppShell(page);

                // The `signedIn` fixture did the sign-in; the guards start after it (the identity provider's pages are not the sweep's).
                guards.start();

                for (const p of c.pages) {
                    await test.step(p.name, async () => {
                        guards.mark(p.name);
                        if (p.optional && !(await shell.offersSidebarEntry(p.sidebarId))) {
                            testInfo.annotations.push({ type: 'page-not-offered', description: `${p.name}: ${p.optional}` });
                            return;
                        }
                        let response: Response | undefined;
                        try {
                            response = await openPage(page, nav, p);
                            await expect(shell.main, `${p.name}: main content`).toBeVisible();
                            await guards.settle();
                            await guards.scanText(shell.main);
                        } catch (e) {
                            expect.soft(String(e instanceof Error ? e.message.split('\n')[0] : e), `${p.name} did not open and answer its list request`).toBe('');
                        }
                        if (response) {
                            expect.soft(response.status(), `${p.name}: ${p.list.method} ${new URL(response.url()).pathname}`).toBe(200);
                            if (response.status() === 200) {
                                const body = await response.json().catch(() => undefined);
                                expect.soft(listShapeProblems(p.shape, body), `${p.name}: list shape (${p.shape})`).toEqual([]);
                            }
                        }
                        guards.assertZero(p.name, { soft: true });
                    });
                }

                await test.step('Read-only: no write left the page, every allow-list entry stands for something seen or is reported', async () => {
                    expect.soft(guards.all({ counter: 'write' }), 'writes during the sweep').toEqual([]);
                    guards.dispose();
                });
            });
    }
});
