/**
 * fieldLabels — the labels the filter widget shows, computed from the
 * platform enums and the search catalogue, not from the page under test.
 */
import type { APIRequestContext } from '@playwright/test';
import { CatalogueGroup, Filter, findField } from './searchApi';
import { collapse } from '../text';


type PlatformEnums = Record<string, Record<string, { code?: string; label: string; description?: string | null }>>;

export class PlatformLabels {
    constructor(readonly enums: PlatformEnums) {}

    static async read(api: APIRequestContext): Promise<PlatformLabels> {
        const res = await api.get('/api/v1/enums');
        if (!res.ok()) throw new Error(`GET /api/v1/enums answered ${res.status()}`);
        return new PlatformLabels((await res.json()) as PlatformEnums);
    }

    label(enumName: string, code: string): string {
        const item = this.enums[enumName]?.[code];
        if (!item || typeof item.label !== 'string') throw new Error(`platform enum ${enumName} has no item "${code}"`);
        return item.label;
    }

    display(enumName: string, code: string): string {
        return this.enums[enumName]?.[code]?.label ?? code;
    }

    condition(code: string): string {
        return this.label('FilterConditionOperator', code);
    }

    source(code: string): string {
        return this.label('FilterFieldSource', code);
    }
}


export interface WidgetField {
    fieldIdentifier: string;
    fieldLabel: string;
    conditions: string[];
    attributeContentType?: string;
}

const normalizeLabel = (label: string): string => label.trim().toLowerCase();

/**
 * The label each field gets in the Field select: a shared label gets the attribute content type appended,
 * and a label that is still shared gets " — <identifier>" appended.
 */
export function fieldLabelMap(fields: readonly WidgetField[], contentTypeLabel: (code: string) => string): Map<string, string> {
    const counts = new Map<string, number>();
    for (const f of fields) counts.set(normalizeLabel(f.fieldLabel), (counts.get(normalizeLabel(f.fieldLabel)) ?? 0) + 1);
    const withType = fields.map((f) => {
        const duplicate = (counts.get(normalizeLabel(f.fieldLabel)) ?? 0) > 1;
        const type = f.attributeContentType ? contentTypeLabel(f.attributeContentType) : undefined;
        return { id: f.fieldIdentifier, label: duplicate && type ? `${f.fieldLabel} (${type})` : f.fieldLabel };
    });
    const shown = new Map<string, number>();
    for (const o of withType) shown.set(normalizeLabel(o.label), (shown.get(normalizeLabel(o.label)) ?? 0) + 1);
    return new Map(withType.map((o) => [o.id, (shown.get(normalizeLabel(o.label)) ?? 0) > 1 ? `${o.label} — ${o.id}` : o.label]));
}

/** The labels the Field select shows for a catalogue group, in order; fields without a condition are left out. */
export function expectedFieldLabels(fields: readonly WidgetField[], contentTypeLabel: (code: string) => string): string[] {
    const labels = fieldLabelMap(fields, contentTypeLabel);
    return fields.filter((f) => f.conditions.length > 0).map((f) => labels.get(f.fieldIdentifier)!);
}

/** The label a list option shows: the platform enum label for an enum-backed field, a group object's `name`, else the value. */
export function valueOptionLabel(labels: PlatformLabels, field: { platformEnum?: string }, value: unknown): string {
    if (typeof value === 'object' && value !== null) return String((value as { name?: unknown }).name ?? JSON.stringify(value));
    return field.platformEnum ? labels.display(field.platformEnum, String(value)) : String(value);
}

export function expectedBadgeText(parts: { source: string; field: string; condition: string; value?: string | string[] }): string {
    const value = parts.value === undefined ? '' : Array.isArray(parts.value) ? parts.value.join(' OR ') : parts.value;
    return `${parts.source} '${parts.field}' ${parts.condition} '${value}'`;
}

export const badgeTextOf = (raw: string): string => collapse(raw).replace(/\s*Remove badge$/, '').trim();

export interface LabelledFilterSpec {
    source: string;
    field: string;
    condition: string;
    value?: string | string[];
}

export function catalogueFieldLabel(catalogue: readonly CatalogueGroup[], labels: PlatformLabels, source: string, identifier: string): string {
    const group = catalogue.find((g) => g.filterFieldSource === source);
    const label = group ? fieldLabelMap(group.searchFieldData ?? [], (code) => labels.display('AttributeContentType', code)).get(identifier) : undefined;
    if (!label) throw new Error(`the catalogue has no ${source} field ${identifier}`);
    return label;
}

/** What the widget needs to add an API-shaped filter: labels for source, field and condition, and the value to type or pick. */
export function widgetSpecOf(f: Filter, catalogue: readonly CatalogueGroup[], labels: PlatformLabels): LabelledFilterSpec {
    const field = findField(catalogue as CatalogueGroup[], f.fieldIdentifier, f.fieldSource);
    if (!field) throw new Error(`the catalogue has no field ${f.fieldIdentifier}`);
    const value = f.value === undefined ? undefined : Array.isArray(f.value) ? f.value.map((v) => valueOptionLabel(labels, field, v)) : String(f.value);
    return {
        source: labels.source(f.fieldSource),
        field: catalogueFieldLabel(catalogue, labels, f.fieldSource, f.fieldIdentifier),
        condition: labels.condition(f.condition),
        ...(value === undefined ? {} : { value }),
    };
}

export function badgeOfFilter(f: Filter, catalogue: readonly CatalogueGroup[], labels: PlatformLabels): string {
    const spec = widgetSpecOf(f, catalogue, labels);
    return expectedBadgeText({ source: spec.source, field: spec.field, condition: spec.condition, value: spec.value as string | string[] | undefined });
}
