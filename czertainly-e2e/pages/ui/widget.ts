/**
 * widget — widgets and their icon-only buttons.
 *
 * A widget is a section with a title heading. Icon buttons repeat on one page and have no accessible name, so a button
 * is always looked up inside its widget, never page-wide. The widget is the heading's closest enclosing section (the
 * one structural lookup of the suite; a widget test id would remove it, FE test-id request).
 */
import { Locator, Page } from '@playwright/test';
import { escapeRegExp } from '../../utils/regression/text';

/**
 * The widget (a `<section>`) whose title heading matches: the scope for icon-only buttons that repeat on one page. A
 * RegExp for titles that vary (`/^(Certificate|CSR) Properties$/`); a string matches the whole title.
 */
export function widgetTitled(scope: Locator | Page, title: string | RegExp): Locator {
    const name = typeof title === 'string' ? new RegExp(`^${escapeRegExp(title)}$`) : title;
    // The closest <section> around the title heading (widgets nest: an outer section holds every inner heading too).
    return scope.getByRole('heading', { name }).locator('xpath=ancestor::section[1]');
}

/** An icon-only toolbar button (`<icon>-button`) inside a widget (never a bare page-wide `.first()`). */
export const iconButton = (scope: Locator, icon: string): Locator => scope.getByTestId(`${icon}-button`);
