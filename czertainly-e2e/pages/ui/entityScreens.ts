/**
 * entityScreens — the list, dialogs and detail of one entity page, as one value.
 *
 * WHAT: for an entity whose pages follow the admin UI's pattern (a searchable list with a plus button, a detail widget
 *       with edit and delete icons, `Create <X>` / `Edit <X>` / `Delete <X>` dialogs) it returns the list widget, the
 *       three dialogs, the detail widget and the acts `goToList`, `reloadList`, `goToDetail`, `openCreateDialog`,
 *       `openEditDialog`, `deleteFromDetail` and `assertNotListed`.
 * WHY: the role and user pages (and the notification pages) had the same orchestration written twice, including the
 *       rule learnt on a live tier that a hash-only `goto` is no navigation. Composition, not a base class: the pages keep
 *       their own forms and assertions, and an entity with a split create flow is not forced into a shape.
 * HOW: one spec of five names (`route`, `listTitle`, `detailTitle`, `caption`) builds everything; `reloadList` loads the
 *       hash route, reloads, and only then waits for the widget, because waiting first would wait on the old render;
 *       `deleteFromDetail` returns the answer of the delete request the caller names.
 */
import { expect, Locator, Page } from '@playwright/test';
import { ApiAnswer } from '../../utils/regression/apiReads';
import { ConfirmDeleteDialog } from '../ConfirmDeleteDialog';
import { FormDialog } from '../FormDialog';
import { SearchableListWidget } from '../SearchableListWidget';
import { ApiCall } from './waitForResponse';
import { iconButton, widgetTitled } from './widget';

export interface EntityScreensSpec {
    /** The hash route of the entity: `roles` for `#/roles` and `#/roles/detail/<uuid>`. */
    route: string;
    /** The title of the list widget (`List of Roles`). */
    listTitle: string;
    /** The title of the detail widget (`Role Details`). */
    detailTitle: string;
    /** The noun of the dialogs (`Role` for `Create Role`, `Edit Role`, `Delete Role`). */
    caption: string;
}

export interface EntityScreens {
    readonly list: SearchableListWidget;
    readonly createDialog: FormDialog;
    readonly editDialog: FormDialog;
    readonly deleteDialog: ConfirmDeleteDialog;
    /** The detail widget (the shown entity's rows and its toolbar). */
    readonly detailsWidget: Locator;
    goToList(): Promise<void>;
    reloadList(): Promise<void>;
    goToDetail(uuid: string): Promise<void>;
    /** Plus button of the list → the Create dialog is open; returns the dialog. */
    openCreateDialog(): Promise<Locator>;
    /** Pencil of the detail → the Edit dialog is open; returns the dialog. */
    openEditDialog(): Promise<Locator>;
    /** Trash of the detail → the Delete dialog → Delete; returns the answer of the delete request `call` describes. */
    deleteFromDetail(call: ApiCall): Promise<ApiAnswer>;
    /** The list, searched by name, has no row of that name, after the list showed its rows. */
    assertNotListed(name: string, options?: { loadTimeout?: number }): Promise<void>;
}

export function entityScreens(page: Page, spec: EntityScreensSpec): EntityScreens {
    const list = new SearchableListWidget(page, spec.listTitle);
    const createDialog = new FormDialog(page, `Create ${spec.caption}`);
    const editDialog = new FormDialog(page, `Edit ${spec.caption}`);
    const deleteDialog = new ConfirmDeleteDialog(page, `Delete ${spec.caption}`);
    const detailsWidget = widgetTitled(page.locator('main'), spec.detailTitle);
    const listUrl = `administrator/#/${spec.route}`;
    return {
        list,
        createDialog,
        editDialog,
        deleteDialog,
        detailsWidget,
        async goToList() {
            await page.goto(listUrl);
            await expect(list.root).toBeVisible();
        },
        async reloadList() {
            // A `goto` that only repeats or changes the hash is no navigation: the document stays, and with it an earlier,
            // possibly stale render. The reload comes before the wait.
            await page.goto(listUrl);
            await page.reload();
            await expect(list.root).toBeVisible();
        },
        async goToDetail(uuid) {
            await page.goto(`${listUrl}/detail/${uuid}`);
            await expect(detailsWidget).toBeVisible();
        },
        async openCreateDialog() {
            await iconButton(list.root, 'plus').click();
            await expect(createDialog.dialog).toBeVisible();
            return createDialog.dialog;
        },
        async openEditDialog() {
            await iconButton(detailsWidget, 'pencil').click();
            await expect(editDialog.dialog).toBeVisible();
            return editDialog.dialog;
        },
        async deleteFromDetail(call) {
            await iconButton(detailsWidget, 'trash').click();
            return deleteDialog.confirm(call);
        },
        assertNotListed: (name, options = {}) => list.assertNotListed(name, options),
    };
}
