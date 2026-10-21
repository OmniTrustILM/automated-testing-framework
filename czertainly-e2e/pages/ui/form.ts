/**
 * Form helpers: the one way to fill a text input (inputs are readonly until focused, an anti-autofill measure), the
 * form's submit button, and the filler of empty required custom attributes that some tiers define on groups, users, ….
 */
import { Locator, Page } from '@playwright/test';
import { Logger } from '../../utils/Logger';
import { chooseOption } from './select';

const logger = new Logger('form');

/** TextInputs are readonly until focused (anti-autofill): click, then fill. */
export async function fillText(input: Locator, value: string): Promise<void> {
    await input.click();
    await input.fill(value);
}

/** The form's submit (ProgressButton, data-testid progress-button: "Create", "Save", …). */
export const submitButtonOf = (scope: Locator): Locator => scope.getByTestId('progress-button').last();

/**
 * Fill every empty required custom attribute of a form. They render as `__attributes__custom…__.<name>` fields; in tabbed
 * forms they sit in a hidden "Custom Attributes" tab, which is opened first. Selects get their first option, inputs get
 * `value`. Returns the labels it filled.
 */
export async function fillRequiredCustomAttributes(page: Page, scope: Locator, value: string): Promise<string[]> {
    const tab = scope.getByRole('tab', { name: /^Custom attributes$/i }).first();
    if (await tab.isVisible()) await tab.click();
    // The custom attribute editor renders after its definitions load; its "Show custom attribute" select marks it ready.
    // A form without custom attributes has no editor at all, so a missing marker after 10 s is not an error here.
    await scope.getByTestId('select-selectAddCustomAttribute-trigger').first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    const filled: string[] = [];
    const labels = scope.locator('label[for^="__attributes__custom"], label[for^="__attributes__certificateAssociatedAttributes"]').filter({ hasText: /\*\s*$/ });
    for (const label of await labels.all()) {
        if (!(await label.isVisible())) continue;
        const forId = (await label.getAttribute('for'))!;
        const text = (await label.innerText()).trim();
        // A list attribute's label points at "<name>" or "<name>Select"; its trigger is select-<name>Select-trigger.
        const trigger = page
            .getByTestId(`select-${forId}-trigger`)
            .or(page.getByTestId(`select-${forId}Select-trigger`))
            .first();
        if (await trigger.count()) {
            if (/^Select /.test((await trigger.innerText()).trim())) {
                await chooseOption(page, trigger, /.+/);
                filled.push(text);
            }
            continue;
        }
        const input = scope.locator(`[id="${forId}"]`);
        if ((await input.count()) && !(await input.inputValue())) {
            await fillText(input, /number|integer|float/i.test((await input.getAttribute('type')) ?? '') ? '1' : value);
            filled.push(text);
        }
    }
    if (filled.length) logger.info(`filled required custom attributes: ${filled.join(', ')}`);
    return filled;
}
