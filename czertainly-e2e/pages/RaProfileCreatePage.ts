/**
 * RaProfileCreatePage — the "Create RA Profile" dialog of the RA profile list (fe-administrator
 * `_pages/ra-profiles/list/index.tsx` + `form/index.tsx`), for REG-CERT-68: create with a REQUIRED connector attribute
 * left empty and see the validation message. A small page object of its own; `pages/RaProfilePage.ts` (the detail page) is
 * not touched — merging this class into it is optional and cosmetic.
 *
 * What the form does (origin/main): the list's `plus-button` opens the dialog "Create RA Profile": a name box
 * (`text-input-name`), a Select "Select Authority" (`select-authoritySelect-trigger`), the tab "Connector Attributes"
 * with the authority's RA-profile attribute editor (`AttributeEditor id="ra-profile"`: a required attribute is a label
 * ending in " *" for the field `__attributes__ra-profile__.<name>`, an input with the test id
 * `text-input-<field>` or a Select with `select-<field>Select-trigger`), and `Create` (a ProgressButton, `progress-button`).
 * Validation is client-side (react-hook-form): while a required attribute is empty the form is invalid and `Create` is
 * DISABLED; an input shows the red text "Required Field" under it once it was left (touched); a Select reports no blur,
 * so it shows no text before a submit that cannot happen. If a refusal does reach core, the 422 messages come back in a
 * danger toast "Failed to create RA profile (422): Required attribute <label> not found.".
 *
 * Nothing here chooses to submit a form it knows is valid: `submitIfEnabled` clicks `Create` only when the form lets it
 * (it then returns the response, so a spec can record what an accidental success created BEFORE it fails).
 */
import { expect, Locator, Page, Response } from '@playwright/test';
import { Logger } from '../utils/Logger';
import { chooseOption, fillText, submitButton, toast, toolbarButton } from './RegressionUi';

const logger = new Logger('RaProfileCreatePage');

type Json = Record<string, any>;

/** A required, writable data attribute of an authority's RA-profile schema (`GET /v1/authorities/{uuid}/attributes/raProfile`). */
export interface RequiredAttribute {
    name: string;
    label: string;
    contentType: string;
    /** The attribute offers a list / callback: the form renders a Select. */
    select: boolean;
}

/**
 * The required attributes a RA-profile schema declares (pure): data attributes with `properties.required`, not read-only,
 * visible. v2 / v3 attributes alike (`properties` carries the flags in both). The label falls back to the name.
 */
export function requiredRaProfileAttributes(schema: Json[] | undefined): RequiredAttribute[] {
    return (schema ?? [])
        .filter((a) => (!a.type || a.type === 'data') && a.properties?.required === true && a.properties?.readOnly !== true && a.properties?.visible !== false)
        .map((a) => ({
            name: String(a.name),
            label: String(a.properties?.label ?? a.name),
            contentType: String(a.contentType ?? 'string'),
            select: a.properties?.list === true || (Array.isArray(a.content) && a.content.length > 0) || !!a.attributeCallback,
        }));
}

export interface AuthorityChoice {
    uuid: string;
    name: string;
    required: RequiredAttribute[];
}

/**
 * The order authorities are tried in (pure): the run's own authority first when it is given, then every CONNECTED one in
 * list order. A disconnected authority is never chosen (its connector cannot answer the schema).
 */
export function authorityCandidates(authorities: Array<{ uuid: string; name: string; status?: string }>, ownAuthorityUuid?: string): Array<{ uuid: string; name: string }> {
    return [...authorities.filter((a) => a.uuid === ownAuthorityUuid), ...authorities.filter((a) => a.uuid !== ownAuthorityUuid && a.status === 'connected')].map((a) => ({ uuid: a.uuid, name: a.name }));
}

/**
 * Which authority to open the form with: the first candidate whose RA-profile schema (read through `schemaOf`, read-only; a
 * schema that cannot be read is `undefined`) declares a required attribute. Undefined when none qualifies. Schemas are read
 * lazily, one authority at a time, so a long list costs nothing once an authority qualifies.
 */
export async function chooseAuthorityWithRequiredAttribute(
    authorities: Array<{ uuid: string; name: string; status?: string }>,
    schemaOf: (authorityUuid: string) => Promise<Json[] | undefined>,
    ownAuthorityUuid?: string,
): Promise<AuthorityChoice | undefined> {
    for (const a of authorityCandidates(authorities, ownAuthorityUuid)) {
        const required = requiredRaProfileAttributes(await schemaOf(a.uuid));
        if (required.length) return { uuid: a.uuid, name: a.name, required };
    }
    return undefined;
}

/** What `submitIfEnabled` did. */
export type SubmitOutcome = { sent: false } | { sent: true; response: Response };

export class RaProfileCreatePage {
    readonly page: Page;
    readonly dialog: Locator;

    constructor(page: Page) {
        this.page = page;
        this.dialog = page.getByRole('dialog', { name: 'Create RA Profile' });
    }

    /** RA Profiles → "+" → the dialog. */
    async open(): Promise<void> {
        logger.info('Opening Create RA Profile');
        await this.page.goto('administrator/#/raprofiles');
        await toolbarButton(this.page, 'plus').click();
        await expect(this.dialog).toBeVisible();
    }

    async fillName(name: string): Promise<void> {
        await fillText(this.dialog.getByTestId('text-input-name'), name);
    }

    /** Picks the authority by its exact name; the form then loads its RA-profile attributes. */
    async chooseAuthority(authorityName: string): Promise<void> {
        await chooseOption(this.page, this.page.getByTestId('select-authoritySelect-trigger'), authorityName);
        await expect(this.dialog.getByRole('tab', { name: 'Connector Attributes' })).toBeEnabled();
    }

    /** The required connector attributes the form shows: label text (without the " *") and the field id the label points at. */
    async requiredFields(): Promise<Array<{ label: string; field: string }>> {
        const labels = this.dialog.locator('label[for^="__attributes__ra-profile__"]').filter({ hasText: /\*\s*$/ });
        await expect(labels.first(), 'the form shows a required connector attribute').toBeVisible({ timeout: 30_000 });
        const out: Array<{ label: string; field: string }> = [];
        for (const l of await labels.all()) {
            out.push({ label: (await l.innerText()).replace(/\s*\*\s*$/, '').trim(), field: (await l.getAttribute('for'))! });
        }
        return out;
    }

    /** The control of a required field: its Select trigger or its input. */
    private control(field: string): Locator {
        return this.page.getByTestId(`select-${field}-trigger`).or(this.dialog.locator(`[id="${field}"]`)).first();
    }

    /** Leaves a required INPUT empty after focusing it (react-hook-form marks it touched on blur, which shows "Required Field"). A Select has no blur to give. */
    async leaveEmpty(field: string): Promise<'input' | 'select'> {
        const isSelect = (await this.page.getByTestId(`select-${field}-trigger`).count()) > 0;
        if (isSelect) return 'select';
        const input = this.control(field);
        await input.click();
        await expect(input).toHaveValue('');
        await this.dialog.getByTestId('text-input-name').click(); // moves the focus away: blur
        return 'input';
    }

    get createButton(): Locator {
        return submitButton(this.dialog);
    }

    /**
     * Clicks Create only when the form lets it. The form is expected to be blocked: a disabled button is `{ sent: false }`;
     * an enabled one is clicked and its `POST …/raProfiles` answer returned, so the caller can record an accidental success
     * in the ledger before it asserts.
     */
    async submitIfEnabled(): Promise<SubmitOutcome> {
        if (await this.createButton.isDisabled()) return { sent: false };
        const answer = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/authorities\/[0-9a-f-]{36}\/raProfiles$/.test(new URL(r.url()).pathname));
        await this.createButton.click();
        return { sent: true, response: await answer };
    }

    /** Create is disabled: the client-side validation holds the form back. */
    async assertCreateBlocked(): Promise<void> {
        await expect(this.createButton).toBeDisabled();
    }

    /**
     * The form shows a validation message for the required attribute: the field's red "Required Field" (an input) or, when
     * a refusal reached core, the 422 text in a danger toast ("Required attribute <label> not found."). Resolves with which
     * one was shown.
     */
    async assertRequiredAttributeError(label?: string): Promise<'field' | 'toast'> {
        const field = this.dialog.getByText('Required Field', { exact: true }).first();
        const refusal = toast(this.page, new RegExp(label ? `Required attribute ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} not found\\.` : 'Required attribute .+ not found\\.'));
        await expect(field.or(refusal)).toBeVisible();
        return (await field.isVisible()) ? 'field' : 'toast';
    }

    /**
     * A refusal that reached core is shown: a danger toast that carries every message core answered (the FE joins the 422
     * array into the toast text, inventory-api rules §1.2 r7), whatever its headline.
     */
    async assertRefusalShown(messages: string[]): Promise<void> {
        const card = toast(this.page, messages[0]);
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute('role', 'alert');
        for (const m of messages) await expect(card).toContainText(m);
    }

    /** No validation text is shown yet (the form before anything was touched). `because` becomes the failure message (a pin that flips). */
    async assertNoRequiredFieldMessage(because?: string): Promise<void> {
        await expect(this.dialog.getByText('Required Field', { exact: true }), because).toHaveCount(0);
    }

    async cancel(): Promise<void> {
        await this.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(this.dialog).toBeHidden();
    }
}
