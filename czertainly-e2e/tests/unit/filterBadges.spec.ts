/**
 * filterBadges against the badge markup of the admin UI since fe-administrator#2425 (FilterWidget getBadgeContent,
 * FilterValueChips): a list value is one chip per value, a single value stays inside the toggle button.
 */
import { expect, test } from '@playwright/test';
import { filterBadges } from '../../pages/ui/list';

const removeBadge = '<button type="button"><span class="sr-only">Remove badge</span></button>';
const chip = (value: string, filter: string) =>
    `<span data-testid="filter-value-chip">${value}<button type="button" aria-label="Remove ${value} from ${filter}"></button></span>`;

test('a list value is read from its chips, a single value from the toggle button; a badge without remove is not a filter', async ({ page }) => {
    await page.setContent(`<main>
        <span data-testid="badge"><button type="button"><b>Property&nbsp;</b>'State'&nbsp;equals</button>
            <span>${chip('Issued', 'State')}</span>${removeBadge}</span>
        <span data-testid="badge"><button type="button"><b>Property&nbsp;</b>'Owner'&nbsp;equals</button>
            <span>${chip('Alice', 'Owner')}${chip('Bob', 'Owner')}</span>${removeBadge}</span>
        <span data-testid="badge"><button type="button"><b>Property&nbsp;</b>'Common Name'&nbsp;contains&nbsp;'qa-run'</button>${removeBadge}</span>
        <span data-testid="badge">No</span>
    </main>`);
    expect(await filterBadges(page)).toEqual([
        "Property 'State' equals 'Issued'",
        "Property 'Owner' equals 'Alice OR Bob'",
        "Property 'Common Name' contains 'qa-run'",
    ]);
});
