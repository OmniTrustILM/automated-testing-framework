/**
 * Widgets: the `<section>` of the admin UI that carries a title heading, and the icon-only buttons inside one. Icon
 * buttons carry `data-testid="<icon|id>-button"` and usually no accessible name, and the same icon repeats on one page
 * (`plus-button` / `pencil-button` on the RA profile detail), so a button is always looked up inside its widget.
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
