/**
 * RolePermissionsPage — the permissions editor of one role: resource actions, object-level permissions and Save (REG-CFG-08).
 * An object checkbox is clicked as an event, because the wrapper button around it stops the click. Save waits only for a write to the role
 * that `goToEditor` opened.
 */
import { expect, Locator, Page } from '@playwright/test';
import type { ApiAnswer } from '../utils/regression/apiReads';
import { setSwitch } from './ui/form';
import { actAndWaitForApi, answerFrom } from './ui/waitForResponse';

export interface SavedPermissions {
    answer: ApiAnswer;
    sent: { allowAllResources?: boolean; resources: Array<{ name: string; actions: string[]; objects?: Array<{ uuid: string; allow: string[] }> }> };
    sentText: string;
}

const ROLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RolePermissionsPage {
    readonly page: Page;
    readonly main: Locator;

    // Resources: the allow-all switch and the resource buttons (each opens its action checkboxes)
    readonly allResourcesSwitch: Locator;
    readonly certificatesResource: Locator;
    readonly raProfilesResource: Locator;

    // Object Action Permissions of the open resource
    /** The product gives this button no test id and no accessible name: the icon class is the handle. */
    readonly addObjectButton: Locator;

    // Edit Object Level Permissions dialog
    readonly objectPermissionsDialog: Locator;
    readonly objectDialogSaveButton: Locator;

    // Save
    readonly saveButton: Locator;

    /** The role uuid last opened by `goToEditor`; `save` accepts a write for this uuid only. */
    private roleUuid: string | undefined;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        this.allResourcesSwitch = page.locator('[id="allResources"]');
        this.certificatesResource = this.resource('Certificates');
        this.raProfilesResource = this.resource('Ra Profiles').or(this.resource('RA Profiles')).first();

        this.addObjectButton = this.main.getByRole('heading', { name: 'Object Action Permissions' }).locator('..').locator('button:has(svg.lucide-plus)').first();

        this.objectPermissionsDialog = page.getByRole('dialog', { name: 'Edit Object Level Permissions' });
        this.objectDialogSaveButton = this.objectPermissionsDialog.getByRole('button', { name: 'Save', exact: true });

        this.saveButton = this.main.getByTestId('progress-button').last();
    }

    resource(label: string): Locator {
        return this.main.getByRole('button').filter({ has: this.page.getByText(label, { exact: true }) }).first();
    }

    action(label: string): Locator {
        return this.main.getByLabel(label, { exact: true }).first();
    }

    objectRowCheckbox(objectName: string): Locator {
        return this.objectPermissionsDialog.locator('tr', { has: this.page.getByRole('cell', { name: objectName, exact: true }) }).getByRole('checkbox');
    }

    objectActionCheckbox(objectUuid: string, action: string): Locator {
        return this.page.locator(`[id="${objectUuid}_${action}"]`);
    }

    /** The uuid must be a live own role. */
    async goToEditor(roleUuid: string): Promise<void> {
        if (!ROLE_UUID.test(roleUuid)) {
            throw new Error(`RolePermissionsPage.goToEditor: role uuid is not a uuid: ${roleUuid}`);
        }
        this.roleUuid = roleUuid;
        await this.page.goto(`/administrator/#/roles/permissions/${roleUuid}`);
        await expect(this.certificatesResource).toBeVisible();
    }

    async assertAllResourcesOff(): Promise<void> {
        await expect(this.allResourcesSwitch).not.toBeChecked();
    }

    async openResource(resource: Locator): Promise<void> {
        await resource.click();
    }

    async allowActions(actions: readonly string[]): Promise<void> {
        for (const a of actions) await setSwitch(this.main, this.action(a), true);
    }

    async assertActionsChecked(actions: readonly string[]): Promise<void> {
        for (const a of actions) await expect(this.action(a), `${a} is ticked`).toBeChecked();
    }

    async addObject(objectName: string): Promise<void> {
        await this.addObjectButton.click();
        await expect(this.objectPermissionsDialog).toBeVisible();
        await this.objectRowCheckbox(objectName).check();
        await this.objectDialogSaveButton.click();
        await expect(this.objectPermissionsDialog).toBeHidden();
    }

    /** Each checkbox sits in a wrapper button that stops the click: the input gets the click. */
    async allowOnObject(objectUuid: string, actions: readonly string[]): Promise<void> {
        for (const a of actions) {
            const box = this.objectActionCheckbox(objectUuid, a);
            if (!(await box.isChecked())) await box.dispatchEvent('click');
            await expect(box, `${a} is ticked on the object`).toBeChecked();
        }
    }

    async screenshot(): Promise<Buffer> {
        return this.page.screenshot();
    }

    /**
     * Clicks Save and returns the answer with the body sent. Only a non-GET to
     * this role's permissions counts: another role's write is not this save.
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
