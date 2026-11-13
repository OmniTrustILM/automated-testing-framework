/**
 * select — the one place that opens, reads and chooses from the admin UI's custom Select (a Radix popover).
 * A text choice matches the exact option name; a prefix only by explicit
 * opt-in with a reason, never "contains". A multi select is closed with Escape.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../../utils/Logger';
import { escapeRegExp } from '../../utils/regression/text';

const logger = new Logger('Select');

/** An option's exact label, a pattern, its `data-value`, or (opted in, with a reason) a text prefix. */
export type OptionChoice = string | RegExp | { value: string } | { prefix: string; reason: string };

export interface SelectHandle {
    readonly trigger: Locator;
    readonly content: Locator;
    readonly name: string;
}

export type SelectRef = SelectHandle | Locator;

const collapse = (s: string): string => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export function selectOfTrigger(page: Page, trigger: Locator): SelectHandle {
    return { trigger, content: page.getByRole('listbox').last(), name: 'select' };
}

const handleOf = (page: Page, ref: SelectRef): SelectHandle => ('trigger' in ref ? ref : selectOfTrigger(page, ref));

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

export async function closePopover(page: Page, content: Locator): Promise<void> {
    await page.keyboard.press('Escape');
    await expect(content).toBeHidden();
}

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

/** Multi select (also fine for a single one): re-opens it when a pick closed it, closes it with Escape at the end. */
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
 * The option texts in order, or `data-value` codes with `as: 'value'`;
 * nothing is chosen. `allowEmpty` returns [] for a select with no option.
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
