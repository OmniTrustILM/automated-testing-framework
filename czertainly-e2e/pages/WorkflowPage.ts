/**
 * WorkflowPage — the workflow object forms of the admin UI: conditions, rules, actions, executions and triggers (REG-WFL-01 / 03).
 *
 * Where each form lives (fe-administrator `AppRouter.tsx`, read in the source): Rules and Conditions are two tabs of one page
 * (`#/rules`, `#/rules?tab=conditions`), Actions and Executions likewise (`#/actions`, `#/actions?tab=executions`), Triggers
 * are `#/triggers`; the create forms of condition, rule, action and trigger are DIALOGS ("Create Condition", …) opened with the
 * list toolbar's `plus-button`, the execution form is the page `#/executions/add`. After Create the UI redirects to the new
 * object's detail page (`#/conditions/detail/<uuid>`, …), which is where the uuid is read.
 *
 * Form hooks: `text-input-name` / `text-input-description` (readonly until focused), Selects `select-<id>-trigger` with options
 * `[role=option]` in the portal `select-<id>-content` (ids `typeSelect`, `resourceSelect`, `conditionsSelect`,
 * `executionsSelect`, `triggerTypeSelect`, `eventSelect`, `ruleSelect`, `actionsSelect`), the trigger form's switch
 * `switch-ignoreTrigger-input`, the submit `progress-button` ("Create"). A multi select keeps its popover open after a pick, and inside
 * a dialog that popover is MODAL (the dialog is aria-hidden, the overlay intercepts clicks; `Select/index.tsx:194-198, 477-481`), so
 * `pickMany` closes it with Escape, never with a click. Names accept letters, digits and `- / _ ' .` only between word characters.
 */
import { expect, Locator, Page, Request } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { ConditionFilterWidget, ItemInput } from './ConditionFilterWidget';

const logger = new Logger('WorkflowPage');

export type UiKind = 'condition' | 'rule' | 'action' | 'execution' | 'trigger';

const LIST_URL: Record<UiKind, string> = {
    condition: '/administrator/#/rules?tab=conditions',
    rule: '/administrator/#/rules',
    action: '/administrator/#/actions',
    execution: '/administrator/#/actions?tab=executions',
    trigger: '/administrator/#/triggers',
};

const DETAIL_URL: Record<UiKind, RegExp> = {
    condition: /#\/conditions\/detail\/([0-9a-f-]{36})/,
    rule: /#\/rules\/detail\/([0-9a-f-]{36})/,
    action: /#\/actions\/detail\/([0-9a-f-]{36})/,
    execution: /#\/executions\/detail\/([0-9a-f-]{36})/,
    trigger: /#\/triggers\/detail\/([0-9a-f-]{36})/,
};

const DIALOG: Record<Exclude<UiKind, 'execution'>, string> = {
    condition: 'Create Condition',
    rule: 'Create Rule',
    action: 'Create Action',
    trigger: 'Create Trigger',
};

export interface Created {
    uuid: string;
    /** The create request the form sent (method POST, JSON body), for the request ↔ stored object ↔ detail oracle. */
    request: Request;
    body: Record<string, any>;
}

export class WorkflowPage {
    readonly page: Page;
    readonly main: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
    }

    async goTo(kind: UiKind): Promise<void> {
        logger.info(`opening the ${kind} list`);
        await this.page.goto(LIST_URL[kind]);
        await expect(this.main).toBeVisible();
        await expect(this.main.getByTestId('plus-button')).toBeVisible();
    }

    /** The dialog of a create form (not for executions). */
    dialog(kind: Exclude<UiKind, 'execution'>): Locator {
        return this.page.getByRole('dialog', { name: DIALOG[kind] });
    }

    async openCreate(kind: UiKind): Promise<void> {
        await this.goTo(kind);
        await this.main.getByTestId('plus-button').click();
        if (kind === 'execution') await expect(this.page).toHaveURL(/#\/executions\/add/);
        else await expect(this.dialog(kind)).toBeVisible();
    }

    // ---------------------------------------------------------------- form controls

    private async fillText(scope: Locator, id: string, value: string): Promise<void> {
        const input = scope.getByTestId(`text-input-${id}`);
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

    /** A multi select: click each option (it stays open), then Escape to close the popover (a modal one: no click outside works). */
    private async pickMany(scope: Locator, id: string, labels: string[]): Promise<void> {
        const trigger = scope.getByTestId(`select-${id}-trigger`);
        await expect(trigger, `the ${id} select has options`).toBeEnabled();
        await trigger.click();
        const content = this.page.getByTestId(`select-${id}-content`);
        for (const label of labels) {
            const option = content.getByRole('option', { name: label, exact: true });
            await expect(option, `option ${label} of ${id}`).toBeVisible();
            await option.click();
        }
        await this.page.keyboard.press('Escape');
        await expect(content).toHaveCount(0);
    }

    /** Clicks Create and captures the create request the form sends; returns once the UI redirected to the detail page. */
    private async submit(kind: UiKind, scope: Locator, endpoint: string): Promise<Created> {
        const submit = scope.getByTestId('progress-button');
        await expect(submit, 'Create is enabled once the form is valid').toBeEnabled();
        const sent = this.page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith(endpoint));
        await submit.click();
        const request = await sent;
        await expect(this.page).toHaveURL(DETAIL_URL[kind]);
        const uuid = DETAIL_URL[kind].exec(this.page.url())![1];
        return { uuid, request, body: request.postDataJSON() as Record<string, any> };
    }

    // ---------------------------------------------------------------- create forms

    /** Rules → Conditions → Create Condition: name, type checkField, resource, then the items through the filter widget. */
    async createCondition(o: { name: string; description?: string; resource: string; items: ItemInput[] }): Promise<Created> {
        await this.openCreate('condition');
        const dialog = this.dialog('condition');
        await this.fillText(dialog, 'name', o.name);
        if (o.description) await this.fillText(dialog, 'description', o.description);
        await this.pick(dialog, 'typeSelect', { value: 'checkField' });
        // The resource first: choosing it clears the items and loads the field catalogue of that resource.
        await this.pick(dialog, 'resourceSelect', { value: o.resource });
        const widget = ConditionFilterWidget.inDialog(this.page);
        await widget.waitUntilReady();
        for (const item of o.items) await widget.addItem(item);
        return this.submit('condition', dialog, '/v1/workflows/conditions');
    }

    /** Rules → Create Rule: name, resource, the conditions of that resource (by name). */
    async createRule(o: { name: string; description?: string; resource: string; conditions: string[] }): Promise<Created> {
        await this.openCreate('rule');
        const dialog = this.dialog('rule');
        await this.fillText(dialog, 'name', o.name);
        if (o.description) await this.fillText(dialog, 'description', o.description);
        await this.pick(dialog, 'resourceSelect', { value: o.resource });
        await this.pickMany(dialog, 'conditionsSelect', o.conditions);
        return this.submit('rule', dialog, '/v1/workflows/rules');
    }

    /** Actions → Create Action: name, resource, the executions of that resource (by name). */
    async createAction(o: { name: string; description?: string; resource: string; executions: string[] }): Promise<Created> {
        await this.openCreate('action');
        const dialog = this.dialog('action');
        await this.fillText(dialog, 'name', o.name);
        if (o.description) await this.fillText(dialog, 'description', o.description);
        await this.pick(dialog, 'resourceSelect', { value: o.resource });
        await this.pickMany(dialog, 'executionsSelect', o.executions);
        return this.submit('action', dialog, '/v1/workflows/actions');
    }

    /**
     * Triggers → Create Trigger: name, resource, type Event (the only type the form offers), the event, the Ignore switch, the
     * rules and (unless ignore) the actions. The form never sends a trigger that is not bound to an association: creating it
     * associates nothing (the object never fires until an event association names it).
     */
    async createTrigger(o: { name: string; description?: string; resource: string; event: string; ignore?: boolean; rules?: string[]; actions?: string[] }): Promise<Created> {
        await this.openCreate('trigger');
        const dialog = this.dialog('trigger');
        await this.fillText(dialog, 'name', o.name);
        if (o.description) await this.fillText(dialog, 'description', o.description);
        await this.pick(dialog, 'resourceSelect', { value: o.resource });
        await this.pick(dialog, 'triggerTypeSelect', { value: 'event' });
        await this.pick(dialog, 'eventSelect', { value: o.event });
        if (o.ignore) await dialog.getByTestId('switch-ignoreTrigger-input').check({ force: true });
        if (o.rules?.length) await this.pickMany(dialog, 'ruleSelect', o.rules);
        if (o.actions?.length) await this.pickMany(dialog, 'actionsSelect', o.actions);
        return this.submit('trigger', dialog, '/v1/workflows/triggers');
    }

    // ---------------------------------------------------------------- detail pages (read back)

    /** A detail page's property table: `tr[data-id=<row>]` second cell, e.g. `name`, `resource`, `type`, `eventName`. */
    async detailValue(row: string): Promise<string> {
        return (await this.main.locator(`tr[data-id="${row}"] td`).nth(1).innerText()).trim();
    }

    async openDetail(kind: UiKind, uuid: string): Promise<void> {
        const path = { condition: 'conditions', rule: 'rules', action: 'actions', execution: 'executions', trigger: 'triggers' }[kind];
        await this.page.goto(`/administrator/#/${path}/detail/${uuid}`);
        await expect(this.main.locator('tr[data-id="uuid"] td').nth(1)).toHaveText(uuid); // the NEW uuid, not the previous route's table
    }

    /** Rows of a detail page's sub-table (rules of a trigger, conditions of a rule, executions of an action): `tr[data-id=<uuid>]`. */
    subRow(widgetTitle: string, uuid: string): Locator {
        return this.main.locator('section').filter({ has: this.page.getByRole('heading', { name: widgetTitle, exact: true }) }).last().locator(`tr[data-id="${uuid}"]`);
    }

    /** The ignore switch on a trigger detail page (`switch-ignoreTrigger-input`, read with `toBeChecked`). */
    get ignoreSwitch(): Locator {
        return this.main.getByTestId('switch-ignoreTrigger-input');
    }

    /** A list row by object name (the name is a link; the new row may be on page 2: the caller reads the API for existence). */
    listRow(name: string): Locator {
        return this.main.getByRole('row').filter({ has: this.page.getByRole('link', { name, exact: true }) });
    }
}
