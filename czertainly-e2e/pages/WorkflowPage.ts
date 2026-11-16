/**
 * WorkflowPage — the create forms and detail pages of conditions, rules, actions and triggers (REG-WFL-01, 03).
 * Every `create…` returns the create answer before the redirect, so the spec writes the ledger line first. Nothing is associated here.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { badgeTextOf } from '../utils/regression/inventory/fieldLabels';
import { escapeRegExp } from '../utils/regression/text';
import { FILTER_BADGE_REOPEN_MS } from '../utils/regression/timeouts';
import type { CreateAnswer } from './ui/createAnswer';
import { submitCreate, waitForDetailRoute } from './ui/detailRoute';
import { fillFilterText } from './ui/filter';
import { fillText, setSwitch } from './ui/form';
import { openHashRoute } from './ui/openHashRoute';
import { chooseOption, chooseOptions, describeChoice, OptionChoice, readSelectOptions, selectById, SelectHandle } from './ui/select';
import { widgetTitled } from './ui/widget';

const logger = new Logger('WorkflowPage');

export type UiKind = 'condition' | 'rule' | 'action' | 'trigger';

const LIST_URL: Record<UiKind, string> = {
    condition: '/administrator/#/rules?tab=conditions',
    rule: '/administrator/#/rules',
    action: '/administrator/#/actions',
    trigger: '/administrator/#/triggers',
};

const DETAIL_ROUTE: Record<UiKind, string> = { condition: 'conditions', rule: 'rules', action: 'actions', trigger: 'triggers' };

/** One condition item: the three selects, then ONE value (none for EMPTY / NOT_EMPTY); a date is a day of the current month. */
export interface FilterItem {
    source: OptionChoice;
    field: OptionChoice;
    condition: OptionChoice;
    text?: string;
    option?: OptionChoice;
    dayOfCurrentMonth?: number;
}

export class WorkflowPage {
    readonly page: Page;
    readonly main: Locator;

    // Lists of Conditions, Rules, Actions and Triggers
    readonly addButton: Locator;

    // Create Condition dialog
    readonly createConditionDialog: Locator;
    readonly conditionTypeSelect: SelectHandle;
    readonly conditionResourceSelect: SelectHandle;

    // Create Condition dialog: condition items
    readonly conditionItems: Locator;
    readonly catalogueSpinner: Locator;
    readonly itemSourceSelect: SelectHandle;
    readonly itemFieldSelect: SelectHandle;
    readonly itemConditionSelect: SelectHandle;
    readonly itemValueInput: Locator;
    readonly itemValueSelect: SelectHandle;
    readonly itemDateInput: Locator;
    /** `Add`, or `Update` while a badge is loaded; `#addFilter` as the fallback. */
    readonly addItemButton: Locator;
    readonly itemBadges: Locator;

    // Create Rule dialog
    readonly createRuleDialog: Locator;
    readonly ruleResourceSelect: SelectHandle;
    readonly ruleConditionsSelect: SelectHandle;

    // Create Action dialog
    readonly createActionDialog: Locator;
    readonly actionResourceSelect: SelectHandle;
    readonly actionExecutionsSelect: SelectHandle;

    // Create Trigger dialog
    readonly createTriggerDialog: Locator;
    readonly triggerResourceSelect: SelectHandle;
    readonly triggerTypeSelect: SelectHandle;
    readonly triggerEventSelect: SelectHandle;
    readonly triggerIgnoreSwitch: Locator;
    readonly triggerRulesSelect: SelectHandle;
    readonly triggerActionsSelect: SelectHandle;

    // Detail pages
    readonly uuidValueCell: Locator;
    readonly ignoreSwitch: Locator;

    // Condition Items widget (condition detail)
    readonly conditionItemsWidget: Locator;
    readonly conditionItemBadges: Locator;
    /** The hidden native selects the clicked badge repopulates with the raw codes. */
    readonly sourceCodeInput: Locator;
    readonly fieldCodeInput: Locator;
    readonly conditionCodeInput: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.addButton = this.main.getByTestId('plus-button');

        this.createConditionDialog = page.getByRole('dialog', { name: 'Create Condition' });
        this.conditionTypeSelect = selectById(page, this.createConditionDialog, 'typeSelect');
        this.conditionResourceSelect = selectById(page, this.createConditionDialog, 'resourceSelect');

        this.conditionItems = page.getByRole('dialog').getByTestId('condition-form-filter');
        this.catalogueSpinner = this.conditionItems.getByTestId('spinner');
        this.itemSourceSelect = selectById(page, this.conditionItems, 'group');
        this.itemFieldSelect = selectById(page, this.conditionItems, 'field');
        this.itemConditionSelect = selectById(page, this.conditionItems, 'conditions');
        this.itemValueInput = this.conditionItems.getByTestId('text-input-valueSelect');
        this.itemValueSelect = selectById(page, this.conditionItems, 'valueSelect');
        this.itemDateInput = this.conditionItems.locator('#valueSelect');
        this.addItemButton = this.conditionItems
            .getByRole('button', { name: 'Add', exact: true })
            .or(this.conditionItems.getByRole('button', { name: 'Update', exact: true }))
            .or(this.conditionItems.locator('#addFilter'))
            .first();
        this.itemBadges = this.conditionItems.getByTestId('badge');

        this.createRuleDialog = page.getByRole('dialog', { name: 'Create Rule' });
        this.ruleResourceSelect = selectById(page, this.createRuleDialog, 'resourceSelect');
        this.ruleConditionsSelect = selectById(page, this.createRuleDialog, 'conditionsSelect');

        this.createActionDialog = page.getByRole('dialog', { name: 'Create Action' });
        this.actionResourceSelect = selectById(page, this.createActionDialog, 'resourceSelect');
        this.actionExecutionsSelect = selectById(page, this.createActionDialog, 'executionsSelect');

        this.createTriggerDialog = page.getByRole('dialog', { name: 'Create Trigger' });
        this.triggerResourceSelect = selectById(page, this.createTriggerDialog, 'resourceSelect');
        this.triggerTypeSelect = selectById(page, this.createTriggerDialog, 'triggerTypeSelect');
        this.triggerEventSelect = selectById(page, this.createTriggerDialog, 'eventSelect');
        this.triggerIgnoreSwitch = this.createTriggerDialog.getByTestId('switch-ignoreTrigger-input');
        this.triggerRulesSelect = selectById(page, this.createTriggerDialog, 'ruleSelect');
        this.triggerActionsSelect = selectById(page, this.createTriggerDialog, 'actionsSelect');

        this.uuidValueCell = this.main.locator('tr[data-id="uuid"] td').nth(1);
        this.ignoreSwitch = this.main.getByTestId('switch-ignoreTrigger-input');

        this.conditionItemsWidget = widgetTitled(this.main, 'Condition Items');
        this.conditionItemBadges = this.conditionItemsWidget.getByTestId('badge');
        this.sourceCodeInput = this.conditionItemsWidget.getByTestId('select-group-input');
        this.fieldCodeInput = this.conditionItemsWidget.getByTestId('select-field-input');
        this.conditionCodeInput = this.conditionItemsWidget.getByTestId('select-conditions-input');
    }

    dialog(kind: UiKind): Locator {
        return { condition: this.createConditionDialog, rule: this.createRuleDialog, action: this.createActionDialog, trigger: this.createTriggerDialog }[kind];
    }

    private nameInput(kind: UiKind): Locator {
        return this.dialog(kind).getByTestId('text-input-name');
    }

    private descriptionInput(kind: UiKind): Locator {
        return this.dialog(kind).getByTestId('text-input-description');
    }

    private createButton(kind: UiKind): Locator {
        return this.dialog(kind).getByTestId('progress-button').last();
    }

    /** An enabled day button of the open date picker. */
    private dayButton(day: number): Locator {
        return this.page.getByRole('button', { name: String(day), exact: true }).and(this.page.locator(':enabled')).first();
    }

    private async goToList(kind: UiKind): Promise<void> {
        logger.info(`opening the ${kind} list`);
        await this.page.goto(LIST_URL[kind]);
        await expect(this.main).toBeVisible();
        await expect(this.addButton).toBeVisible();
    }

    /** The list of the kind, then its "+" button. */
    async openCreateDialog(kind: UiKind): Promise<void> {
        await this.goToList(kind);
        await this.addButton.click();
        await expect(this.dialog(kind)).toBeVisible();
    }

    /** Focus in the dialog, then Escape: a click on the page behind would not close it. */
    async cancelCreate(kind: UiKind): Promise<void> {
        await this.nameInput(kind).focus();
        await this.page.keyboard.press('Escape');
        await expect(this.dialog(kind), `the ${kind} dialog closes without saving`).toHaveCount(0);
    }

    async waitForDetailRoute(kind: UiKind): Promise<string> {
        return waitForDetailRoute(this.page, DETAIL_ROUTE[kind]);
    }

    /** Waits until the field catalogue of the chosen resource is loaded (the spinner is gone, the source select is enabled). */
    async waitForConditionCatalogue(): Promise<void> {
        await expect(this.catalogueSpinner).toHaveCount(0);
        await expect(this.itemSourceSelect.trigger).toBeEnabled();
    }

    /** The labels the Field select offers for a source; an empty list when the source has no field. */
    async conditionFieldLabels(source: OptionChoice): Promise<string[]> {
        await chooseOption(this.page, this.itemSourceSelect, source);
        if (!(await this.itemFieldSelect.trigger.isEnabled())) return [];
        return readSelectOptions(this.page, this.itemFieldSelect);
    }

    /** The three selects, the value, Add; the badge appears. A list value select that stays open (multi) is closed with Escape. */
    private async addConditionItem(item: FilterItem): Promise<void> {
        logger.info(`adding condition item ${describeChoice(item.source)} / ${describeChoice(item.field)} / ${describeChoice(item.condition)}`);
        const before = await this.itemBadges.count();
        // A later select resets on an earlier change; the condition is picked before the value (fe#994).
        await chooseOption(this.page, this.itemSourceSelect, item.source);
        await chooseOption(this.page, this.itemFieldSelect, item.field);
        await chooseOption(this.page, this.itemConditionSelect, item.condition);
        if (item.text !== undefined) await fillFilterText(this.itemValueInput, item.text);
        else if (item.option !== undefined) await chooseOptions(this.page, this.itemValueSelect, [item.option]);
        else if (item.dayOfCurrentMonth !== undefined) {
            await this.itemDateInput.click();
            await this.dayButton(item.dayOfCurrentMonth).click();
        }
        await expect(this.addItemButton).toBeEnabled();
        await this.addItemButton.click();
        await expect(this.itemBadges).toHaveCount(before + 1);
    }

    /** Rules → Conditions → Create Condition: name, type checkField, resource, then the items. */
    async createCondition(o: { name: string; description?: string; resource: string; items: FilterItem[] }): Promise<CreateAnswer> {
        await this.openCreateDialog('condition');
        await fillText(this.nameInput('condition'), o.name);
        if (o.description) await fillText(this.descriptionInput('condition'), o.description);
        await chooseOption(this.page, this.conditionTypeSelect, { value: 'checkField' });
        // The resource first: choosing it clears the items and loads the field catalogue of that resource.
        await chooseOption(this.page, this.conditionResourceSelect, { value: o.resource });
        await this.waitForConditionCatalogue();
        for (const item of o.items) await this.addConditionItem(item);
        return this.submit('condition', '/v1/workflows/conditions');
    }

    async createRule(o: { name: string; description?: string; resource: string; conditions: string[] }): Promise<CreateAnswer> {
        await this.openCreateDialog('rule');
        await fillText(this.nameInput('rule'), o.name);
        if (o.description) await fillText(this.descriptionInput('rule'), o.description);
        await chooseOption(this.page, this.ruleResourceSelect, { value: o.resource });
        await chooseOptions(this.page, this.ruleConditionsSelect, o.conditions);
        return this.submit('rule', '/v1/workflows/rules');
    }

    async createAction(o: { name: string; description?: string; resource: string; executions: string[] }): Promise<CreateAnswer> {
        await this.openCreateDialog('action');
        await fillText(this.nameInput('action'), o.name);
        if (o.description) await fillText(this.descriptionInput('action'), o.description);
        await chooseOption(this.page, this.actionResourceSelect, { value: o.resource });
        await chooseOptions(this.page, this.actionExecutionsSelect, o.executions);
        return this.submit('action', '/v1/workflows/actions');
    }

    /** Type Event is the only type the form offers; the trigger is bound to no association, so it never fires. */
    async createTrigger(o: { name: string; description?: string; resource: string; event: string; ignore?: boolean; rules?: string[]; actions?: string[] }): Promise<CreateAnswer> {
        await this.openCreateDialog('trigger');
        await fillText(this.nameInput('trigger'), o.name);
        if (o.description) await fillText(this.descriptionInput('trigger'), o.description);
        await chooseOption(this.page, this.triggerResourceSelect, { value: o.resource });
        await chooseOption(this.page, this.triggerTypeSelect, { value: 'event' });
        await chooseOption(this.page, this.triggerEventSelect, { value: o.event });
        if (o.ignore) await setSwitch(this.createTriggerDialog, this.triggerIgnoreSwitch, true);
        if (o.rules?.length) await chooseOptions(this.page, this.triggerRulesSelect, o.rules);
        if (o.actions?.length) await chooseOptions(this.page, this.triggerActionsSelect, o.actions);
        return this.submit('trigger', '/v1/workflows/triggers');
    }

    async goToDetail(kind: UiKind, uuid: string): Promise<void> {
        // Reloads when the create's redirect already opened this route, so the page is a fresh open.
        await openHashRoute(this.page, `${DETAIL_ROUTE[kind]}/detail/${uuid}`);
        await expect(this.uuidValueCell).toHaveText(uuid); // the NEW uuid, not the previous route's table
    }

    /** A badge reads `<source> '<field>' <condition>[ '<value>']`, condition case-insensitive, field maybe suffixed `label (String)`. */
    async assertConditionItemBadge(parts: { source: string; field: string; condition: string; value?: string }): Promise<void> {
        const texts = await this.conditionItemBadgeTexts();
        // Matched segment by segment, so "Equals" never hits "Not equals" and a field label is not a prefix of another.
        const value = parts.value === undefined ? "(?: '.*')?" : ` '${escapeRegExp(parts.value)}'`;
        const wanted = new RegExp(`^${escapeRegExp(parts.source)} '${escapeRegExp(parts.field)}(?: \\([^)]*\\))?' ${escapeRegExp(parts.condition)}${value}$`, 'i');
        const hit = texts.find((t) => wanted.test(t));
        expect(hit, `a badge ${JSON.stringify(parts)} (${String(wanted)}) among ${JSON.stringify(texts)}`).toBeTruthy();
    }

    /** Clicks a saved badge and reads the raw codes it repopulates the three selects with. */
    async readConditionItemCodes(index: number): Promise<{ source: string; field: string; condition: string }> {
        await this.conditionItemBadgeTexts();
        await this.conditionItemBadges.nth(index).click();
        // The widget repopulates the selects in a useEffect AFTER the click: wait until each hidden select holds a code, then read.
        for (const input of [this.sourceCodeInput, this.fieldCodeInput, this.conditionCodeInput]) {
            await expect(input, 'the select is repopulated from the clicked badge').not.toHaveValue('');
        }
        return { source: await this.sourceCodeInput.inputValue(), field: await this.fieldCodeInput.inputValue(), condition: await this.conditionCodeInput.inputValue() };
    }

    /** A badge is empty until the field catalogue and the enums are loaded: waits until there are badges and each has text. */
    private async conditionItemBadgeTexts(): Promise<string[]> {
        let texts: string[] = [];
        await expect(async () => {
            texts = (await this.conditionItemBadges.allInnerTexts()).map(badgeTextOf);
            expect(texts.length, 'the widget shows badges').toBeGreaterThan(0);
            expect(texts.every(Boolean), `every badge is rendered (the catalogue is loaded): ${JSON.stringify(texts)}`).toBe(true);
        }).toPass({ timeout: FILTER_BADGE_REOPEN_MS });
        return texts;
    }

    private async submit(kind: UiKind, endpoint: string): Promise<CreateAnswer> {
        await expect(this.createButton(kind), 'Create is enabled once the form is valid').toBeEnabled();
        return submitCreate(this.page, this.createButton(kind), { endpoint });
    }
}
