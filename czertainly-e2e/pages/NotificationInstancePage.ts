/**
 * NotificationInstancePage — Page Object Model for notification instances.
 *
 * Encapsulates:
 *   - the instance list and the instance detail
 *   - the create dialog, with the attributes the chosen kind offers
 *
 * The specs compare the request sent, the stored object and the detail page. `submitCreateForm` returns the create
 * answer and `waitForDetailRoute` then reads the uuid, so the spec records the object between the two.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { fillText, submitButtonOf } from './ui/form';
import { chooseOption, selectById } from './ui/select';

const logger = new Logger('NotificationInstancePage');

/** One connector attribute of the form: a text input, a list Select (by value or label) or a code editor. */
export type AttributeEntry =
    | { name: string; kind: 'text'; value: string }
    | { name: string; kind: 'list'; label?: string; value?: string }
    | { name: string; kind: 'code'; value: string };

export interface InstanceForm {
    name: string;
    description?: string;
    provider: string;
    kind: string;
    attributes: AttributeEntry[];
}

export class NotificationInstancePage {
    private readonly page: Page;
    readonly main: Locator;
    /** The create dialog, by its accessible name. */
    readonly createDialog: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.createDialog = page.getByRole('dialog', { name: 'Create Notification Instance' });
    }

    async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/events?tab=notification-instances');
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    async openCreateDialog(): Promise<void> {
        await this.main.getByTestId('plus-button').click();
        await expect(this.createDialog).toBeVisible();
    }

    /** Fills the open create dialog: name, description, provider, kind, then the attributes the kind offers. */
    async fillCreateForm(o: InstanceForm): Promise<void> {
        const dialog = this.createDialog;
        await fillText(dialog.getByTestId('text-input-name'), o.name);
        if (o.description) await fillText(dialog.locator('#description'), o.description);
        await chooseOption(this.page, selectById(this.page, dialog, 'notificationInstanceProviderSelect'), o.provider);
        await chooseOption(this.page, selectById(this.page, dialog, 'kindSelect'), o.kind);
        for (const a of o.attributes) {
            const id = `__attributes__notification__.${a.name}`;
            if (a.kind === 'text') {
                const input = dialog.getByTestId(`text-input-${id}`);
                await expect(input, `attribute ${a.name} is rendered`).toBeVisible();
                await fillText(input, a.value);
            } else if (a.kind === 'list') {
                await chooseOption(this.page, selectById(this.page, dialog, `${id}Select`), a.value !== undefined ? { value: a.value } : (a.label ?? /.+/));
            } else {
                const code = dialog.locator(`[id="${id}.codeTextArea"]`);
                await expect(code, `the code editor of ${a.name}`).toBeVisible();
                await fillText(code, a.value);
            }
        }
    }

    /**
     * Clicks Create (enabled once every required attribute is filled) and returns the answer of the create request: status,
     * the new uuid, the request it sent. It does not wait for the redirect: record the uuid first, then `waitForDetailRoute()`.
     */
    async submitCreateForm(): Promise<CreateAnswer> {
        const submit = submitButtonOf(this.createDialog);
        await expect(submit, 'Create is enabled once every required attribute is filled').toBeEnabled();
        return submitCreate(this.page, this.createDialog, { endpoint: '/v1/notificationInstances' });
    }

    /** Waits for the redirect to the new instance's detail page after a successful create and returns its uuid. */
    async waitForDetailRoute(): Promise<string> {
        return waitForDetailRoute(this.page, 'notificationinstances');
    }

    /** List → Create → fill → submit; returns the create answer (see `submitCreateForm`). */
    async createInstance(o: InstanceForm): Promise<CreateAnswer> {
        logger.info(`creating the ${o.kind} notification instance through the form`);
        await this.goToList();
        await this.openCreateDialog();
        await this.fillCreateForm(o);
        return this.submitCreateForm();
    }

    /** The instance detail page; waits until the table shows THIS uuid (a hash change keeps the previous table for a moment). */
    async goToDetail(uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/notificationinstances/detail/${uuid}`);
        await expect(this.main.locator('tr[data-id="uuid"] td').nth(1)).toHaveText(uuid);
    }

    /** The open detail page shows the name, kind and provider. */
    async assertDetail(expected: { name: string; kind: string; provider: string }): Promise<void> {
        const text = async (row: string) => (await this.main.locator(`tr[data-id="${row}"] td`).nth(1).innerText()).trim();
        expect(await text('name'), 'the detail shows the instance name').toBe(expected.name);
        expect(await text('kind'), 'the detail shows the instance kind').toBe(expected.kind);
        expect(await text('notificationProviderName'), 'the detail names the provider connector').toContain(expected.provider);
    }
}
