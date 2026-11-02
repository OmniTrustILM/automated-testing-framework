/**
 * RolePermissionsPage — the permissions editor of one role (REG-CFG-08).
 *
 * Encapsulates:
 *   - the editor opened from a role: resources with their action checkboxes
 *   - the object-level permissions of a resource, and Save, returning the answer and the body sent
 *
 * An object-level permission must not widen to the whole resource (fe-administrator#2283). An object checkbox is clicked
 * as an event, because the wrapper button around it stops the propagation of a click. Save waits only for a write to the
 * same role uuid that `goToEditor` opened (the browser is not behind the API guard).
 */
import { expect, Locator, Page } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { setSwitch } from './ui/form';
import { actAndWaitForApi, answerFrom } from './ui/waitForResponse';

/** What a save sent and what the platform answered. */
export interface SavedPermissions {
    answer: ApiAnswer;
    /** The JSON body of the save request: `{ allowAllResources, resources: [{ name, actions, objects }] }`. */
    sent: { allowAllResources?: boolean; resources: Array<{ name: string; actions: string[]; objects?: Array<{ uuid: string; allow: string[] }> }> };
    /** The request body as text, for an attachment. */
    sentText: string;
}

const ROLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RolePermissionsPage {
    readonly page: Page;
    readonly main: Locator;

    // Resources: the allow-all switch and the resource buttons (each opens its action checkboxes)
    readonly allResourcesSwitch: Locator;
    readonly certificatesResource: Locator;
    /** The RA profile resource, whose label is spelled either way. */
    readonly raProfilesResource: Locator;

    // Object Action Permissions of the open resource
    /** The product gives this button no test id and no accessible name (a tooltip only): the icon class is the handle. */
    readonly addObjectButton: Locator;

    // Edit Object Level Permissions dialog
    readonly objectPermissionsDialog: Locator;
    readonly objectDialogSaveButton: Locator;

    // Save
    readonly saveButton: Locator;

    /** The role uuid last opened by `goToEditor` (the only uuid `save` will accept a write for). */
    private roleUuid: string | undefined;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // Resources: the allow-all switch and the resource buttons (each opens its action checkboxes)
        this.allResourcesSwitch = page.locator('[id="allResources"]');
        this.certificatesResource = this.resource('Certificates');
        this.raProfilesResource = this.resource('Ra Profiles').or(this.resource('RA Profiles')).first();

        // Object Action Permissions of the open resource
        this.addObjectButton = this.main.getByRole('heading', { name: 'Object Action Permissions' }).locator('..').locator('button:has(svg.lucide-plus)').first();

        // Edit Object Level Permissions dialog
        this.objectPermissionsDialog = page.getByRole('dialog', { name: 'Edit Object Level Permissions' });
        this.objectDialogSaveButton = this.objectPermissionsDialog.getByRole('button', { name: 'Save', exact: true });

        // Save
        this.saveButton = this.main.getByTestId('progress-button').last();
    }

    /** The resource's button (opens its actions). */
    resource(label: string): Locator {
        return this.main.getByRole('button').filter({ has: this.page.getByText(label, { exact: true }) }).first();
    }

    /** The action checkbox of the open resource. */
    action(label: string): Locator {
        return this.main.getByLabel(label, { exact: true }).first();
    }

    /** The checkbox of an object's row in the Edit Object Level Permissions dialog. */
    objectRowCheckbox(objectName: string): Locator {
        return this.objectPermissionsDialog.locator('tr', { has: this.page.getByRole('cell', { name: objectName, exact: true }) }).getByRole('checkbox');
    }

    /** The checkbox of one action on one object. */
    objectActionCheckbox(objectUuid: string, action: string): Locator {
        return this.page.locator(`[id="${objectUuid}_${action}"]`);
    }

    /** Opens the editor of a role and waits for the resource list. The uuid must be a live own role (the spec's `live` check). */
    async goToEditor(roleUuid: string): Promise<void> {
        if (!ROLE_UUID.test(roleUuid)) {
            throw new Error(`RolePermissionsPage.goToEditor: role uuid is not a uuid: ${roleUuid}`);
        }
        this.roleUuid = roleUuid;
        await this.page.goto(`/administrator/#/roles/permissions/${roleUuid}`);
        await expect(this.certificatesResource).toBeVisible();
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
        await this.addObjectButton.click();
        await expect(this.objectPermissionsDialog).toBeVisible();
        await this.objectRowCheckbox(objectName).check();
        await this.objectDialogSaveButton.click();
        await expect(this.objectPermissionsDialog).toBeHidden();
    }

    /** Ticks the actions of one object (each checkbox sits in a wrapper button that stops the propagation: the input gets the click). */
    async allowOnObject(objectUuid: string, actions: readonly string[]): Promise<void> {
        for (const a of actions) {
            const box = this.objectActionCheckbox(objectUuid, a);
            if (!(await box.isChecked())) await box.dispatchEvent('click');
            await expect(box, `${a} is ticked on the object`).toBeChecked();
        }
    }

    /** The editor as a picture (the object rows), for an attachment. */
    async screenshot(): Promise<Buffer> {
        return this.page.screenshot();
    }

    /**
     * Clicks Save and returns the answer of the save request together with the body it sent; the stored state is read after it.
     * Only a non-GET to `/api/v1/roles/<this role>/permissions` counts: a frontend bug that wrote another role's permissions
     * would leave this wait unmatched (and must not be treated as this save).
     */
    async save(): Promise<SavedPermissions> {
        const roleUuid = this.roleUuid;
        if (!roleUuid) {
            throw new Error('RolePermissionsPage.save: goToEditor must open a live own role before Save');
        }
        const startedAt = Date.now();
        const pathOfOwnRole = new RegExp(`/api/v1/roles/${roleUuid}/permissions(?:\\?|$)`);
        const response = await actAndWaitForApi(
            this.page,
            { method: (m) => m !== 'GET', path: pathOfOwnRole },
            () => this.saveButton.click(),
        );
        const pathname = new URL(response.url()).pathname;
        if (!pathname.includes(`/roles/${roleUuid}/permissions`)) {
            throw new Error(`RolePermissionsPage.save: expected a write to role ${roleUuid}, got ${pathname}`);
        }
        const sentText = response.request().postData() ?? '';
        return { answer: await answerFrom(response, startedAt), sent: JSON.parse(sentText || '{"resources":[]}'), sentText };
    }
}
