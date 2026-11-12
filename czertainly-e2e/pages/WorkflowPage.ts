/**
 * WorkflowPage — the create forms and detail pages of the workflow objects.
 *
 * WHAT: the create forms and detail pages of the workflow objects: conditions and rules, actions and executions, triggers.
 * WHY: objects built in the forms must be stored as typed, so the page lets a spec compare the request sent, the stored object and the
 *      reopened detail; nothing is associated here, so nothing fires.
 * HOW: list and dialog per kind from a route table; condition items through `FilterWidget.inDialog`; every `create<Kind>` returns
 *      the answer of the create request (the spec records it first), and `waitForDetailRoute` then reads the uuid from the route
 *      the UI opens after Create.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { FilterItem, FilterWidget } from './FilterWidget';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { fillText, setSwitch, submitButtonOf } from './ui/form';
import { chooseOption, chooseOptions, selectById } from './ui/select';

const logger = new Logger('WorkflowPage');

export type UiKind = 'condition' | 'rule' | 'action' | 'execution' | 'trigger';

const LIST_URL: Record<UiKind, string> = {
    condition: '/administrator/#/rules?tab=conditions',
    rule: '/administrator/#/rules',
    action: '/administrator/#/actions',
    execution: '/administrator/#/actions?tab=executions',
    trigger: '/administrator/#/triggers',
};

/** The detail route of each kind (`#/<route>/detail/<uuid>`). */
const DETAIL_ROUTE: Record<UiKind, string> = { condition: 'conditions', rule: 'rules', action: 'actions', execution: 'executions', trigger: 'triggers' };

const DIALOG: Record<Exclude<UiKind, 'execution'>, string> = {
    condition: 'Create Condition',
    rule: 'Create Rule',
    action: 'Create Action',
    trigger: 'Create Trigger',
};

export class WorkflowPage {
    private readonly page: Page;
    readonly main: Locator;
    /** The Ignore switch on a trigger detail page (`switch-ignoreTrigger-input`, read with `toBeChecked`). */
    readonly ignoreSwitch: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.ignoreSwitch = this.main.getByTestId('switch-ignoreTrigger-input');
    }

    async goToList(kind: UiKind): Promise<void> {
        logger.info(`opening the ${kind} list`);
        await this.page.goto(LIST_URL[kind]);
        await expect(this.main).toBeVisible();
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    /** The dialog of a create form (not for executions). */
    dialog(kind: Exclude<UiKind, 'execution'>): Locator {
        return this.page.getByRole('dialog', { name: DIALOG[kind] });
    }

    /** The list of the kind, then its "+" button: the create dialog (an execution opens its add page). */
    async openCreateDialog(kind: UiKind): Promise<void> {
        await this.goToList(kind);
        await this.main.getByTestId('plus-button').click();
        if (kind === 'execution') await expect(this.page).toHaveURL(/#\/executions\/add/);
        else await expect(this.dialog(kind)).toBeVisible();
    }

    /** Leaves an open create dialog without saving: focus in the dialog, then Escape (a click on the page behind would not close it). */
    async cancelCreate(kind: Exclude<UiKind, 'execution'>): Promise<void> {
        const dialog = this.dialog(kind);
        await dialog.getByTestId('text-input-name').focus();
        await this.page.keyboard.press('Escape');
        await expect(dialog, `the ${kind} dialog closes without saving`).toHaveCount(0);
    }

    // ---------------------------------------------------------------- form controls

    private async fillField(scope: Locator, id: string, value: string): Promise<void> {
        await fillText(scope.getByTestId(`text-input-${id}`), value);
    }

    /** Clicks Create and returns the answer of the create request the form sends (the redirect is `waitForDetailRoute`'s). */
    private async submit(scope: Locator, endpoint: string): Promise<CreateAnswer> {
        const submit = submitButtonOf(scope);
        await expect(submit, 'Create is enabled once the form is valid').toBeEnabled();
        return submitCreate(this.page, scope, { endpoint });
    }

    /** Waits for the redirect to the new object's detail page after a successful create and returns its uuid. */
    async waitForDetailRoute(kind: UiKind): Promise<string> {
        return waitForDetailRoute(this.page, DETAIL_ROUTE[kind]);
    }

    // ---------------------------------------------------------------- create forms

    /** Rules → Conditions → Create Condition: name, type checkField, resource, then the items through the filter widget. */
    async createCondition(o: { name: string; description?: string; resource: string; items: FilterItem[] }): Promise<CreateAnswer> {
        await this.openCreateDialog('condition');
        const dialog = this.dialog('condition');
        await this.fillField(dialog, 'name', o.name);
        if (o.description) await this.fillField(dialog, 'description', o.description);
        await chooseOption(this.page, selectById(this.page, dialog, 'typeSelect'), { value: 'checkField' });
        // The resource first: choosing it clears the items and loads the field catalogue of that resource.
        await chooseOption(this.page, selectById(this.page, dialog, 'resourceSelect'), { value: o.resource });
        const widget = FilterWidget.inDialog(this.page);
        await widget.waitForFilterCatalogue();
        for (const item of o.items) await widget.addItem(item);
        return this.submit(dialog, '/v1/workflows/conditions');
    }

    /** Rules → Create Rule: name, resource, the conditions of that resource (by name). */
    async createRule(o: { name: string; description?: string; resource: string; conditions: string[] }): Promise<CreateAnswer> {
        await this.openCreateDialog('rule');
        const dialog = this.dialog('rule');
        await this.fillField(dialog, 'name', o.name);
        if (o.description) await this.fillField(dialog, 'description', o.description);
        await chooseOption(this.page, selectById(this.page, dialog, 'resourceSelect'), { value: o.resource });
        await chooseOptions(this.page, selectById(this.page, dialog, 'conditionsSelect'), o.conditions);
        return this.submit(dialog, '/v1/workflows/rules');
    }

    /** Actions → Create Action: name, resource, the executions of that resource (by name). */
    async createAction(o: { name: string; description?: string; resource: string; executions: string[] }): Promise<CreateAnswer> {
        await this.openCreateDialog('action');
        const dialog = this.dialog('action');
        await this.fillField(dialog, 'name', o.name);
        if (o.description) await this.fillField(dialog, 'description', o.description);
        await chooseOption(this.page, selectById(this.page, dialog, 'resourceSelect'), { value: o.resource });
        await chooseOptions(this.page, selectById(this.page, dialog, 'executionsSelect'), o.executions);
        return this.submit(dialog, '/v1/workflows/actions');
    }

    /**
     * Triggers → Create Trigger: name, resource, type Event (the only type the form offers), the event, the Ignore switch, the
     * rules and (unless ignore) the actions. The form never sends a trigger that is not bound to an association: creating it
     * associates nothing (the object never fires until an event association names it).
     */
    async createTrigger(o: { name: string; description?: string; resource: string; event: string; ignore?: boolean; rules?: string[]; actions?: string[] }): Promise<CreateAnswer> {
        await this.openCreateDialog('trigger');
        const dialog = this.dialog('trigger');
        await this.fillField(dialog, 'name', o.name);
        if (o.description) await this.fillField(dialog, 'description', o.description);
        await chooseOption(this.page, selectById(this.page, dialog, 'resourceSelect'), { value: o.resource });
        await chooseOption(this.page, selectById(this.page, dialog, 'triggerTypeSelect'), { value: 'event' });
        await chooseOption(this.page, selectById(this.page, dialog, 'eventSelect'), { value: o.event });
        if (o.ignore) await setSwitch(dialog, 'ignoreTrigger', true);
        if (o.rules?.length) await chooseOptions(this.page, selectById(this.page, dialog, 'ruleSelect'), o.rules);
        if (o.actions?.length) await chooseOptions(this.page, selectById(this.page, dialog, 'actionsSelect'), o.actions);
        return this.submit(dialog, '/v1/workflows/triggers');
    }

    // ---------------------------------------------------------------- detail pages (read back)

    async goToDetail(kind: UiKind, uuid: string): Promise<void> {
        await this.page.goto(`/administrator/#/${DETAIL_ROUTE[kind]}/detail/${uuid}`);
        await expect(this.main.locator('tr[data-id="uuid"] td').nth(1)).toHaveText(uuid); // the NEW uuid, not the previous route's table
    }
}
