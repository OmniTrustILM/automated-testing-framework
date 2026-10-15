/**
 * NotificationPage — the notification instance and profile forms (REG-WFL-23) and their detail pages.
 *
 * Where they live (fe-administrator `AppRouter.tsx`, read in the source): the instance list is the tab "Notification
 * Instances" of the Events page (`#/events?tab=notification-instances`), the profile list is `#/notificationprofiles`; both
 * create forms are DIALOGS opened with the list's `plus-button`. After Create the UI redirects to
 * `#/notificationinstances/detail/<uuid>` and `#/notificationprofiles/detail/<uuid>/<version>`.
 *
 * Instance form: `text-input-name` (no spaces), `#description` (a textarea without a test id), Selects
 * `select-notificationInstanceProviderSelect-trigger` (options = connector names) and `select-kindSelect-trigger`
 * (EMAIL / WEBHOOK); the connector attributes are rendered by the attribute editor with the id `notification`:
 * `text-input-__attributes__notification__.<name>` for strings, `select-__attributes__notification__.<name>Select-trigger`
 * for list attributes, the code editor `[id="__attributes__notification__.<name>.codeTextArea"]` for code blocks.
 * Profile form: `text-input-name`, `#description`, `select-recipientType-trigger` (options `data-value` none, default, user,
 * group, role, owner, object), `select-recipients-trigger` (multi), `select-notificationInstance-trigger`,
 * `switch-internalNotification-input`, `eventDataCategory-<category>-input`, `text-input-frequency` ("5d 4h"),
 * `text-input-repetitions`; submit `progress-button` ("Create").
 *
 * Both create dialogs are Radix dialogs, so a multi Select inside them (the recipients) opens a MODAL popover (`Select/index.tsx:194-198`):
 * it is closed with Escape, never by clicking the dialog's heading. The profile detail shows the event data categories as badges with
 * their LABELS ("Custom attributes"), not their codes (`notification-profiles/detail/index.tsx:174-186`); `CATEGORY_LABEL` maps the codes
 * the form's switches use (`eventDataCategory-<code>-input`) to them.
 *
 * Each create returns the request the form sent (method POST, JSON body): REG-WFL-23 compares the request, the stored object
 * and the detail page. The instance request carries extra keys the form spreads (`connectorName`, the nested attribute form
 * state) the API ignores: the oracle compares the fields that matter, never the whole body.
 */
import { expect, Locator, Page, Request } from '@playwright/test';
import { Logger } from '../utils/Logger';

const logger = new Logger('NotificationPage');

export interface Sent {
    uuid: string;
    request: Request;
    body: Record<string, any>;
}

/** `NotificationDataCategory` code -> label (interfaces `NotificationDataCategory.java:23-27`), as the detail page's badges print it. */
export const CATEGORY_LABEL: Record<string, string> = {
    customAttributes: 'Custom attributes',
    metadata: 'Metadata',
    associations: 'Associations',
    objectContent: 'Object content',
};

export type AttributeEntry =
    | { name: string; kind: 'text'; value: string }
    | { name: string; kind: 'list'; label?: string; value?: string }
    | { name: string; kind: 'code'; value: string };

export class NotificationPage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    async goToInstances(): Promise<void> {
        await this.page.goto('/administrator/#/events?tab=notification-instances');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async goToProfiles(): Promise<void> {
        await this.page.goto('/administrator/#/notificationprofiles');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    private async fillText(scope: Locator, selector: string, value: string): Promise<void> {
        const input = scope.locator(selector);
        await input.focus();
        await input.fill(value);
    }

    private async pick(scope: Locator, id: string, p: { value?: string; label?: string }): Promise<void> {
        const trigger = scope.getByTestId(`select-${id}-trigger`);
        await expect(trigger, `the ${id} select has options`).toBeEnabled();
        await trigger.click();
        const content = this.page.getByTestId(`select-${id}-content`);
        const option = p.value !== undefined ? content.locator(`[role=option][data-value="${p.value}"]`) : content.getByRole('option', { name: p.label, exact: true });
        await expect(option.first(), `option ${p.value ?? p.label} of ${id}`).toBeVisible();
        await option.first().click();
    }

    // ---------------------------------------------------------------- instances

    get instanceDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Create Notification Instance' });
    }

    /**
     * Notification Instances → Create: name, description, provider (by connector name), kind, then the attributes the kind
     * offers. The Create button stays disabled until every required attribute is filled.
     */
    async createInstance(o: { name: string; description?: string; provider: string; kind: string; attributes: AttributeEntry[] }): Promise<Sent> {
        logger.info(`creating the ${o.kind} notification instance through the form`);
        await this.goToInstances();
        await this.main.getByTestId('plus-button').click();
        const dialog = this.instanceDialog;
        await expect(dialog).toBeVisible();
        await this.fillText(dialog, '[data-testid="text-input-name"]', o.name);
        if (o.description) await this.fillText(dialog, '#description', o.description);
        await this.pick(dialog, 'notificationInstanceProviderSelect', { label: o.provider });
        await this.pick(dialog, 'kindSelect', { label: o.kind });
        for (const a of o.attributes) {
            const id = `__attributes__notification__.${a.name}`;
            if (a.kind === 'text') {
                const input = dialog.getByTestId(`text-input-${id}`);
                await expect(input, `attribute ${a.name} is rendered`).toBeVisible();
                await input.focus();
                await input.fill(a.value);
            } else if (a.kind === 'list') {
                await this.pick(dialog, `${id}Select`, a.value !== undefined ? { value: a.value } : { label: a.label });
            } else {
                const code = dialog.locator(`[id="${id}.codeTextArea"]`);
                await expect(code, `the code editor of ${a.name}`).toBeVisible();
                await code.focus();
                await code.fill(a.value);
            }
        }
        const submit = dialog.getByTestId('progress-button');
        await expect(submit, 'Create is enabled once every required attribute is filled').toBeEnabled();
        const sent = this.page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/v1/notificationInstances'));
        await submit.click();
        const request = await sent;
        await expect(this.page).toHaveURL(/#\/notificationinstances\/detail\/([0-9a-f-]{36})/);
        return { uuid: /#\/notificationinstances\/detail\/([0-9a-f-]{36})/.exec(this.page.url())![1], request, body: request.postDataJSON() as Record<string, any> };
    }

    /** A detail page's property row (`tr[data-id=<row>]`, second cell) inside the widget with that title. */
    async detailValue(widgetTitle: string, row: string): Promise<string> {
        const widget = this.main.locator('section').filter({ has: this.page.getByRole('heading', { name: widgetTitle, exact: true }) }).last();
        return (await widget.locator(`tr[data-id="${row}"] td`).nth(1).innerText()).trim();
    }

    /** The instance detail page: name, kind and provider as shown. */
    async assertInstanceDetail(uuid: string, expected: { name: string; kind: string; provider: string }): Promise<void> {
        await this.page.goto(`/administrator/#/notificationinstances/detail/${uuid}`);
        // A hash change keeps the previous route's table on screen until the new GET answers: wait for the NEW uuid, then read.
        await expect(this.main.locator('tr[data-id="uuid"] td').nth(1)).toHaveText(uuid);
        const text = async (row: string) => (await this.main.locator(`tr[data-id="${row}"] td`).nth(1).innerText()).trim();
        expect(await text('name')).toBe(expected.name);
        expect(await text('kind')).toBe(expected.kind);
        expect(await text('notificationProviderName')).toContain(expected.provider);
    }

    // ---------------------------------------------------------------- profiles

    get profileDialog(): Locator {
        return this.page.getByRole('dialog', { name: 'Create Notification Profile' });
    }

    /**
     * Notification Profiles → Create: name, description, recipient type, recipients (by name, user / group / role only),
     * the instance (by name), the internal switch, event data categories, frequency (`5d 4h`) and repetitions.
     */
    async createProfile(o: {
        name: string;
        description?: string;
        recipientType: 'none' | 'default' | 'user' | 'group' | 'role' | 'owner' | 'object';
        recipients?: string[];
        instance?: string;
        internal?: boolean;
        categories?: string[];
        frequency?: string;
        repetitions?: number;
    }): Promise<Sent> {
        logger.info(`creating the ${o.recipientType} notification profile through the form`);
        await this.goToProfiles();
        await this.main.getByTestId('plus-button').click();
        const dialog = this.profileDialog;
        await expect(dialog).toBeVisible();
        await this.fillText(dialog, '[data-testid="text-input-name"]', o.name);
        if (o.description) await this.fillText(dialog, '#description', o.description);
        await this.pick(dialog, 'recipientType', { value: o.recipientType });
        if (o.recipients?.length) {
            const trigger = dialog.getByTestId('select-recipients-trigger');
            await expect(trigger, 'the recipients select has options').toBeEnabled();
            await trigger.click();
            const content = this.page.getByTestId('select-recipients-content');
            for (const r of o.recipients) await content.getByRole('option', { name: r, exact: true }).click();
            await this.page.keyboard.press('Escape');
            await expect(content).toBeHidden();
        }
        if (o.instance) await this.pick(dialog, 'notificationInstance', { label: o.instance });
        if (o.internal) await dialog.getByTestId('switch-internalNotification-input').check({ force: true });
        for (const c of o.categories ?? []) await dialog.getByTestId(`eventDataCategory-${c}-input`).check({ force: true });
        if (o.frequency) await this.fillText(dialog, '[data-testid="text-input-frequency"]', o.frequency);
        if (o.repetitions !== undefined) await this.fillText(dialog, '[data-testid="text-input-repetitions"]', String(o.repetitions));
        const submit = dialog.getByTestId('progress-button');
        await expect(submit).toBeEnabled();
        const sent = this.page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/v1/notificationProfiles'));
        await submit.click();
        const request = await sent;
        await expect(this.page).toHaveURL(/#\/notificationprofiles\/detail\/([0-9a-f-]{36})\/\d+/);
        return { uuid: /#\/notificationprofiles\/detail\/([0-9a-f-]{36})\//.exec(this.page.url())![1], request, body: request.postDataJSON() as Record<string, any> };
    }

    /** The profile detail page's "Notification Profile Details" table (row ids collide with the instance table below: scoped). */
    async assertProfileDetail(uuid: string, expected: { name: string; internal: boolean; recipientType: string; categories?: string[]; frequency?: string; repetitions?: number; instanceName?: string }): Promise<void> {
        await this.page.goto(`/administrator/#/notificationprofiles/detail/${uuid}/1`);
        const title = 'Notification Profile Details';
        const widget = this.main.locator('section').filter({ has: this.page.getByRole('heading', { name: title, exact: true }) }).last();
        await expect(widget.locator('tr[data-id="uuid"] td').nth(1)).toHaveText(uuid); // the NEW uuid (stale table of the previous route otherwise)
        const cell = async (row: string) => (await widget.locator(`tr[data-id="${row}"] td`).nth(1).innerText()).replace(/\s+/g, ' ').trim();
        expect(await cell('name')).toBe(expected.name);
        expect(await cell('version')).toBe('1');
        expect(await cell('recipientType')).toMatch(new RegExp(expected.recipientType, 'i'));
        expect(await cell('internalNotification')).toBe(expected.internal ? 'Yes' : 'No');
        if (expected.categories) {
            // Codes in, labels compared: the badges print the enum LABEL ("Custom attributes"), never the code.
            const tags = await widget.getByTestId('eventDataCategories-tags').getByTestId('badge').allInnerTexts();
            expect(tags.map((t) => t.trim()).sort()).toEqual(expected.categories.map((c) => CATEGORY_LABEL[c] ?? c).sort());
        }
        if (expected.frequency) expect(await cell('frequency')).toBe(expected.frequency);
        if (expected.repetitions !== undefined) expect(await cell('repetitions')).toBe(String(expected.repetitions));
        if (expected.instanceName) {
            const instance = this.main.locator('section').filter({ has: this.page.getByRole('heading', { name: 'Notification Instance Details', exact: true }) }).last();
            expect((await instance.locator('tr[data-id="name"] td').nth(1).innerText()).trim()).toBe(expected.instanceName);
        }
    }
}
