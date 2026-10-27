/**
 * select — the Select helper.
 *
 * WHAT: the one place that opens, reads and chooses from the admin UI's custom Select (a Radix popover).
 * WHY: one matching rule for a text choice: the exact accessible name of the option; a prefix only by an explicit opt-in with a reason,
 *       never "contains", so "Equals" never hits "Not equals"; a choice that names no option fails.
 * HOW: trigger and content by test id (`select-<id>-trigger` / `select-<id>-content`, options with role option and
 *       a `data-value` code); inside a dialog the popover is modal, so a multi select is closed with Escape, never
 *       by a click elsewhere; a single select closes itself after a pick; a RegExp is tested against the option
 *       text, `{ value }` matches `data-value`.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../../utils/Logger';
import { escapeRegExp } from '../../utils/regression/text';

const logger = new Logger('select');

/**
 * What to click: an option's exact label, a pattern for its name, its `data-value`, or — opted in explicitly, with the
 * reason — the option whose text starts with `prefix`.
 */
export type OptionChoice = string | RegExp | { value: string } | { prefix: string; reason: string };

/** A select: its trigger and the popover content that holds the options. */
export interface SelectHandle {
    readonly trigger: Locator;
    readonly content: Locator;
    /** For messages. */
    readonly name: string;
}

/** A select given by its handle or just by its trigger (the content is then the last open listbox). */
export type SelectRef = SelectHandle | Locator;

const collapse = (s: string): string => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** The select `select-<id>` inside `scope`; its portalled content `select-<id>-content` is looked up page-wide. */
export function selectById(page: Page, scope: Locator, id: string): SelectHandle {
    return { trigger: scope.getByTestId(`select-${id}-trigger`), content: page.getByTestId(`select-${id}-content`), name: id };
}

/** The select behind a trigger locator; the content is the last open listbox of the page. */
export function selectOfTrigger(page: Page, trigger: Locator): SelectHandle {
    return { trigger, content: page.getByRole('listbox').last(), name: 'select' };
}

const handleOf = (page: Page, ref: SelectRef): SelectHandle => ('trigger' in ref ? ref : selectOfTrigger(page, ref));

/** Trigger of the Select whose label matches (wrapper with the label first, else the first trigger after the label). */
export function selectTriggerByLabel(scope: Locator, label: string | RegExp): Locator {
    const wrapped = scope
        .locator('div[data-testid^="select-"]')
        .filter({ has: scope.page().locator('label').filter({ hasText: label }) })
        .locator('button[aria-haspopup="listbox"]');
    const following = scope.locator('label').filter({ hasText: label }).first().locator('xpath=following::button[@aria-haspopup="listbox"][1]');
    return wrapped.or(following).first();
}

export const describeChoice = (choice: OptionChoice): string =>
    typeof choice === 'string' || choice instanceof RegExp ? String(choice) : 'value' in choice ? `value ${choice.value}` : `prefix "${choice.prefix}"`;

/** The option of an open select that the choice names (waits until it is visible). */
async function optionOf(sel: SelectHandle, choice: OptionChoice): Promise<Locator> {
    const options = sel.content.getByRole('option');
    const what = `option ${describeChoice(choice)} of ${sel.name}`;
    if (typeof choice === 'object' && !(choice instanceof RegExp) && 'prefix' in choice) {
        if (!choice.reason?.trim()) throw new Error(`${what}: a prefix choice needs the reason why the exact name cannot be used`);
        const byPrefix = options.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(choice.prefix)}(\\s|$)`) }).first();
        await expect(byPrefix, what).toBeVisible();
        logger.debug(`${what}: prefix choice (${choice.reason})`);
        return byPrefix;
    }
    if (typeof choice === 'object' && !(choice instanceof RegExp)) {
        const byValue = sel.content.locator(`[role=option][data-value="${choice.value}"]`).first();
        await expect(byValue, what).toBeVisible();
        return byValue;
    }
    if (choice instanceof RegExp) {
        const byName = options.filter({ hasText: choice }).first();
        await expect(byName, what).toBeVisible();
        return byName;
    }
    const exact = sel.content.getByRole('option', { name: choice, exact: true }).first();
    await expect(exact, `${what} (exact accessible name)`).toBeVisible();
    return exact;
}

async function open(sel: SelectHandle): Promise<void> {
    await expect(sel.trigger, `${sel.name} is enabled`).toBeEnabled();
    await sel.trigger.click();
    await expect(sel.content.getByRole('option').first(), `${sel.name} offers options`).toBeVisible();
}

/** Closes an open popover with the keyboard (a modal popover blocks every click outside it) and waits until it is gone. */
export async function closePopover(page: Page, content: Locator): Promise<void> {
    await page.keyboard.press('Escape');
    await expect(content).toBeHidden();
}

/** Opens a single select and clicks the option; returns the option's text. The popover closes by itself. */
export async function chooseOption(page: Page, select: SelectRef, choice: OptionChoice): Promise<string> {
    const sel = handleOf(page, select);
    await open(sel);
    const option = await optionOf(sel, choice);
    const text = collapse(await option.innerText());
    await option.click();
    await expect(sel.content).toBeHidden();
    logger.debug(`chose "${text}" in ${sel.name}`);
    return text;
}

/**
 * Multi select (also fine for a single one): opens it, clicks each choice (re-opening when a pick closed it), then closes it
 * with Escape when it is still open and waits until it is hidden.
 */
export async function chooseOptions(page: Page, select: SelectRef, choices: readonly OptionChoice[]): Promise<void> {
    const sel = handleOf(page, select);
    await expect(sel.trigger, `${sel.name} is enabled`).toBeEnabled();
    for (const choice of choices) {
        if (!(await sel.content.isVisible())) {
            await sel.trigger.click();
            await expect(sel.content.getByRole('option').first(), `${sel.name} offers options`).toBeVisible();
        }
        await (await optionOf(sel, choice)).click();
    }
    if (await sel.content.isVisible()) await page.keyboard.press('Escape');
    await expect(sel.content).toBeHidden();
}

/**
 * The options a select offers, in order (opened and closed again; nothing is chosen): their texts, or their `data-value`
 * codes with `as: 'value'`. `allowEmpty` returns [] for a select with no option instead of waiting for one.
 */
export async function readSelectOptions(page: Page, select: SelectRef, opts: { as?: 'text' | 'value'; allowEmpty?: boolean } = {}): Promise<string[]> {
    const sel = handleOf(page, select);
    await expect(sel.trigger, `${sel.name} is enabled`).toBeEnabled();
    await sel.trigger.click();
    await expect(sel.content).toBeVisible();
    const options = sel.content.getByRole('option');
    if (!opts.allowEmpty) await expect(options.first(), `${sel.name} offers options`).toBeVisible();
    const out =
        opts.as === 'value'
            ? (await options.evaluateAll((els) => els.map((e) => e.getAttribute('data-value') ?? ''))).filter(Boolean)
            : (await options.allTextContents()).map(collapse);
    await closePopover(page, sel.content);
    return out;
}
