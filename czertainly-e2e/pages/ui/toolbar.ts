/**
 * toolbar — the state check of a set of toolbar buttons.
 *
 * Provides one button-state type and one assertion over a set of buttons, so the decision tables of the lifecycle specs
 * read like the product rules. The page objects keep their toolbar buttons as fields (`renewButton`, …) and hand
 * `expectButtons` a lookup from the action name to the field.
 */
import { expect, Locator } from '@playwright/test';

/** The state a test expects of a button: shown and enabled, shown and disabled, or not rendered at all. */
export type ButtonState = 'enabled' | 'disabled' | 'absent';

/**
 * Asserts the state of each named button. `absent` means no such button is rendered; `enabled` / `disabled` also
 * require it to be visible. `buttons` looks a button up by its name.
 */
export async function expectButtons<Name extends string>(
    buttons: (name: Name) => Locator,
    expected: Partial<Record<Name, ButtonState>>,
    label = 'toolbar',
): Promise<void> {
    for (const [name, state] of Object.entries(expected) as Array<[Name, ButtonState]>) {
        const button = buttons(name);
        if (state === 'absent') {
            await expect(button, `${label} ${name} absent`).toHaveCount(0);
            continue;
        }
        await expect(button, `${label} ${name}`).toBeVisible();
        if (state === 'enabled') await expect(button, `${label} ${name} enabled`).toBeEnabled();
        else await expect(button, `${label} ${name} disabled`).toBeDisabled();
    }
}
