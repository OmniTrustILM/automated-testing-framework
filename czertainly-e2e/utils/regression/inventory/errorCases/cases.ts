/**
 * cases — the refusal cases of the error-contract API spec.
 *
 * Data, not scattered literals: the rows of the inventory API status matrix, the refusal texts, and the five listings
 * with one request per resource and case (the refusal text, or the reason the case does not apply to that resource).
 */
import { CONDITION_SETS, sameSet } from '../searchApi';
import { Expectation, Oracle, preview } from './checks';
import { Req } from './requests';

// ------------------------------------------------------------------ the status-matrix rows (naming only)

/** The rows of the inventory API status matrix the battery exercises, plus the create / content-type / auth rows. */
export const ERROR_STATUS_MATRIX = {
    paging: 'status matrix: search body: itemsPerPage 0 / negative or pageNumber 0 / negative → 422 with one message (core validates paging itself)',
    unreadableBody: 'status matrix: search body: int overflow, body not JSON, enum value in the wrong case → 400 {"message":"Unable to read HTTP message"}',
    beanValidation: 'status matrix: sort.fieldIdentifier blank / sort.direction null / columns[0] null → 422 bean-validation text',
    sorting: 'status matrix: sort on an unknown field / a non-sortable field / a listing that does not sort → 422',
    conditionNotOffered: 'status matrix: property filter: condition not advertised for the field → 422',
    valueMissing: 'status matrix: property filter: value missing or [] for a value condition → 422',
    regex: 'status matrix: filter: invalid regex / \\Q-style literal → 422',
    valueFormat: 'status matrix: filter: bad duration for IN_NEXT / IN_PAST, non-numeric number / COUNT_* → 422',
    attributeIdentifier: 'status matrix: attribute filter: identifier without the |CONTENT_TYPE suffix → 422',
    pathAndQueryTypes: 'status matrix: path / query type error → 400 (or the 422 of a service-side uuid / enum check)',
    unknownObject: 'status matrix: unknown object uuid / unmatched path → 404',
    wrongMethod: 'status matrix: TRACE or a method the path does not define → 4xx, never 5xx',
    createName: 'create (credentials / groups): blank or missing name → 422 ["Name must not be empty"], nothing created',
    createBody: 'create (credentials / groups): malformed JSON / wrong type → 400 {"message":"Unable to read HTTP message"}',
    contentType: 'unsupported Content-Type: shape of the answer (415 expected, core#2140 answers 500)',
    credentials: 'missing or failed credentials → 401, the body never echoes the credential',
} as const;
export type MatrixRow = keyof typeof ERROR_STATUS_MATRIX;

// ------------------------------------------------------------------ messages (verbatim from core)

/** The paging refusal of core's RequestValidatorHelper.validatePaging: a 422 with one message (core PR #2527). */
export const pagingMessage = (what: 'Items per page' | 'Page number', value: number): string => `${what} must be at least 1, but was ${value}`;

export const ERROR_MESSAGES = {
    /** The generic 400 body of ExceptionHandlingAdvice.java (an IllegalArgumentException; not the paging answer any more). */
    paging: 'The request could not be processed.',
    /** HttpMessageNotReadableException: ExceptionHandlingAdvice.java. */
    unreadable: 'Unable to read HTTP message',
    /** Bean validation, `@NotBlank` / `@NotNull` of SearchSortRequestDto (field + " " + message). */
    blankSortIdentifier: 'sort.fieldIdentifier must not be blank',
    nullSortDirection: 'sort.direction must not be null',
    nullColumn: 'columns[0] must not be null',
    /** GroupServiceImpl.java, CredentialServiceImpl.java. */
    nameEmpty: 'Name must not be empty',
    /** UploadRequestDto.isFileWithinLimit (UploadRequestDto.java). */
    oversize: 'fileWithinLimit file must not exceed 5242880 bytes',
    /** ContainerRefusal.java (start of the sentence). */
    notSupportedFormat: /^The file is not in a supported format: /,
    internal: 'Internal server error.',
} as const;

// ------------------------------------------------------------------ the five listings (API-GEN-02)

export type ResourceKey = 'certificates' | 'keys' | 'discoveries' | 'auditLogs' | 'oids';

/** One listing that uses the shared search engine, with the property fields its cases name (core `FilterField`). */
export interface ListingSpec {
    key: ResourceKey;
    /** The search POST (a POST_READ route of the guard). */
    url: string;
    /** The resource label of "Sorting is not supported for the <label> listing." (`Resource.getLabel`), when it refuses every sort. */
    sortRefusedLabel?: string;
    fields: {
        /** A STRING field: CONTAINS, MATCHES, … */
        string: string;
        /** A LIST field with the plain list conditions (EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY). */
        list: string;
        /** A NUMBER field, when the listing has one. */
        number?: string;
        /** A DATETIME field, when the listing has one. */
        datetime?: string;
        /** A field the sort refuses on a listing that sorts (PRIVATE_KEY, the bit-mask CKI_USAGE), when there is one. */
        nonSortable?: string;
        /** Any sortable field, for the wrong-case direction row. */
        sortable: string;
    };
    /** Why a case does not apply (`NOT_APPLICABLE`), per missing field. */
    why: { number?: string; datetime?: string; nonSortable?: string };
}

export const LISTING_ENDPOINTS: readonly ListingSpec[] = [
    {
        key: 'certificates', url: '/api/v1/certificates',
        fields: { string: 'COMMON_NAME', list: 'KEY_SIZE', datetime: 'NOT_AFTER', nonSortable: 'PRIVATE_KEY', sortable: 'COMMON_NAME' },
        why: { number: 'the certificate catalogue has no NUMBER field (KEY_SIZE is a list)' },
    },
    {
        key: 'keys', url: '/api/v1/keys',
        fields: { string: 'CKI_NAME', list: 'CKI_TYPE', number: 'CKI_LENGTH', datetime: 'CKI_CREATED', nonSortable: 'CKI_USAGE', sortable: 'CKI_NAME' },
        why: {},
    },
    {
        key: 'discoveries', url: '/api/v1/discoveries/list',
        fields: { string: 'DISCOVERY_NAME', list: 'DISCOVERY_STATUS', number: 'DISCOVERY_TOTAL_CERT_DISCOVERED', datetime: 'DISCOVERY_START_TIME', sortable: 'DISCOVERY_NAME' },
        why: { nonSortable: 'every DISCOVERY_* field is sortable (SearchHelper.isOrderableField / ABSENT_FROM_LISTING name none of them)' },
    },
    {
        key: 'auditLogs', url: '/api/v1/auditLogs', sortRefusedLabel: 'Audit logs',
        fields: { string: 'AUDIT_LOG_ACTOR_NAME', list: 'AUDIT_LOG_MODULE', datetime: 'AUDIT_LOG_TIMESTAMP', sortable: 'AUDIT_LOG_TIMESTAMP' },
        why: { number: 'the audit-log catalogue has no NUMBER field', nonSortable: 'the listing refuses every sort (RequestValidatorHelper.java): API-GEN-11 owns the sort contract' },
    },
    {
        key: 'oids', url: '/api/v1/oids/list', sortRefusedLabel: 'OID',
        fields: { string: 'OID_ENTRY_OID', list: 'OID_ENTRY_CATEGORY', sortable: 'OID_ENTRY_OID' },
        why: { number: 'the OID catalogue has no NUMBER field', datetime: 'the OID catalogue has no DATETIME field', nonSortable: 'the listing refuses every sort (RequestValidatorHelper.java)' },
    },
];

export const listing = (key: ResourceKey): ListingSpec => {
    const l = LISTING_ENDPOINTS.find((x) => x.key === key);
    if (!l) throw new Error(`no listing ${key}`);
    return l;
};

export const searchBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ filters: [], itemsPerPage: 10, pageNumber: 1, ...extra });
const prop = (field: string, condition: string, value?: unknown): Record<string, unknown> =>
    value === undefined ? { fieldSource: 'property', fieldIdentifier: field, condition } : { fieldSource: 'property', fieldIdentifier: field, condition, value };
const sortOn = (field: string, direction: unknown): Record<string, unknown> => ({ fieldSource: 'property', fieldIdentifier: field, direction });

export type CaseId =
    | 'paging.itemsPerPage0' | 'paging.pageNumber0' | 'paging.itemsPerPageNegative' | 'paging.pageNumberNegative'
    | 'json.itemsPerPageOverflow' | 'json.notJson' | 'json.conditionCase' | 'json.fieldSourceCase' | 'json.directionCase'
    | 'sort.blankIdentifier' | 'sort.nullDirection' | 'sort.unknownField' | 'sort.nonSortableField'
    | 'filter.conditionNotAdvertised.list' | 'filter.conditionNotAdvertised.string' | 'filter.valueMissing' | 'filter.valueEmptyList'
    | 'filter.regexInvalid' | 'filter.regexQuote' | 'filter.durationInvalid' | 'filter.numberInvalid' | 'filter.attributeNoSuffix';

type Built = { data: unknown; expect: Expectation } | { na: string };

interface CaseDef {
    id: CaseId;
    matrix: MatrixRow;
    /** The refusal as the rules state it. */
    rule: string;
    build(l: ListingSpec): Built;
}

/** A 422 that names the condition sets the field supports: the listed set must be the absolute set of its type. */
function conditionSetCheck(field: string, kind: keyof typeof CONDITION_SETS) {
    const re = new RegExp(`^Field ${field} does not support the GREATER condition; it supports ([A-Z_]+(?:, [A-Z_]+)*)\\.$`);
    return (p: { status: number; text: string; json: unknown }): string[] => {
        if (p.status !== 422 || !Array.isArray(p.json)) return [];
        const m = re.exec(String(p.json[0] ?? ''));
        if (!m) return [`the 422 text is not "Field ${field} does not support the GREATER condition; it supports …": ${preview(p.text)}`];
        const listed = m[1].split(', ');
        return sameSet(listed, CONDITION_SETS[kind]) ? [] : [`${field} lists [${listed.join(', ')}], the absolute set of a ${kind} field is [${CONDITION_SETS[kind].join(', ')}]`];
    };
}

export const refuse = (messages: readonly Oracle[], status = 422): Expectation => ({ status, messages });

export const LISTING_CASES: readonly CaseDef[] = [
    // paging: core validates it itself (RequestValidatorHelper.validatePaging) and answers 422 with one message (core PR #2527).
    { id: 'paging.itemsPerPage0', matrix: 'paging', rule: 'itemsPerPage 0 → 422 ["Items per page must be at least 1, but was 0"]', build: () => ({ data: searchBody({ itemsPerPage: 0 }), expect: refuse([pagingMessage('Items per page', 0)]) }) },
    { id: 'paging.pageNumber0', matrix: 'paging', rule: 'pageNumber 0 → 422 ["Page number must be at least 1, but was 0"]', build: () => ({ data: searchBody({ pageNumber: 0 }), expect: refuse([pagingMessage('Page number', 0)]) }) },
    { id: 'paging.itemsPerPageNegative', matrix: 'paging', rule: 'itemsPerPage -1 → 422 ["Items per page must be at least 1, but was -1"]', build: () => ({ data: searchBody({ itemsPerPage: -1 }), expect: refuse([pagingMessage('Items per page', -1)]) }) },
    { id: 'paging.pageNumberNegative', matrix: 'paging', rule: 'pageNumber -1 → 422 ["Page number must be at least 1, but was -1"]', build: () => ({ data: searchBody({ pageNumber: -1 }), expect: refuse([pagingMessage('Page number', -1)]) }) },
    // unreadableBody: Jackson (HttpMessageNotReadableException → ExceptionHandlingAdvice.java).
    { id: 'json.itemsPerPageOverflow', matrix: 'unreadableBody', rule: 'itemsPerPage 2147483648 (int overflow) → 400 "Unable to read HTTP message"', build: () => ({ data: Buffer.from('{"filters":[],"itemsPerPage":2147483648,"pageNumber":1}'), expect: { status: 400, message: ERROR_MESSAGES.unreadable } }) },
    { id: 'json.notJson', matrix: 'unreadableBody', rule: 'body not JSON → 400 "Unable to read HTTP message"', build: () => ({ data: Buffer.from('this is not json'), expect: { status: 400, message: ERROR_MESSAGES.unreadable } }) },
    { id: 'json.conditionCase', matrix: 'unreadableBody', rule: 'condition in the wrong case ("contains") → 400 "Unable to read HTTP message"', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'contains', 'x')] }), expect: { status: 400, message: ERROR_MESSAGES.unreadable } }) },
    { id: 'json.fieldSourceCase', matrix: 'unreadableBody', rule: 'fieldSource in the wrong case ("PROPERTY") → 400 "Unable to read HTTP message"', build: (l) => ({ data: searchBody({ filters: [{ fieldSource: 'PROPERTY', fieldIdentifier: l.fields.string, condition: 'EQUALS', value: 'x' }] }), expect: { status: 400, message: ERROR_MESSAGES.unreadable } }) },
    { id: 'json.directionCase', matrix: 'unreadableBody', rule: 'sort.direction in the wrong case ("ASC") → 400 "Unable to read HTTP message"', build: (l) => ({ data: searchBody({ sort: sortOn(l.fields.sortable, 'ASC') }), expect: { status: 400, message: ERROR_MESSAGES.unreadable } }) },
    // beanValidation: bean validation runs before any service (SearchRequestDto is `@Valid @RequestBody` on every listing).
    { id: 'sort.blankIdentifier', matrix: 'beanValidation', rule: 'sort.fieldIdentifier blank → 422 ["sort.fieldIdentifier must not be blank"]', build: () => ({ data: searchBody({ sort: sortOn('', 'asc') }), expect: refuse([ERROR_MESSAGES.blankSortIdentifier]) }) },
    { id: 'sort.nullDirection', matrix: 'beanValidation', rule: 'sort.direction null → 422 ["sort.direction must not be null"]', build: (l) => ({ data: searchBody({ sort: sortOn(l.fields.sortable, null) }), expect: refuse([ERROR_MESSAGES.nullSortDirection]) }) },
    // sorting: SortOrderBuilder.resolveField (unknown / not orderable) on the listings that sort; RequestValidatorHelper.java on the
    // others.
    {
        id: 'sort.unknownField', matrix: 'sorting', rule: 'sort on an unknown field → 422 ["Unknown sort field identifier X."]; a listing that does not sort refuses any sort',
        build: (l) => ({
            data: searchBody({ sort: sortOn('QA_NO_SUCH_FIELD', 'asc') }),
            expect: refuse([l.sortRefusedLabel ? `Sorting is not supported for the ${l.sortRefusedLabel} listing.` : 'Unknown sort field identifier QA_NO_SUCH_FIELD.']),
        }),
    },
    {
        id: 'sort.nonSortableField', matrix: 'sorting', rule: 'sort on a non-sortable field → 422 ["Field X cannot be used to order this listing."]',
        build: (l) => (l.fields.nonSortable
            ? { data: searchBody({ sort: sortOn(l.fields.nonSortable, 'asc') }), expect: refuse([`Field ${l.fields.nonSortable} cannot be used to order this listing.`]) }
            : { na: l.why.nonSortable ?? 'no non-sortable field' }),
    },
    // conditionNotOffered: FilterPredicatesBuilder.requireAdvertisedCondition, before any predicate is built.
    {
        id: 'filter.conditionNotAdvertised.list', matrix: 'conditionNotOffered', rule: 'GREATER on a list field → 422 "Field X does not support the GREATER condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY."',
        build: (l) => ({
            data: searchBody({ filters: [prop(l.fields.list, 'GREATER', '1')] }),
            expect: { status: 422, extra: conditionSetCheck(l.fields.list, 'list'), messages: [new RegExp(`^Field ${l.fields.list} does not support the GREATER condition; it supports `)] },
        }),
    },
    {
        id: 'filter.conditionNotAdvertised.string', matrix: 'conditionNotOffered', rule: 'GREATER on a string field → 422 "Field X does not support the GREATER condition; it supports CONTAINS, … NOT_MATCHES."',
        build: (l) => ({
            data: searchBody({ filters: [prop(l.fields.string, 'GREATER', 'x')] }),
            expect: { status: 422, extra: conditionSetCheck(l.fields.string, 'string'), messages: [new RegExp(`^Field ${l.fields.string} does not support the GREATER condition; it supports `)] },
        }),
    },
    // valueMissing: FilterPredicatesBuilder.getPropertyFilterPredicate.
    { id: 'filter.valueMissing', matrix: 'valueMissing', rule: 'CONTAINS without a value → 422 "Filter for field X with operator CONTAINS requires at least one value."', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'CONTAINS')] }), expect: refuse([`Filter for field ${l.fields.string} with operator CONTAINS requires at least one value.`]) }) },
    { id: 'filter.valueEmptyList', matrix: 'valueMissing', rule: 'CONTAINS with value [] → 422 "Filter for field X with operator CONTAINS requires at least one value."', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'CONTAINS', [])] }), expect: refuse([`Filter for field ${l.fields.string} with operator CONTAINS requires at least one value.`]) }) },
    // regex: validateRegexForDbQuery.
    { id: 'filter.regexInvalid', matrix: 'regex', rule: 'MATCHES with "(" → 422 "Input is not a valid regex: …"', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'MATCHES', '(')] }), expect: refuse([/^Input is not a valid regex: /]) }) },
    { id: 'filter.regexQuote', matrix: 'regex', rule: 'MATCHES with a \\Q literal → 422 "Literal quote sequences … are not supported in PostgreSQL POSIX regex"', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'MATCHES', '\\Qabc')] }), expect: refuse(['Literal quote sequences \\Q, \\R, \\G, \\h, \\H, \\z, \\X, \\V are not supported in PostgreSQL POSIX regex']) }) },
    // valueFormat: preparePropertyFilterValues.
    { id: 'filter.durationInvalid', matrix: 'valueFormat', rule: 'IN_NEXT "30 days" on a date-time field → 422 "Filter field value 30 days cannot be parsed to a Duration."', build: (l) => (l.fields.datetime ? { data: searchBody({ filters: [prop(l.fields.datetime, 'IN_NEXT', '30 days')] }), expect: refuse(['Filter field value 30 days cannot be parsed to a Duration.']) } : { na: l.why.datetime ?? 'no DATETIME field' }) },
    { id: 'filter.numberInvalid', matrix: 'valueFormat', rule: 'EQUALS "abc" on a number field → 422 "Filter field value abc cannot be parsed as a Number."', build: (l) => (l.fields.number ? { data: searchBody({ filters: [prop(l.fields.number, 'EQUALS', 'abc')] }), expect: refuse(['Filter field value abc cannot be parsed as a Number.']) } : { na: l.why.number ?? 'no NUMBER field' }) },
    // attributeIdentifier: getAttributeFilterPredicate, shared by every listing.
    { id: 'filter.attributeNoSuffix', matrix: 'attributeIdentifier', rule: 'custom-attribute identifier without |CONTENT_TYPE → 422 "Filter field identifier X does not name an attribute."', build: () => ({ data: searchBody({ filters: [{ fieldSource: 'custom', fieldIdentifier: 'qa-no-suffix', condition: 'EQUALS', value: 'x' }] }), expect: refuse(['Filter field identifier qa-no-suffix does not name an attribute.']) }) },
];

/** One request of the API-GEN-02 table: a resource and a case. */
export interface ListingCase {
    id: string;
    resource: ResourceKey;
    caseId: CaseId;
    matrix: MatrixRow;
    rule: string;
    req: Req;
    expect: Expectation;
}

export interface NotApplicable {
    resource: ResourceKey;
    caseId: CaseId;
    why: string;
}

/** Every (resource × case) request of API-GEN-02. */
export function listingCases(): ListingCase[] {
    const out: ListingCase[] = [];
    for (const l of LISTING_ENDPOINTS) {
        for (const c of LISTING_CASES) {
            const b = c.build(l);
            if ('na' in b) continue;
            out.push({ id: `${l.key}.${c.id}`, resource: l.key, caseId: c.id, matrix: c.matrix, rule: c.rule, req: { method: 'POST', url: l.url, data: b.data }, expect: b.expect });
        }
    }
    return out;
}

/** The (resource × case) pairs that have no request, each with its reason: the table is complete or it says why not. */
export function notApplicable(): NotApplicable[] {
    const out: NotApplicable[] = [];
    for (const l of LISTING_ENDPOINTS) {
        for (const c of LISTING_CASES) {
            const b = c.build(l);
            if ('na' in b) out.push({ resource: l.key, caseId: c.id, why: b.na });
        }
    }
    return out;
}

export const listingCase = (resource: ResourceKey, caseId: CaseId): ListingCase => {
    const c = listingCases().find((x) => x.resource === resource && x.caseId === caseId);
    if (!c) throw new Error(`no case ${resource}.${caseId}`);
    return c;
};
