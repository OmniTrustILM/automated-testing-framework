/**
 * NotificationInstancePage — the notification instance list, the Create Notification Instance dialog and the detail (REG-WFL-23).
 * `createInstance` returns the create answer before the redirect, so the spec records the object between it and `waitForDetailRoute`.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { fillText } from './ui/form';
import { openHashRoute } from './ui/openHashRoute';
import { chooseOption, selectById, SelectHandle } from './ui/select';

const logger = new Logger('NotificationInstancePage');

/** One connector attribute of the form: a text input, a list Select (by value) or a code editor. */
export type AttributeEntry =
    | { name: string; kind: 'text'; value: string }
    | { name: string; kind: 'list'; value: string }
    | { name: string; kind: 'code'; value: string };

export interface InstanceForm {
    name: string;
    description?: string;
    provider: string;
    kind: string;
    attributes: AttributeEntry[];
}

export class NotificationInstancePage {
    readonly page: Page;
    readonly main: Locator;

    // Notification Instances list
    readonly addInstanceButton: Locator;

    // Create Notification Instance dialog
    readonly createDialog: Locator;
    readonly nameInput: Locator;
    readonly descriptionInput: Locator;
    readonly providerSelect: SelectHandle;
    readonly kindSelect: SelectHandle;
    readonly createButton: Locator;

    // Notification instance detail
    readonly uuidValueCell: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.addInstanceButton = this.main.getByTestId('plus-button');

        this.createDialog = page.getByRole('dialog', { name: 'Create Notification Instance' });
        this.nameInput = this.createDialog.getByTestId('text-input-name');
        this.descriptionInput = this.createDialog.locator('#description');
        this.providerSelect = selectById(page, this.createDialog, 'notificationInstanceProviderSelect');
        this.kindSelect = selectById(page, this.createDialog, 'kindSelect');
        this.createButton = this.createDialog.getByTestId('progress-button').last();

        this.uuidValueCell = this.detailValueCell('uuid');
    }

    private attributeInput(name: string): Locator {
        return this.createDialog.getByTestId(`text-input-__attributes__notification__.${name}`);
    }

    private attributeSelect(name: string): SelectHandle {
        return selectById(this.page, this.createDialog, `__attributes__notification__.${name}Select`);
    }

    private attributeCodeEditor(name: string): Locator {
        return this.createDialog.locator(`[id="__attributes__notification__.${name}.codeTextArea"]`);
    }

    /** The value cell of a detail row (`tr[data-id=<row>]`). */
    private detailValueCell(row: string): Locator {
        return this.main.locator(`tr[data-id="${row}"] td`).nth(1);
    }

    private async goToList(): Promise<void> {
        await this.page.goto('/administrator/#/events?tab=notification-instances');
        await expect(this.addInstanceButton).toBeVisible();
    }

    private async openCreateDialog(): Promise<void> {
        await this.addInstanceButton.click();
        await expect(this.createDialog).toBeVisible();
    }

    /** Name, description, provider, kind, then the attributes the kind offers. */
    private async fillCreateForm(o: InstanceForm): Promise<void> {
        await fillText(this.nameInput, o.name);
        if (o.description) await fillText(this.descriptionInput, o.description);
        await chooseOption(this.page, this.providerSelect, o.provider);
        await chooseOption(this.page, this.kindSelect, o.kind);
        for (const a of o.attributes) {
            if (a.kind === 'text') {
                await expect(this.attributeInput(a.name), `attribute ${a.name} is rendered`).toBeVisible();
                await fillText(this.attributeInput(a.name), a.value);
            } else if (a.kind === 'list') {
                await chooseOption(this.page, this.attributeSelect(a.name), { value: a.value });
            } else {
                await expect(this.attributeCodeEditor(a.name), `the code editor of ${a.name}`).toBeVisible();
                await fillText(this.attributeCodeEditor(a.name), a.value);
            }
        }
    }

    /** Create is enabled once every required attribute is filled. The redirect is not waited for: record first, then `waitForDetailRoute`. */
    private async submitCreateForm(): Promise<CreateAnswer> {
        await expect(this.createButton, 'Create is enabled once every required attribute is filled').toBeEnabled();
        return submitCreate(this.page, this.createButton, { endpoint: '/v1/notificationInstances' });
    }

    async waitForDetailRoute(): Promise<string> {
        return waitForDetailRoute(this.page, 'notificationinstances');
    }

    async createInstance(o: InstanceForm): Promise<CreateAnswer> {
        logger.info(`creating the ${o.kind} notification instance through the form`);
        await this.goToList();
        await this.openCreateDialog();
        await this.fillCreateForm(o);
        return this.submitCreateForm();
    }

    /** Waits until the table shows THIS uuid (a hash change keeps the previous table for a moment). */
    async goToDetail(uuid: string): Promise<void> {
        await openHashRoute(this.page, `notificationinstances/detail/${uuid}`);
        await expect(this.uuidValueCell).toHaveText(uuid);
    }

    async assertDetail(expected: { name: string; kind: string; provider: string }): Promise<void> {
        const text = async (row: string) => (await this.detailValueCell(row).innerText()).trim();
        expect(await text('name'), 'the detail shows the instance name').toBe(expected.name);
        expect(await text('kind'), 'the detail shows the instance kind').toBe(expected.kind);
        expect(await text('notificationProviderName'), 'the detail names the provider connector').toContain(expected.provider);
    }
}
