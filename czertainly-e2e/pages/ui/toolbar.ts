/**
 * toolbar — the toolbar buttons of a detail widget.
 *
 * Provides one map from the action a test names to the icon the admin UI renders, one button-state type and one
 * assertion over a set of buttons. The same icon means enable, approve or activate on different pages, so the decision
 * tables of the lifecycle specs read like the product rules. When the toolbar gets named test ids
 * (fe-administrator#2325), only the map changes.
 */
import { expect, Locator, Page } from '@playwright/test';
import { iconButton } from './widget';

/** Action → icon id of the toolbar button (`data-testid="<icon>-button"`). */
export const TOOLBAR_ICON = {
    issue: 'cubes',
    renew: 'retweet',
    rekey: 'rekey',
    revoke: 'minus-square',
    complete: 'check',
    archive: 'archive',
    unarchive: 'unarchive',
    edit: 'pencil',
    delete: 'trash',
    enable: 'check',
    disable: 'times',
    activate: 'check',
    deactivate: 'times',
    compromise: 'compromise',
    destroy: 'destroy',
    reload: 'reload',
    sync: 'refresh',
    random: 'random',
    usages: 'key',
} as const;

export type ToolbarButtonName = keyof typeof TOOLBAR_ICON;

/** The state a test expects of a button: shown and enabled, shown and disabled, or not rendered at all. */
export type ButtonState = 'enabled' | 'disabled' | 'absent';

/** The toolbar buttons of one widget, by action name. */
export class ToolbarButtons {
    constructor(readonly scope: Locator) {}

    button(name: ToolbarButtonName): Locator {
        return iconButton(this.scope, TOOLBAR_ICON[name]);
    }
}

/** The first `<icon>-button` in the page's main area (pages with one toolbar only; a widget scope is preferred). */
export const toolbarButton = (page: Page, icon: string): Locator => page.locator('main').getByTestId(`${icon}-button`).first();

/**
 * Asserts the state of each named button. `absent` means no such button is rendered; `enabled` / `disabled` also
 * require it to be visible. `buttons` is a `ToolbarButtons` or any lookup from a name to a button.
 */
export async function expectButtons<Name extends string>(
    buttons: ToolbarButtons | ((name: Name) => Locator),
    expected: Partial<Record<Name, ButtonState>>,
    label = 'toolbar',
): Promise<void> {
    const lookup = buttons instanceof ToolbarButtons ? (name: Name) => buttons.button(name as unknown as ToolbarButtonName) : buttons;
    for (const [name, state] of Object.entries(expected) as Array<[Name, ButtonState]>) {
        const button = lookup(name);
        if (state === 'absent') {
            await expect(button, `${label} ${name} absent`).toHaveCount(0);
            continue;
        }
        await expect(button, `${label} ${name}`).toBeVisible();
        if (state === 'enabled') await expect(button, `${label} ${name} enabled`).toBeEnabled();
        else await expect(button, `${label} ${name} disabled`).toBeDisabled();
    }
}
