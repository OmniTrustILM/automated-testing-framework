/**
 * form — form helpers: `fillText`, `cancelIfOpen`, switches and the filler of empty required custom attributes.
 * Inputs are readonly until focused, so every fill goes through `fillText`. A switch is a hidden input, clicked through its label.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../../utils/Logger';
import { chooseOption } from './select';

const logger = new Logger('Form');

/** TextInputs are readonly until focused (anti-autofill): click, then fill. */
export async function fillText(input: Locator, value: string): Promise<void> {
    await input.click();
    await input.fill(value);
}

/** Clicks `cancelButton` when `dialog` is still open (after a refused submit) and waits until the dialog is gone. */
export async function cancelIfOpen(dialog: Locator, cancelButton: Locator): Promise<void> {
    if (await dialog.isVisible()) {
        await cancelButton.click();
        await expect(dialog).toBeHidden();
    }
}

/**
 * Sets a switch by clicking its label, then proves the state with `toBeChecked`. `switchOrId` is the switch id inside
 * `scope` or the input locator itself. It never forces a click on the hidden input: a forced check can leave the form's state unchanged.
 */
export async function setSwitch(scope: Locator, switchOrId: string | Locator, on: boolean): Promise<void> {
    const input = typeof switchOrId === 'string' ? scope.getByTestId(`switch-${switchOrId}-input`) : switchOrId;
    const name = typeof switchOrId === 'string' ? switchOrId : 'switch';
    if ((await input.isChecked()) !== on) {
        const inputId = await input.getAttribute('id');
        if (!inputId) throw new Error(`setSwitch: ${name} has no id, so it has no label to click`);
        const label = scope.locator(`label[for="${inputId}"]`).first();
        await expect(label, `the label of ${name}`).toBeVisible();
        await label.click();
    }
    if (on) await expect(input, `${name} is on`).toBeChecked();
    else await expect(input, `${name} is off`).not.toBeChecked();
}

/** The editor once rendered: its "Show custom attribute" select (optional attributes remain) or a custom attribute label (required ones). */
export const customAttributeEditor = (scope: Locator): Locator =>
    scope.getByTestId('select-selectAddCustomAttribute-trigger').or(scope.locator('label[for^="__attributes__custom"]')).first();

/** Whether the tier defines any custom attribute for a resource. A failed read fails: it is no proof of "none". */
export async function customAttributesDefined(page: Page, resource: string): Promise<boolean> {
    const answer = await page.request.get(`/api/v1/attributes/custom/resources/${resource}`);
    expect(answer.status(), `GET /api/v1/attributes/custom/resources/${resource}`).toBe(200);
    const definitions: unknown = await answer.json();
    expect(Array.isArray(definitions), `the custom attribute definitions of ${resource} are a list`).toBe(true);
    return (definitions as unknown[]).length > 0;
}

/**
 * Fills every empty required custom attribute of a form and returns the labels it filled; tabbed forms keep them in a
 * hidden "Custom Attributes" tab. `definitionsExist` (from `customAttributesDefined`) makes the wait for the editor a hard expectation.
 */
export async function fillRequiredCustomAttributes(page: Page, scope: Locator, value: string, definitionsExist: boolean): Promise<string[]> {
    if (definitionsExist) {
        const tab = scope.getByRole('tab', { name: /^Custom attributes$/i }).first();
        if (await tab.isVisible()) await tab.click();
        // The editor renders after its definitions load: the add-select or a required attribute's label marks it ready.
        await expect(customAttributeEditor(scope), 'the custom attribute editor is rendered').toBeAttached({ timeout: 10_000 });
    }
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
