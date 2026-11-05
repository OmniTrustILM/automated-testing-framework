/**
 * widget — the widget (a section with a title heading) a title names; icon buttons repeat on a page, so look them up inside their widget.
 */
import { Locator, Page } from '@playwright/test';
import { escapeRegExp } from '../../utils/regression/text';

/** A RegExp for titles that vary; a string matches the whole title. */
export function widgetTitled(scope: Locator | Page, title: string | RegExp): Locator {
    const name = typeof title === 'string' ? new RegExp(`^${escapeRegExp(title)}$`) : title;
    // Widgets nest: the closest section around the heading.
    return scope.getByRole('heading', { name }).locator('xpath=ancestor::section[1]');
}
