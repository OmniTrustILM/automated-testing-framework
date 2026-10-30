/**
 * catalogueContract — the searchable-fields catalogue contract of a listing.
 *
 * Provides the condition kinds, the absolute condition set of every field type, the catalogue JSON schema, the
 * `FIELD_RULES` table and `catalogueProblems` (shape, condition sets, unique identifiers, non-empty labels, sortable /
 * displayable consistency, the known fields of the listing). All pure: the schema check, the group and field rules in
 * table order, and the known-field diff. A new catalogue rule is one new table entry.
 */
import Ajv from 'ajv';
import { ALL_CONDITIONS, CONDITION_KINDS, CONDITION_SETS, sameSet } from '../searchApi';
import type { CatalogueField, CatalogueGroup } from '../searchApi';

/**
 * The kinds of condition set a catalogue field can publish. Derived from core `SearchFieldTypeEnum` (STRING, DATE, DATETIME,
 * NUMBER, LIST, NATIVE_ARRAY, PRESENCE, FREE_TEXT, BOOLEAN) and `SearchHelper.availableConditions` / `prepareSearchForJSON`:
 *   string 10 · number 8 · date 10 (date and datetime) · time 8 (a TIME attribute: the date set without IN_NEXT / IN_PAST) ·
 *   list 4 · collection 8 (a list over a collection: + COUNT_*) · nativeArray 6 (+ CONTAINS, NOT_CONTAINS) ·
 *   jsonArray 4 (a string field over a JSON array path: the list set, SearchHelper.getInitialCapacity) · boolean 4 ·
 *   expectedBoolean 2 (EQUALS, NOT_EQUALS: PRIVATE_KEY, CBOM_HAS_CONTRIBUTED_ASSETS) · presence 2 (EMPTY, NOT_EMPTY: no
 *   attribute behind the field, or an attribute whose content no listing renders) · freeText 1 (CONTAINS: crypto assets).
 */
export type ConditionKind = 'string' | 'number' | 'date' | 'time' | 'list' | 'collection' | 'nativeArray' | 'jsonArray' | 'boolean' | 'expectedBoolean' | 'presence' | 'freeText';

export const KIND_CONDITIONS: Readonly<Record<ConditionKind, readonly string[]>> = {
    string: CONDITION_SETS.string,
    number: CONDITION_SETS.number,
    date: CONDITION_SETS.date,
    time: CONDITION_KINDS.time,
    list: CONDITION_SETS.list,
    collection: CONDITION_KINDS.collection,
    nativeArray: CONDITION_KINDS.nativeArray,
    jsonArray: CONDITION_SETS.list,
    boolean: CONDITION_SETS.boolean,
    expectedBoolean: CONDITION_KINDS.expectedBoolean,
    presence: CONDITION_KINDS.presence,
    freeText: ['CONTAINS'],
};

/** Which kinds a field of a `FilterFieldType` may publish (the type decides which of the equal-looking 4-sets it is). */
const KINDS_OF_TYPE: Readonly<Record<string, readonly ConditionKind[]>> = {
    string: ['string', 'jsonArray', 'presence', 'freeText'],
    number: ['number', 'presence'],
    date: ['date', 'time', 'presence'],
    datetime: ['date', 'presence'],
    list: ['list', 'collection', 'nativeArray', 'presence'],
    boolean: ['boolean', 'expectedBoolean', 'presence'],
};

/** The kind a field's published conditions are, given its type; undefined when they are none of the known sets (a failure). */
export function classifyConditions(type: string, conditions: readonly string[]): ConditionKind | undefined {
    const allowed = KINDS_OF_TYPE[type];
    if (!allowed || !Array.isArray(conditions)) return undefined;
    return allowed.find((k) => sameSet(conditions, KIND_CONDITIONS[k]));
}

/** Kinds whose field may be sortable (SearchHelper.isOrderableField: an attribute behind it, not a native array, not derived). */
const SORTABLE_KINDS: ReadonlySet<ConditionKind> = new Set<ConditionKind>(['string', 'number', 'date', 'time', 'list', 'collection', 'boolean']);

const FIELD_TYPES = ['string', 'number', 'list', 'date', 'datetime', 'boolean'];
const SOURCES = ['property', 'meta', 'custom', 'data'];

/** SearchFieldDataByGroupDto / SearchFieldDataDto (interfaces model/core/search/), hand-written; extra members are allowed (reported). */
const CATALOGUE_SCHEMA = {
    type: 'array',
    items: {
        type: 'object',
        required: ['filterFieldSource'],
        properties: {
            filterFieldSource: { enum: SOURCES },
            searchFieldData: {
                type: ['array', 'null'],
                items: {
                    type: 'object',
                    required: ['fieldIdentifier', 'fieldLabel', 'type', 'conditions'],
                    properties: {
                        fieldIdentifier: { type: 'string', minLength: 1 },
                        fieldLabel: { type: 'string', minLength: 1 },
                        type: { enum: FIELD_TYPES },
                        conditions: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...ALL_CONDITIONS] } },
                        platformEnum: { type: ['string', 'null'] },
                        attributeContentType: { type: ['string', 'null'] },
                        multiValue: { type: ['boolean', 'null'] },
                        displayable: { type: ['boolean', 'null'] },
                        sortable: { type: ['boolean', 'null'] },
                    },
                },
            },
        },
    },
} as const;

let ajv: Ajv | undefined;
const validator = () => (ajv ??= new Ajv({ allErrors: true, strict: false })).compile(CATALOGUE_SCHEMA as unknown as object);

export interface CatalogueExpectations {
    /** The listing is wired to the configurable-column pipeline (SearchHelper.CONFIGURABLE_COLUMN_RESOURCES). */
    configurable: boolean;
    /** Only the Property source may be published (the audit log, AuditLogServiceImpl). */
    onlyProperty?: boolean;
    /** Known property fields: the type, the condition kind and, on a configurable listing, `sortable`. Each must be published. */
    known?: Readonly<Record<string, { type: CatalogueField['type']; kind: ConditionKind; sortable?: boolean }>>;
}

interface CatalogueFieldFact {
    source: string;
    id: string;
    type: string;
    kind?: ConditionKind;
    sortable?: boolean;
    displayable?: boolean;
}

export interface CatalogueReport {
    problems: string[];
    fields: CatalogueFieldFact[];
}

/** What a field rule knows about the field it judges: where it sits, how it is classified and what the listing expects. */
interface FieldContext {
    group: CatalogueGroup;
    at: string;
    id: string;
    isProperty: boolean;
    kind: ConditionKind | undefined;
    /** Identifiers already seen in this group (the duplicate rule adds to it). */
    seen: Set<string>;
    exp: CatalogueExpectations;
}

type FieldRule = (f: CatalogueField, c: FieldContext) => string | undefined;

/** One entry per rule of the contract, in the order the problems are reported. */
const FIELD_RULES: readonly FieldRule[] = [
    (f, c) => {
        const twice = c.seen.has(c.id);
        c.seen.add(c.id);
        return twice ? `${c.at}: identifier published twice in the ${c.group.filterFieldSource} group` : undefined;
    },
    (f, c) => (!f.fieldLabel.trim() ? `${c.at}: blank label` : undefined),
    (f, c) => (!c.id.trim() ? `${c.at}: blank identifier` : undefined),
    (f, c) => (c.isProperty && !/^[A-Z][A-Z0-9_]*$/.test(c.id) ? `${c.at}: a property identifier is a FilterField name (UPPER_SNAKE)` : undefined),
    (f, c) => (!c.isProperty && !/^.+\|[A-Z][A-Z0-9_]*$/.test(c.id) ? `${c.at}: an attribute identifier is <name>|<CONTENT_TYPE> (SearchHelper buildFieldIdentifier)` : undefined),
    (f, c) => (c.isProperty && f.attributeContentType ? `${c.at}: a property field carries attributeContentType ${f.attributeContentType}` : undefined),
    (f, c) => (!c.isProperty && !f.attributeContentType ? `${c.at}: an attribute field carries no attributeContentType` : undefined),
    (f, c) => (c.kind ? undefined
        : `${c.at}: conditions [${f.conditions.join(', ')}] are none of the absolute sets of type ${f.type} ` +
          `(${(KINDS_OF_TYPE[f.type] ?? []).map((k) => `${k}: ${KIND_CONDITIONS[k].length}`).join(', ')})`),
    (f, c) => (c.kind === 'time' && (c.isProperty || String(f.attributeContentType).toLowerCase() !== 'time') ? `${c.at}: the 8-condition date set belongs to a TIME attribute only` : undefined),
    (f, c) => (c.kind && ['collection', 'jsonArray', 'expectedBoolean', 'freeText'].includes(c.kind) && !c.isProperty ? `${c.at}: kind ${c.kind} exists on property fields only` : undefined),
    (f, c) => (c.kind === 'nativeArray' && f.multiValue !== true ? `${c.at}: a native-array field is multiValue` : undefined),
    (f, c) => (c.isProperty && typeof f.multiValue === 'boolean' && f.multiValue !== (f.type === 'list')
        ? `${c.at}: multiValue ${f.multiValue} for type ${f.type} (SearchHelper prepareSearch: only LIST types are multi-valued)` : undefined),
    (f, c) => (f.sortable === true && f.displayable === false ? `${c.at}: sortable but not displayable (core#2180)` : undefined),
    (f, c) => (!c.exp.configurable && (f.sortable === true || f.displayable === true)
        ? `${c.at}: sortable ${String(f.sortable)} / displayable ${String(f.displayable)} on a listing that is not wired to configurable columns (SearchHelper listingAppliesSort, RequestValidatorHelper)` : undefined),
    (f, c) => (f.sortable === true && c.kind && !SORTABLE_KINDS.has(c.kind) ? `${c.at}: sortable, but a ${c.kind} field has nothing to order by (SearchHelper isOrderableField)` : undefined),
];

/** First, the body must be a catalogue list at all; returns the groups, or the one problem that says it is not. */
function checkSchema(body: unknown): { groups: CatalogueGroup[] } | { problem: string } {
    const validate = validator();
    if (validate(body)) return { groups: body as CatalogueGroup[] };
    const first = (validate.errors ?? []).slice(0, 8).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
    return { problem: `not a SearchFieldDataByGroupDto list: ${first.join('; ')}` };
}

/** Second, the rules of the groups and of every field in them; returns the problems and the facts about each field. */
function checkGroups(groups: CatalogueGroup[], exp: CatalogueExpectations): CatalogueReport {
    const problems: string[] = [];
    const fields: CatalogueFieldFact[] = [];
    const sources = groups.map((g) => g.filterFieldSource);
    if (new Set(sources).size !== sources.length) problems.push(`a source is published twice: [${sources.join(', ')}]`);
    if (!sources.includes('property')) problems.push('no property group');
    if (exp.onlyProperty && sources.some((s) => s !== 'property')) problems.push(`only the property source may be published, got [${sources.join(', ')}]`);
    for (const group of groups) {
        const seen = new Set<string>();
        for (const f of group.searchFieldData ?? []) {
            const id = f.fieldIdentifier;
            const kind = classifyConditions(f.type, f.conditions);
            const context: FieldContext = { group, at: `${group.filterFieldSource}:${id}`, id, isProperty: group.filterFieldSource === 'property', kind, seen, exp };
            for (const rule of FIELD_RULES) {
                const problem = rule(f, context);
                if (problem) problems.push(problem);
            }
            fields.push({ source: group.filterFieldSource, id, type: f.type, kind, sortable: f.sortable ?? undefined, displayable: f.displayable ?? undefined });
        }
    }
    return { problems, fields };
}

/** Third, every known property field of the listing must be published with its type, condition kind and sortable flag. */
function knownFieldProblems(fields: CatalogueFieldFact[], exp: CatalogueExpectations): string[] {
    const problems: string[] = [];
    const property = new Map(fields.filter((f) => f.source === 'property').map((f) => [f.id, f]));
    for (const [id, want] of Object.entries(exp.known ?? {})) {
        const got = property.get(id);
        if (!got) {
            problems.push(`property:${id}: missing from the catalogue`);
            continue;
        }
        if (got.type !== want.type) problems.push(`property:${id}: type ${got.type}, expected ${want.type}`);
        if (got.kind !== want.kind) problems.push(`property:${id}: conditions of kind ${got.kind ?? '?'}, expected ${want.kind} [${KIND_CONDITIONS[want.kind].join(', ')}]`);
        if (exp.configurable && want.sortable !== undefined && (got.sortable ?? false) !== want.sortable) {
            problems.push(`property:${id}: sortable ${String(got.sortable)}, expected ${want.sortable}`);
        }
    }
    return problems;
}

/** Every problem of one searchable-fields catalogue body (pure). `problems` empty means the contract holds. */
export function catalogueProblems(body: unknown, exp: CatalogueExpectations): CatalogueReport {
    const schema = checkSchema(body);
    if ('problem' in schema) return { problems: [schema.problem], fields: [] };
    const report = checkGroups(schema.groups, exp);
    return { problems: [...report.problems, ...knownFieldProblems(report.fields, exp)], fields: report.fields };
}
