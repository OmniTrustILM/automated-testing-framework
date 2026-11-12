/**
 * CustomAttributesPage — the Custom Attributes list, its Create dialog and the delete-by-search flow.
 *
 * WHAT: the Custom Attributes list page under Settings, the Create Custom Attribute dialog (name, label, content type, resources)
 *       and the search that finds an attribute by name so that it can be deleted.
 * WHY: SMK-008 drives the whole lifecycle of a custom attribute (create, assign, unassign, delete); the locators stay here so
 *      that the smoke spec reads as the steps of the flow. The smoke suite calls these methods by name: they keep their
 *      names and their behaviour.
 * HOW: locators are fields built in the constructor, by test id where the admin UI has one; the selects go through the Select
 *      helper (their trigger buttons). Never used by the regression suite.
 */

import { Page, Locator, expect } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { chooseOption, chooseOptions, selectOfTrigger } from './ui/select';

const logger = new Logger('CustomAttributesPage');

export class CustomAttributesPage {
    readonly page: Page;
    readonly main: Locator;

    // List page
    readonly plusButton: Locator;
    readonly searchInput: Locator;
    readonly trashButton: Locator;

    // Create modal
    readonly createModal: Locator;
    readonly nameInput: Locator;
    readonly labelInput: Locator;
    readonly resourcesTrigger: Locator;
    readonly contentTypeTrigger: Locator;
    readonly submitButton: Locator;

    // Delete confirm dialog
    readonly deleteConfirmDialog: Locator;
    readonly deleteConfirmButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.main = page.locator('main');

        // List page
        this.plusButton = this.main.getByTestId('plus-button');
        this.searchInput = this.main.locator('#search');
        this.trashButton = this.main.getByTestId('trash-button');

        // Create modal — dialog scoped by its heading
        this.createModal = page.getByRole('dialog').filter({ hasText: 'Create Custom Attribute' });
        this.nameInput = this.createModal.getByTestId('text-input-name');
        this.labelInput = this.createModal.getByTestId('text-input-label');
        this.resourcesTrigger = this.createModal.getByTestId('select-resourcesSelect-trigger');
        this.contentTypeTrigger = this.createModal.getByTestId('select-contentType-trigger');
        this.submitButton = this.createModal.getByTestId('progress-button');

        // Delete confirm dialog scoped by its heading
        this.deleteConfirmDialog = page.getByRole('dialog').filter({ hasText: 'Delete a Custom Attribute' });
        this.deleteConfirmButton = this.deleteConfirmDialog.getByRole('button', { name: 'Delete', exact: true });
    }

    async goToList(): Promise<void> {
        logger.info('Navigating to Custom Attributes list');
        await this.page.goto('/administrator/#/customattributes');
        await expect(this.main).toBeVisible();
    }

    async openCreateModal(): Promise<void> {
        logger.info('Opening Create Custom Attribute modal');
        await this.plusButton.click();
        await expect(this.createModal).toBeVisible();
    }

    async fillAndSubmitCreate(opts: {
        name: string;
        label: string;
        resource: string;
        contentType: string;
    }): Promise<void> {
        logger.info(`Creating custom attribute: name=${opts.name}, label=${opts.label}, resource=${opts.resource}, contentType=${opts.contentType}`);
        await this.nameInput.click();
        await this.nameInput.fill(opts.name);
        await this.labelInput.click();
        await this.labelInput.fill(opts.label);
        // Multi-select stays open after an option click: chooseOptions closes it with Escape
        await chooseOptions(this.page, selectOfTrigger(this.page, this.resourcesTrigger), [opts.resource]);
        await chooseOption(this.page, this.contentTypeTrigger, opts.contentType);
        await chooseOption(this.page, this.contentTypeTrigger, opts.contentType);
        await this.submitButton.click();
        await expect(this.createModal).not.toBeVisible();
    }

    async deleteByName(name: string): Promise<void> {
        logger.info(`Deleting custom attribute by name: ${name}`);
        await this.searchInput.fill(name);
        // Find the data row containing our attribute name (excludes header row)
        const row = this.main.locator('tr').filter({ hasText: name });
        await expect(row).toBeVisible();
        await row.getByTestId('checkbox').click();

        await this.trashButton.click();
        await expect(this.deleteConfirmDialog).toBeVisible();

        await this.deleteConfirmButton.click();
        await expect(this.deleteConfirmDialog).not.toBeVisible();
    }
}