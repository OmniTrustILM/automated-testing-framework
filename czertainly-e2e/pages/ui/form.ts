/**
 * form — form helpers.
 *
 * WHAT: form helpers: the one way to fill a text input, the form's submit button, a switch, and the filler of empty required
 *       custom attributes a tier may define (with the API read that says whether any are defined).
 * WHY: inputs are readonly until focused (anti-autofill), so every fill goes through `fillText`; a switch is a hidden input
 *       under its label, so it is clicked through the label and its state proven; tiers differ in custom attributes, so a
 *       create form fills whatever is required, and waits for the editor only on a tier that defines any.
 * HOW: labels that end in an asterisk mark required attributes; selects get their first option, inputs a value; whether the
 *       editor renders is decided from the definitions the API lists, never from a timed wait.
 */
import { expect, Locator, Page } from '@playwright/test';
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
 * Sets a switch (a visually hidden input with a `label[for]`) by clicking its label, then proves the state with
 * `toBeChecked`. `switchOrId` is the switch id (`switch-<id>-input` inside `scope`) or the input locator itself (a
 * checkbox such as `eventDataCategory-<code>-input`). It never forces a click on the hidden input: a forced check can leave
 * the form's state unchanged while the DOM says checked. A switch already in the wanted state is left alone; an input
 * without an id (so without a label to click) fails.
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

/**
 * The custom attribute editor of a form once it has rendered: its "Show custom attribute" select (shown only while optional
 * attributes remain to add) OR a custom attribute label (shown for the required ones). A tier whose definitions are all
 * required renders only labels; one whose definitions are all optional renders only the select.
 */
export const customAttributeEditor = (scope: Locator): Locator =>
    scope.getByTestId('select-selectAddCustomAttribute-trigger').or(scope.locator('label[for^="__attributes__custom"]')).first();

/**
 * Whether the tier defines any custom attribute for a resource (`users`, `groups`, `raProfiles`, …): `GET
 * /v1/attributes/custom/resources/<resource>` with the signed-in session. A failed read fails (it is no proof of "none").
 */
export async function customAttributesDefined(page: Page, resource: string): Promise<boolean> {
    const answer = await page.request.get(`/api/v1/attributes/custom/resources/${resource}`);
    expect(answer.status(), `GET /api/v1/attributes/custom/resources/${resource}`).toBe(200);
    const definitions: unknown = await answer.json();
    expect(Array.isArray(definitions), `the custom attribute definitions of ${resource} are a list`).toBe(true);
    return (definitions as unknown[]).length > 0;
}

/**
 * Fill every empty required custom attribute of a form. They render as `__attributes__custom…__.<name>` fields; in tabbed
 * forms they sit in a hidden "Custom Attributes" tab, which is opened first. Selects get their first option, inputs get
 * `value`. Returns the labels it filled.
 *
 * `definitionsExist` says whether the tier defines custom attributes for the form's resource (read it with
 * `customAttributesDefined`): only then the editor must render, and the wait for it is a hard expectation. A form of a
 * resource without definitions has no editor, so nothing is waited for.
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
