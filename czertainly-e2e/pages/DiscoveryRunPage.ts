/**
 * DiscoveryRunPage — the discovery detail page of a RUN (status, progress, controls, results, messages) and the v1 create form
 * with the port field; the events-area companion of `DiscoveryPage` (which keeps SMK-003's v1 create without ports and its
 * two-row result check). Phase 5 lists these methods as an UPDATE of `DiscoveryPage`; they are a separate class here because
 * the area agents may not edit an existing file (the merge step may fold them).
 *
 * Hooks (fe-administrator `_pages/discoveries`, read in the source): the list is `#/discoveries`, the create form the dialog
 * "Create Discovery" (v1: `text-input-name`, `select-discoveryProviderSelect-trigger`, `select-storeKindSelect-trigger`, attributes
 * `text-input-__attributes__discovery__.ip|port|data_parallel_executions`, `progress-button` "Create"); the detail page
 * `#/discoveries/detail/<uuid>` has the details table `tr[data-id=<row>]` (`status`, `providerStatus`, `connectorInterface`, `kind`,
 * `resources`, `message`, …) with status badges, the header buttons `pause-button` (Stop), `play-button` (Resume), `cancel-button`
 * (Cancel, confirm dialog `cancel-discovery-dialog`) and `trash-button` (Delete), the progress widget (`discovery-progress`,
 * `targets-caption`, `targets-failed`), the tabs Details / Results / Messages / Attributes / Event History (role `tab`; Messages
 * carries a count badge `run-message-count`).
 */
import { expect, Locator, Page, Request } from '@playwright/test';
import { Logger } from '../utils/Logger';

const logger = new Logger('DiscoveryRunPage');

export const STATUS_LABEL: Record<string, string> = {
    inProgress: 'In Progress',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    warning: 'Warning',
    stopped: 'Stopped',
    cancelled: 'Cancelled',
};

export class DiscoveryRunPage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/discoveries');
        await expect(this.main.getByRole('heading', { name: /discovery store/i })).toBeVisible();
    }

    get createDialog(): Locator {
        return this.page.getByRole('dialog', { name: /create discovery/i });
    }

    /**
     * v1 form: provider (the connector registration NAME), kind, the targets (`ip`: comma-separated hosts, ranges or CIDR),
     * the ports and the parallel executions; returns the create request the form sent and the new run's uuid.
     */
    async createV1(o: { name: string; provider: string; kind: string; hosts: string; ports?: string; parallel?: number }): Promise<{ uuid: string; request: Request; body: Record<string, any> }> {
        logger.info(`creating the v1 discovery ${o.name} through the form`);
        await this.goToList();
        await this.main.getByTestId('plus-button').click();
        const dialog = this.createDialog;
        await expect(dialog).toBeVisible();
        const name = dialog.getByTestId('text-input-name');
        await name.focus();
        await name.fill(o.name);
        await dialog.getByTestId('select-discoveryProviderSelect-trigger').click();
        await this.page.locator('#discoveryProviderSelect-listbox').getByRole('option', { name: o.provider, exact: true }).click();
        await expect(dialog.getByTestId('label-storeKindSelect')).toBeVisible();
        await dialog.getByTestId('select-storeKindSelect-trigger').click();
        await this.page.getByRole('option', { name: o.kind, exact: true }).click();
        const ip = dialog.getByTestId('text-input-__attributes__discovery__.ip');
        await expect(ip).toBeVisible();
        await ip.focus();
        await ip.fill(o.hosts);
        if (o.ports) {
            const port = dialog.getByTestId('text-input-__attributes__discovery__.port');
            await port.focus();
            await port.fill(o.ports);
        }
        if (o.parallel !== undefined) {
            const parallel = dialog.getByTestId('text-input-__attributes__discovery__.data_parallel_executions');
            await parallel.focus();
            await parallel.fill(String(o.parallel));
        }
        const submit = dialog.getByTestId('progress-button');
        await expect(submit).toBeEnabled();
        const sent = this.page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/v1/discoveries'));
        await submit.click();
        const request = await sent;
        await expect(this.page).toHaveURL(/#\/discoveries\/detail\/([0-9a-f-]{36})/);
        return { uuid: /#\/discoveries\/detail\/([0-9a-f-]{36})/.exec(this.page.url())![1], request, body: request.postDataJSON() as Record<string, any> };
    }

    async openDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/discoveries/detail/${uuid}`);
        await expect(this.main.locator('tr[data-id="status"]')).toBeVisible();
    }

    async detailText(row: string): Promise<string> {
        return (await this.main.locator(`tr[data-id="${row}"] td`).nth(1).innerText()).replace(/\s+/g, ' ').trim();
    }

    /** How many rows of that id the details table has (0 for the `connectorInterface` row of a v1 run). */
    async detailRowCount(row: string): Promise<number> {
        return this.main.locator(`tr[data-id="${row}"]`).count();
    }

    /** The status badge text as shown ("Completed", "In Progress", …), after the badge rendered. */
    async statusLabel(): Promise<string> {
        const badge = this.main.locator('tr[data-id="status"] [data-testid="badge"]');
        await expect(badge).toBeVisible();
        return (await badge.innerText()).trim();
    }

    /** The overall status badge on the details table ("Completed", "In Progress", "Stopped", …). */
    async assertStatus(status: keyof typeof STATUS_LABEL | string): Promise<void> {
        await expect(this.main.locator('tr[data-id="status"] [data-testid="badge"]')).toHaveText(STATUS_LABEL[status] ?? status);
    }

    /** The header controls: which of stop / resume / cancel / delete the page offers right now (v1 runs offer delete only). */
    async controls(): Promise<{ stop: boolean; resume: boolean; cancel: boolean; delete: boolean }> {
        const has = async (id: string) => (await this.main.getByTestId(id).count()) > 0;
        return { stop: await has('pause-button'), resume: await has('play-button'), cancel: await has('cancel-button'), delete: await has('trash-button') };
    }

    async clickStop(): Promise<void> {
        const stopped = this.page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/v1\/discoveries\/[0-9a-f-]+\/stop$/.test(new URL(r.url()).pathname));
        await this.main.getByTestId('pause-button').click();
        expect((await stopped).status(), 'PATCH stop').toBe(204);
    }

    async clickResume(): Promise<void> {
        const resumed = this.page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/v1\/discoveries\/[0-9a-f-]+\/resume$/.test(new URL(r.url()).pathname));
        await this.main.getByTestId('play-button').click();
        expect((await resumed).status(), 'PATCH resume').toBe(204);
    }

    /** Cancel through its confirm dialog ("Keep running" / "Cancel discovery"). */
    async clickCancel(): Promise<void> {
        await this.main.getByTestId('cancel-button').click();
        const dialog = this.page.getByTestId('cancel-discovery-dialog');
        await expect(dialog).toBeVisible();
        const cancelled = this.page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/v1\/discoveries\/[0-9a-f-]+\/cancel$/.test(new URL(r.url()).pathname));
        await dialog.getByRole('button', { name: 'Cancel discovery' }).click();
        expect((await cancelled).status(), 'PATCH cancel').toBe(204);
    }

    /** The progress widget: "<processed> / <total> targets" (v2 runs). */
    async progress(): Promise<{ processed: number; total: number } | undefined> {
        const caption = this.main.getByTestId('targets-caption');
        if (!(await caption.count())) return undefined;
        const m = /(\d[\d,.]*)\s*\/\s*(\d[\d,.]*)/.exec(await caption.first().innerText());
        return m ? { processed: Number(m[1].replace(/[,.]/g, '')), total: Number(m[2].replace(/[,.]/g, '')) } : undefined;
    }

    tab(name: string | RegExp): Locator {
        return this.main.getByRole('tab', { name });
    }

    async openResultsTab(): Promise<void> {
        await this.tab('Results').click();
        await expect(this.tab('Results')).toHaveAttribute('aria-selected', 'true');
    }

    /**
     * Result rows' fingerprint cells (sixth column of "Discovered Certificates": Common Name, Serial Number, Not After, Not Before, Issuer
     * Common Name, Fingerprint; `DiscoveryCertificates.tsx:63-84`), colon separators and case ignored. The default inner tab is "All"
     * (`TABS[0]`, line 26). The table is filled by its own request, so the read waits for the widget's busy overlay to go and for the
     * rows (`expectedCount` pins their number); an empty table is never read as an answer.
     */
    async resultFingerprints(expectedCount?: number): Promise<string[]> {
        const widget = this.main.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Discovered Certificates', exact: true }) }).last();
        await expect(widget).toBeVisible();
        const rows = widget.getByTestId('paged-custom-table').locator('tbody tr[data-id]');
        await expect(widget.getByTestId('widget-busy-overlay')).toHaveCount(0);
        if (expectedCount === undefined) await expect(rows.first()).toBeVisible();
        else await expect(rows).toHaveCount(expectedCount);
        const n = await rows.count();
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push((await rows.nth(i).locator('td').nth(5).innerText()).replace(/[:\s]/g, '').toLowerCase());
        return out.filter(Boolean).sort();
    }

    async openMessagesTab(): Promise<void> {
        await this.tab(/^Messages/).click();
        await expect(this.main.getByTestId('paged-custom-table')).toBeVisible();
    }

    async messageCountBadge(): Promise<number> {
        const badge = this.main.getByTestId('run-message-count');
        return (await badge.count()) ? Number((await badge.first().innerText()).trim()) : 0;
    }

    /** Detail URL (hash route) of a run, for the Event History tab helper. */
    static detailUrl(uuid: string): string {
        return `/administrator/#/discoveries/detail/${uuid}`;
    }
}
