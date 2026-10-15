/**
 * RegressionUi — small UI helpers shared by the REG-* specs (custom Select, toolbar icons, dialogs, filters, toasts).
 *
 * The admin UI's Select is a Radix popover: a trigger button (aria-haspopup="listbox") inside a
 * `select-*` wrapper next to its <label>, options are role="option". Toolbar icon buttons carry
 * data-testid `<icon|id>-button` and usually no accessible name.
 */
import { expect, Locator, Page } from '@playwright/test';
import { Logger } from '../utils/Logger';

const logger = new Logger('RegressionUi');

/** Trigger of the Select whose label matches (wrapper with the label first, else the first trigger after the label). */
export function selectTrigger(scope: Locator, label: string | RegExp): Locator {
    const wrapped = scope
        .locator('div[data-testid^="select-"]')
        .filter({ has: scope.page().locator('label').filter({ hasText: label }) })
        .locator('button[aria-haspopup="listbox"]');
    const following = scope.locator('label').filter({ hasText: label }).first().locator('xpath=following::button[@aria-haspopup="listbox"][1]');
    return wrapped.or(following).first();
}

/** Open a Select and click the option: exact name first (so "x-ra" never picks "x-ra-2"), else the first containing it. */
export async function chooseOption(page: Page, trigger: Locator, option: string | RegExp): Promise<string> {
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const listbox = page.getByRole('listbox').last();
    await expect(listbox.getByRole('option').first()).toBeVisible();
    let opt = typeof option === 'string' ? listbox.getByRole('option', { name: option, exact: true }) : listbox.getByRole('option').filter({ hasText: option });
    if (typeof option === 'string' && !(await opt.count())) opt = listbox.getByRole('option').filter({ hasText: option });
    opt = opt.first();
    await expect(opt).toBeVisible();
    const text = (await opt.innerText()).trim();
    await opt.click();
    await expect(listbox).toBeHidden();
    logger.debug(`chose "${text}"`);
    return text;
}

export async function chooseByLabel(page: Page, scope: Locator, label: string | RegExp, option: string | RegExp): Promise<string> {
    return chooseOption(page, selectTrigger(scope, label), option);
}

export const toolbarButton = (page: Page, icon: string): Locator => page.locator('main').getByTestId(`${icon}-button`).first();

/**
 * The widget (a `<section>`) whose title heading matches (phase-04 A1): the scope for icon-only buttons that repeat on
 * one page (`plus-button` / `pencil-button` on the RA profile detail, Edit / Delete on role and user details). A RegExp
 * for titles that vary (`/^(Certificate|CSR) Properties$/`).
 */
export function widget(scope: Locator | Page, title: string | RegExp): Locator {
    const name = typeof title === 'string' ? new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : title;
    // The closest <section> around the title heading (widgets nest: an outer section holds every inner heading too).
    return scope.getByRole('heading', { name }).locator('xpath=ancestor::section[1]');
}

/** An icon-only toolbar button (`<icon>-button`, phase-04 A2) inside a widget (never a bare page-wide `.first()`). */
export const iconButton = (scope: Locator, icon: string): Locator => scope.getByTestId(`${icon}-button`);

/** The top-most open dialog. */
export const topDialog = (page: Page): Locator => page.getByRole('dialog').last();

/**
 * Fill every empty required custom attribute of a form (some tiers define required custom attributes on groups,
 * users, …). They render as `__attributes__custom…__.<name>` fields; in tabbed forms they sit in a hidden
 * "Custom Attributes" tab, which is opened first. Selects get their first option, inputs get `value`.
 */
export async function fillRequiredCustomAttributes(page: Page, scope: Locator, value: string): Promise<string[]> {
    const tab = scope.getByRole('tab', { name: /^Custom attributes$/i }).first();
    if (await tab.isVisible().catch(() => false)) await tab.click();
    // The custom attribute editor renders after its definitions load; its "Show custom attribute" select marks it ready.
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

/** TextInputs are readonly until focused (anti-autofill): click, then fill. */
export async function fillText(input: Locator, value: string): Promise<void> {
    await input.click();
    await input.fill(value);
}

/** The form's submit (ProgressButton, data-testid progress-button: "Create", "Save", …). */
export const submitButton = (scope: Locator): Locator => scope.getByTestId('progress-button').last();

/** Inventory filter widget: Source → Field → Condition → value → Add. The value box is readonly until focused. */
export async function addInventoryTextFilter(page: Page, field: string, condition: string, value: string): Promise<void> {
    const main = page.locator('main');
    await chooseByLabel(page, main, 'Filter Field Source', 'Property');
    await chooseByLabel(page, main, /^Filter Field$/, field);
    await chooseByLabel(page, main, 'Filter Condition', condition);
    const input = main.getByTestId('text-input-valueSelect');
    await input.click();
    await input.pressSequentially(value);
    await main.getByRole('button', { name: 'Add', exact: true }).click();
}

/** Filter badges shown above a list ("Property 'Common Name' contains 'x'"), without the trailing "Remove badge". */
export async function filterBadges(page: Page): Promise<string[]> {
    const raw = await page.locator('main').getByRole('button', { name: /Remove badge$/ }).allInnerTexts();
    // The inner "Remove badge" button matches too and leaves an empty string: drop those.
    return raw.map((t) => t.replace(/\s*Remove badge$/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Toasts (fe-administrator Alerts): every card is `data-testid="alert-<id>"` (message in `alert-message-<id>`). Only
 * danger toasts carry role="alert" and stay until dismissed; success and info toasts have no role, vanish after 6 s and
 * are mirrored into the persistent live region `alerts-announcer`. Test ids, not role queries: while a modal dialog is
 * open the toasts outside it are aria-hidden. Assert a success toast in the same step as its action, or better through
 * `assertAnnounced` (the region keeps the newest message), and prefer the API read-back as the oracle.
 */
const toastCards = (page: Page): Locator => page.getByTestId(/^alert-\d+$/);

/** The first toast card whose text matches (any severity). */
export const toast = (page: Page, text: RegExp | string): Locator => toastCards(page).filter({ hasText: text }).first();

/** A toast with the text is shown; `severity` also checks the role (danger: role=alert; success / info: no role). */
export async function assertToast(
    page: Page,
    text: RegExp | string,
    opts: { severity?: 'danger' | 'success' | 'info'; timeout?: number } = {},
): Promise<Locator> {
    const card = toast(page, text);
    await expect(card, `toast ${String(text)}`).toBeVisible({ timeout: opts.timeout });
    if (opts.severity === 'danger') await expect(card).toHaveAttribute('role', 'alert');
    else if (opts.severity) await expect(card).not.toHaveAttribute('role', 'alert');
    return card;
}

/** The live region announced the message (success / info toasts; it keeps the newest one). A string must match fully. */
export async function assertAnnounced(page: Page, text: RegExp | string, timeout?: number): Promise<void> {
    await expect(page.getByTestId('alerts-announcer')).toHaveText(text, { timeout });
}

/** Close every toast: "Dismiss all" when the stack offers it, else each card's own Dismiss button. */
export async function dismissToasts(page: Page): Promise<void> {
    const dismissAll = page.getByTestId('alerts-container').locator('button', { hasText: /^Dismiss all$/ });
    if (await dismissAll.isVisible().catch(() => false)) await dismissAll.click().catch(() => {});
    const buttons = toastCards(page).locator('button[aria-label="Dismiss"]');
    for (let i = (await buttons.count()) - 1; i >= 0; i--) await buttons.nth(i).click().catch(() => {});
    try {
        await expect(toastCards(page)).toHaveCount(0, { timeout: 5000 });
    } catch {
        // Not a failure of the step that called it, but a toast left over can cover the next control: say so.
        logger.warn(`dismissToasts: ${await toastCards(page).count().catch(() => -1)} toast(s) could not be dismissed within 5 s`);
    }
}

/** Wait until a list table shows real rows (it renders skeleton rows first). */
export async function waitForListRows(page: Page): Promise<void> {
    await expect(page.locator('main table tbody tr a[href*="/detail/"]').first()).toBeVisible({ timeout: 30_000 });
}
