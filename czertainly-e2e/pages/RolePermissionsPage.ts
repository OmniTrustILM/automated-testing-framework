/**
 * RolePermissionsPage — the permissions editor of one role.
 *
 * WHAT: the editor opened from a role (`#/roles/permissions/<uuid>`): the resources with their action checkboxes, the object-level
 *       permissions of a resource (add an object, allow actions on it), and Save with the request it sends.
 * WHY: REG-CFG-08 grants resource-level and object-level permissions and compares what the editor sends and shows with what the
 *      platform stores; an object-level permission must not widen to the whole resource (fe-administrator#2283). `save` returns
 *      the answer and the body sent, so the spec asserts the request and then the stored state.
 * HOW: a resource by the button that carries its label (the label spells "Ra Profiles" or "RA Profiles"), an action by its
 *      checkbox label inside the resource; an object checkbox by its id `<object uuid>_<action>` is clicked as an event, because
 *      the wrapper button around it stops the propagation of a click; Save waits for the request that is not a read.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { setSwitch, submitButtonOf } from './ui/form';
import { actAndWaitForApi, answerFrom, UUID } from './ui/waitForResponse';

/** What a save sent and what the platform answered. */
export interface SavedPermissions {
    answer: ApiAnswer;
    /** The JSON body of the save request: `{ allowAllResources, resources: [{ name, actions, objects }] }`. */
    sent: { allowAllResources?: boolean; resources: Array<{ name: string; actions: string[]; objects?: Array<{ uuid: string; allow: string[] }> }> };
    /** The request body as text, for an attachment. */
    sentText: string;
}

export class RolePermissionsPage {
    readonly page: Page;
    readonly main: Locator;
    readonly allResourcesSwitch: Locator;
    /** The RA profile resource, whose label is spelled either way. */
    readonly raProfilesResource: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');
        this.allResourcesSwitch = page.locator('[id="allResources"]');
        this.raProfilesResource = this.resource('Ra Profiles').or(this.resource('RA Profiles')).first();
    }

    /** Opens the editor of a role and waits for the resource list. */
    async goToEditor(roleUuid: string): Promise<void> {
        await this.page.goto(`administrator/#/roles/permissions/${roleUuid}`);
        await expect(this.resource('Certificates')).toBeVisible();
    }

    /** The resource's button (opens its actions). */
    resource(label: string): Locator {
        return this.main.getByRole('button').filter({ has: this.page.getByText(label, { exact: true }) }).first();
    }

    /** The action checkbox of the open resource. */
    action(label: string): Locator {
        return this.main.getByLabel(label, { exact: true }).first();
    }

    /** The "allow all resources" switch is off (a role starts without it). */
    async assertAllResourcesOff(): Promise<void> {
        await expect(this.allResourcesSwitch).not.toBeChecked();
    }

    /** Opens the resource (its actions show). */
    async openResource(resource: Locator): Promise<void> {
        await resource.click();
    }

    /** Ticks each action of the open resource (resource level) and proves that it is ticked. */
    async allowActions(actions: readonly string[]): Promise<void> {
        for (const a of actions) await setSwitch(this.main, this.action(a), true);
    }

    /** Every action is ticked in the open resource. */
    async assertActionsChecked(actions: readonly string[]): Promise<void> {
        for (const a of actions) await expect(this.action(a), `${a} is ticked`).toBeChecked();
    }

    /** The open resource's "Add object" button (an icon only) → the object-level dialog → the object's row ticked → Save. */
    async addObject(objectName: string): Promise<void> {
        const heading = this.main.getByRole('heading', { name: 'Object Action Permissions' });
        // The product gives this button no test id and no accessible name (a tooltip only): the icon class is the handle.
        await heading.locator('..').locator('button:has(svg.lucide-plus)').first().click();
        const dialog = this.page.getByRole('dialog', { name: 'Edit Object Level Permissions' });
        await expect(dialog).toBeVisible();
        await dialog.locator('tr', { has: this.page.getByRole('cell', { name: objectName, exact: true }) }).getByRole('checkbox').check();
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).toBeHidden();
    }

    /** Ticks the actions of one object (each checkbox sits in a wrapper button that stops the propagation: the input gets the click). */
    async allowOnObject(objectUuid: string, actions: readonly string[]): Promise<void> {
        for (const a of actions) {
            const box = this.page.locator(`[id="${objectUuid}_${a}"]`);
            if (!(await box.isChecked())) await box.dispatchEvent('click');
            await expect(box, `${a} is ticked on the object`).toBeChecked();
        }
    }

    /** The editor as a picture (the object rows), for an attachment. */
    async screenshot(): Promise<Buffer> {
        return this.page.screenshot();
    }

    /** Clicks Save and returns the answer of the save request together with the body it sent; the stored state is read after it. */
    async save(): Promise<SavedPermissions> {
        const startedAt = Date.now();
        const response = await actAndWaitForApi(this.page, { method: (m) => m !== 'GET', path: new RegExp(`/api/v1/roles/${UUID}/permissions`) }, () => submitButtonOf(this.main).click());
        const sentText = response.request().postData() ?? '';
        return { answer: await answerFrom(response, startedAt), sent: JSON.parse(sentText || '{"resources":[]}'), sentText };
    }
}
