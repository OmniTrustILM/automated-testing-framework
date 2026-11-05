/**
 * toolbar — the state check of a set of toolbar buttons, for the decision tables of the lifecycle specs.
 */
import { expect, Locator } from '@playwright/test';

export type ButtonState = 'enabled' | 'disabled' | 'absent';

/** `absent` means no such button is rendered; `enabled` / `disabled` also require it to be visible. */
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
