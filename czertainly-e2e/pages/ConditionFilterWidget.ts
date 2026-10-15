/**
 * ConditionFilterWidget — the FilterWidget of the workflow condition form ("Condition Items", `condition-form-filter`):
 * the one control sequence Source → Field → Operator → Value → Add, and the badges that show what was added.
 *
 * Events-area name for the inventory area's `FilterWidget` (phase-05 B2.1 creates both under that name; the merge step folds
 * them: this class needs no more than the add / read / remove actions of the condition form).
 *
 * Hooks (fe-administrator `components/FilterWidget`, read in the source): the selects are `select-group` (source, label
 * "Filter Field Source"), `select-field` (label "Filter Field") and `select-conditions` (label "Filter Condition"): trigger
 * `select-<id>-trigger`, options `[role=option][data-value=<value>]` in the portal `select-<id>-content`; the value control
 * is `text-input-valueSelect` (readonly until focused: focus, then fill), a Select `select-valueSelect-trigger` for list and
 * boolean fields, or the date picker `#valueSelect` (readonly, calendar in a portal); Add is `#addFilter` (button "Add",
 * "Update" while a badge is selected); every item is a `[data-testid=badge]` whose text is
 * `<source label> '<field label>' <operator label> '<value>'`, removed with its "Remove badge" button.
 *
 * Inside a Radix dialog a Select opens a MODAL popover (`Select/index.tsx:194-198, 477-481`): the dialog is aria-hidden and the overlay
 * intercepts clicks, so a multi-select is closed with the keyboard (Escape), never by clicking the dialog's heading, a label or the
 * trigger. Label picks are EXACT name matches ("Equals" must not hit "Not equals"); the option `data-value` of a list value is the
 * object's uuid, not its name (`Select/index.tsx:98-112`), so list values are picked by their exact label. The badges render only once
 * the field catalogue is loaded (`FilterWidget/index.tsx:535-540` renders nothing while it is fetching): reads wait for that.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';

const logger = new Logger('ConditionFilterWidget');

export interface Pick {
    /** The option's `data-value` (an enum code or an identifier). */
    value?: string;
    /** The option's visible label; used when no value is given. */
    label?: string | RegExp;
}

export interface ItemInput {
    source: Pick;
    field: Pick;
    operator: Pick;
    /** A text / number value; omit for EMPTY / NOT_EMPTY. */
    text?: string;
    /** A list value (RA profile, group, owner, boolean): the option to choose. */
    option?: Pick;
    /** A date: the day of the CURRENT month to click in the calendar (date-only attributes). */
    dayOfCurrentMonth?: number;
}

export class ConditionFilterWidget {
    readonly page: Page;
    readonly scope: Locator;

    constructor(page: Page, scope: Locator) {
        this.page = page;
        this.scope = scope;
    }

    /** The widget inside the open condition form dialog. */
    static inDialog(page: Page): ConditionFilterWidget {
        return new ConditionFilterWidget(page, page.getByRole('dialog').getByTestId('condition-form-filter'));
    }

    /** The widget titled "Condition Items" on a condition detail page. */
    static onDetail(page: Page): ConditionFilterWidget {
        return new ConditionFilterWidget(page, page.locator('main section').filter({ has: page.getByRole('heading', { name: 'Condition Items', exact: true }) }).last());
    }

    get badges(): Locator {
        return this.scope.getByTestId('badge');
    }

    get addButton(): Locator {
        return this.scope.getByRole('button', { name: 'Add', exact: true });
    }

    private trigger(id: string): Locator {
        return this.scope.getByTestId(`select-${id}-trigger`);
    }

    private async pick(id: string, p: Pick): Promise<void> {
        const trigger = this.trigger(id);
        await expect(trigger, `the ${id} select has options`).toBeEnabled();
        await trigger.click();
        const content = this.page.getByTestId(`select-${id}-content`);
        const option = p.value !== undefined ? content.locator(`[role=option][data-value="${p.value}"]`) : content.getByRole('option', typeof p.label === 'string' ? { name: p.label, exact: true } : { name: p.label });
        await expect(option.first(), `option ${p.value ?? String(p.label)} of ${id}`).toBeVisible();
        await option.first().click();
    }

    /** Closes an open popover with the keyboard (a modal popover inside a dialog blocks every click outside it). */
    private async closeSelect(id: string): Promise<void> {
        const content = this.page.getByTestId(`select-${id}-content`);
        if (await content.isVisible()) await this.page.keyboard.press('Escape');
        await expect(content).toBeHidden();
    }

    /** Waits until the field catalogue of the chosen resource is loaded (the spinner is gone, the source select is enabled). */
    async waitUntilReady(): Promise<void> {
        await expect(this.scope.getByTestId('spinner')).toHaveCount(0);
        await expect(this.trigger('group')).toBeEnabled();
    }

    /** The labels the Field select offers for a source (opens and closes it); an empty list when the source has no field. */
    async fieldLabels(source: Pick): Promise<string[]> {
        await this.pick('group', source);
        const trigger = this.trigger('field');
        if (!(await trigger.isEnabled())) return [];
        await trigger.click();
        const options = this.page.getByTestId('select-field-content').getByRole('option');
        await expect(options.first()).toBeVisible();
        const labels = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
        await this.closeSelect('field');
        return labels;
    }

    /** Adds one item: the four controls in order, then Add; the badge appears and the controls reset. */
    async addItem(item: ItemInput): Promise<void> {
        logger.info(`adding condition item ${item.source.value ?? String(item.source.label)} / ${item.field.value ?? String(item.field.label)} / ${item.operator.value ?? String(item.operator.label)}`);
        const before = await this.badges.count();
        await this.pick('group', item.source);
        await this.pick('field', item.field);
        await this.pick('conditions', item.operator);
        if (item.text !== undefined) {
            const input = this.scope.getByTestId('text-input-valueSelect');
            await input.focus();
            await input.fill(item.text);
        } else if (item.option) {
            await this.pick('valueSelect', item.option);
            // A multi value select stays open (a single one closed itself): Escape, never a click outside (modal popover in a dialog).
            await this.closeSelect('valueSelect');
        } else if (item.dayOfCurrentMonth !== undefined) {
            await this.scope.locator('#valueSelect').click();
            await this.page.getByRole('button', { name: String(item.dayOfCurrentMonth), exact: true }).and(this.page.locator(':enabled')).first().click();
        }
        await expect(this.addButton).toBeEnabled();
        await this.addButton.click();
        await expect(this.badges).toHaveCount(before + 1);
    }

    /**
     * The badge texts, whitespace-normalised and without the "Remove badge" suffix. A badge is empty until the field catalogue and the
     * enums are loaded, so the read waits until at least one badge exists and every badge has text (`expected` pins their number).
     */
    async badgeTexts(expected?: number): Promise<string[]> {
        let texts: string[] = [];
        await expect(async () => {
            const raw = await this.badges.allInnerTexts();
            texts = raw.map((t) => t.replace(/\s*Remove badge$/, '').replace(/\s+/g, ' ').trim());
            expect(texts.length, 'the widget shows condition item badges').toBeGreaterThan(0);
            if (expected !== undefined) expect(texts.length).toBe(expected);
            expect(texts.every(Boolean), `every badge is rendered (the catalogue is loaded): ${JSON.stringify(texts)}`).toBe(true);
        }).toPass({ timeout: 15_000 });
        return texts;
    }

    /**
     * One badge shows the source label, the field label (in quotes) and the operator label (and the value when given):
     * `Property 'Common Name' Equals 'x'`. The operator is compared case-insensitively (the platform enum label is lower case,
     * the UI may capitalise it); the field may carry a content-type suffix for duplicated custom labels (`label (String)`).
     */
    async assertBadge(parts: { source: string; field: string; operator: string; value?: string }): Promise<void> {
        const texts = await this.badgeTexts();
        // The whole badge is matched segment by segment, so "Equals" never hits "Not equals" and a field label is not a prefix of another.
        const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const value = parts.value === undefined ? "(?: '.*')?" : ` '${esc(parts.value)}'`;
        const wanted = new RegExp(`^${esc(parts.source)} '${esc(parts.field)}(?: \\([^)]*\\))?' ${esc(parts.operator)}${value}$`, 'i');
        const hit = texts.find((t) => wanted.test(t));
        expect(hit, `a condition item badge ${JSON.stringify(parts)} (${String(wanted)}) among ${JSON.stringify(texts)}`).toBeTruthy();
    }

    /** Selecting a saved badge repopulates the four controls: the hidden native selects hold the raw codes. */
    async selectBadgeAndReadCodes(index: number): Promise<{ source: string; field: string; operator: string }> {
        await this.badgeTexts();
        await this.badges.nth(index).click();
        // FilterWidget repopulates group / field / condition from the saved filter in a useEffect AFTER the click (live run 2, five
        // REG-WFL-01 tests read ""): wait until each hidden select holds a code, then read.
        for (const id of ['select-group-input', 'select-field-input', 'select-conditions-input']) {
            await expect(this.scope.getByTestId(id), `${id} is repopulated from the clicked badge`).not.toHaveValue('');
        }
        const source = await this.scope.getByTestId('select-group-input').inputValue();
        const field = await this.scope.getByTestId('select-field-input').inputValue();
        const operator = await this.scope.getByTestId('select-conditions-input').inputValue();
        return { source, field, operator };
    }
}
