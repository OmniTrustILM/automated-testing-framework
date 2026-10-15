/**
 * inventoryErrorBattery — the data tables and the pure checkers behind API-GEN-01 / 02 / 03 / 05 / 06 / 07 / 08
 * (tests/api/API-GEN-01-error-contract.api.spec.ts; ilm#428 T4, ilm#442 QA#8 / #11 / #12): the error contract of the
 * core REST API, applied to refused requests only.
 *
 * What is here:
 * - the oracle vocabulary: `Expectation` (status, 422 messages or the single `message`, empty body), `judge` (status +
 *   body shape + leak scan + token / marker echo, one list of problems per request);
 * - the leak scanner (`leaks`): stack frames, exception class names, application / framework packages, SQL, file paths.
 *   The JDK type names of Spring's type-mismatch sentence (`java.lang.String`, `java.util.UUID`) are the documented
 *   text of inventory-api rules §1.3 and are tolerated; every other package name is a finding;
 * - the five-listing table of API-GEN-02 (`LISTINGS`, `CASES`, `listingCases`, `NOT_APPLICABLE`): one request per
 *   resource and case, the refusal text per resource (core ExceptionHandlingAdvice, RequestValidatorHelper,
 *   FilterPredicatesBuilder, SortOrderBuilder, ListingSortResolver, SecuredUUID);
 * - the ≥ 40-request battery of API-GEN-01 (`gen01Battery`), each request naming the §1.3 matrix row it exercises;
 * - the JSON parsing battery of API-GEN-05 (`jsonBattery`), the content-type / method / security tables of API-GEN-06 /
 *   07 / 08, the upload bodies of API-GEN-03 and the JWT forgery of the `alg: none` row (`Buffer` base64url only).
 *
 * Safety: every request here is a read (GET, TRACE, the five search POSTs) or a REFUSED create (`POST /api/v1/groups`
 * and `/api/v1/credentials` bodies the core rejects before any write); the spec records an accidental 2xx in the ledger
 * before it fails. Requests go through the guarded `api` fixture (`sendReq` takes a `GuardedApi`); anonymous reads use
 * the `request` fixture in the spec. Nothing here reads the environment, the ledger or the network.
 */
import type { APIResponse } from '@playwright/test';
import { CONDITION_SETS, sameSet } from './inventoryApi';
import type { Probe } from './inventoryApi';
import type { GuardedApi, RequestShape } from './guardedApi';

// ------------------------------------------------------------------ the §1.3 matrix rows (naming only)

/** The rows of inventory-api rules §1.3 (status matrix) the battery exercises, plus the create / content-type / auth rows. */
export const MATRIX = {
    M1: '§1.3 search body: itemsPerPage 0 / negative or pageNumber 0 / negative → 400 {"message":"The request could not be processed."}',
    M2: '§1.3 search body: int overflow, body not JSON, enum value in the wrong case → 400 {"message":"Unable to read HTTP message"}',
    M3: '§1.3 sort.fieldIdentifier blank / sort.direction null / columns[0] null → 422 bean-validation text',
    M4: '§1.3 sort on an unknown field / a non-sortable field / a listing that does not sort → 422',
    M5: '§1.3 property filter: condition not advertised for the field → 422',
    M6: '§1.3 property filter: value missing or [] for a value condition → 422',
    M7: '§1.3 filter: invalid regex / \\Q-style literal → 422',
    M8: '§1.3 filter: bad duration for IN_NEXT / IN_PAST, non-numeric number / COUNT_* → 422',
    M9: '§1.3 attribute filter: identifier without the |CONTENT_TYPE suffix → 422',
    M12: '§1.3 path / query type error → 400 (or the 422 of a service-side uuid / enum check)',
    M13: '§1.3 unknown object uuid / unmatched path → 404',
    M17: '§1.3 TRACE or a method the path does not define → 4xx, never 5xx',
    G1: '§9.3 / §10.3 create: blank or missing name → 422 ["Name must not be empty"], nothing created',
    G2: '§9.3 / §10.3 create: malformed JSON / wrong type → 400 {"message":"Unable to read HTTP message"}',
    C1: '§1.4 unsupported Content-Type: shape of the answer (415 expected, core#2140 answers 500)',
    A1: '§1.2 / P1 §9.6 missing or failed credentials → 401, the body never echoes the credential',
} as const;
export type MatrixRow = keyof typeof MATRIX;

// ------------------------------------------------------------------ messages (verbatim from core)

export const MSG = {
    /** IllegalArgumentException (PageRequest.of): ExceptionHandlingAdvice.java:155-160. */
    paging: 'The request could not be processed.',
    /** HttpMessageNotReadableException: ExceptionHandlingAdvice.java:387-400. */
    unreadable: 'Unable to read HTTP message',
    /** Bean validation, `@NotBlank` / `@NotNull` of SearchSortRequestDto (field + " " + message). */
    blankSortIdentifier: 'sort.fieldIdentifier must not be blank',
    nullSortDirection: 'sort.direction must not be null',
    nullColumn: 'columns[0] must not be null',
    /** GroupServiceImpl.java:95, CredentialServiceImpl.java:139. */
    nameEmpty: 'Name must not be empty',
    /** UploadRequestDto.isFileWithinLimit (UploadRequestDto.java:46-51). */
    oversize: 'fileWithinLimit file must not exceed 5242880 bytes',
    /** ContainerRefusal.java:13-15 (start of the sentence). */
    notSupportedFormat: /^The file is not in a supported format: /,
    internal: 'Internal server error.',
} as const;

// ------------------------------------------------------------------ the oracle vocabulary

export type Oracle = string | RegExp;
const oracleMatches = (o: Oracle, s: string): boolean => (typeof o === 'string' ? s === o : o.test(s));
const describeOracle = (o: Oracle): string => (typeof o === 'string' ? JSON.stringify(o) : String(o));

/** What a refused request must answer (inventory-api rules §1.2 r2–r3 and the matrix row). */
export interface Expectation {
    /** One status, the accepted family (a shape-only row, a pinned row), or any `'4xx'` (never a server error). */
    status: number | readonly number[] | '4xx';
    /** A 422 body: the messages, in order (a string is exact, a RegExp is matched). Omitted: shape only. */
    messages?: readonly Oracle[];
    /** Any other error body: the single `message`. Omitted: shape only. */
    message?: Oracle;
    /** The body must be empty (a refused method answers 400 with no body; a 401). */
    empty?: boolean;
    /** Extra checks on the parsed answer (the set of conditions a 422 lists, a search page, …); returns problems. */
    extra?: (p: { status: number; text: string; json: unknown }) => string[];
}

export interface Answer {
    status: number;
    contentType: string;
    text: string;
    headers?: Record<string, string>;
    json?: unknown;
}

const JSON_TYPE = /application\/json/i;

/** Whether `got` is what the expectation accepts. */
export function statusOk(want: Expectation['status'], got: number): boolean {
    if (want === '4xx') return got >= 400 && got < 500;
    return typeof want === 'number' ? want === got : want.includes(got);
}
const describeStatus = (want: Expectation['status']): string => (want === '4xx' ? 'a 4xx' : typeof want === 'number' ? String(want) : want.join(' or '));
const preview = (text: string): string => JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}…` : text);

/** Parsed body, or undefined when empty or not JSON. */
function parsed(text: string): unknown {
    try {
        return text ? JSON.parse(text) : undefined;
    } catch {
        return undefined;
    }
}

/** The shape of an error body (rules §1.2 r2–r3): a 422 is an array of non-empty strings, any other 4xx / 5xx `{message}`. */
export function shapeProblems(status: number, contentType: string, text: string): string[] {
    const out: string[] = [];
    const body = parsed(text);
    if (status === 422) {
        const ok = Array.isArray(body) && body.length > 0 && body.every((x) => typeof x === 'string' && x.trim().length > 0);
        if (!ok) out.push(`a 422 body must be a JSON array of non-empty strings; got ${preview(text)}`);
    } else {
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body as object) : [];
        const ok = keys.length === 1 && keys[0] === 'message' && typeof (body as { message?: unknown }).message === 'string';
        if (!ok) out.push(`a ${status} body must be {"message": "<text>"} and nothing else; got ${preview(text)}`);
    }
    if (!JSON_TYPE.test(contentType)) out.push(`a ${status} body must be application/json; got content-type ${JSON.stringify(contentType)}`);
    return out;
}

/**
 * Judges one answer against its expectation: status, body shape, the messages / message, an empty body, the leak scan
 * of the body (and of the WWW-Authenticate header), and the echo of any secret or marker the request carried.
 */
export function judge(e: Expectation, a: Answer, echo: readonly string[] = []): string[] {
    const problems: string[] = [];
    if (!statusOk(e.status, a.status)) problems.push(`status ${a.status}, expected ${describeStatus(e.status)}: ${preview(a.text)}`);
    const isError = a.status >= 400;
    if (e.empty) {
        if (a.text.trim() !== '') problems.push(`the body must be empty; got ${preview(a.text)}`);
    } else if (isError && a.status !== 401 && a.status !== 403) {
        const shape = shapeProblems(a.status, a.contentType, a.text);
        problems.push(...shape);
        if (!shape.length) {
            const body = parsed(a.text);
            if (a.status === 422 && e.messages) {
                const got = body as string[];
                if (got.length !== e.messages.length) problems.push(`expected ${e.messages.length} message(s), got ${got.length}: ${preview(a.text)}`);
                else e.messages.forEach((o, i) => { if (!oracleMatches(o, got[i])) problems.push(`message ${i + 1} is ${JSON.stringify(got[i])}, expected ${describeOracle(o)}`); });
            } else if (a.status !== 422 && e.message !== undefined) {
                const got = (body as { message: string }).message;
                if (!oracleMatches(e.message, got)) problems.push(`message is ${JSON.stringify(got)}, expected ${describeOracle(e.message)}`);
            }
        }
    }
    if (e.extra) problems.push(...e.extra({ status: a.status, text: a.text, json: a.json ?? parsed(a.text) }));
    const surface = [a.text, a.headers?.['www-authenticate'] ?? ''].join('\n');
    for (const l of leaks(surface)) problems.push(`the answer leaks internals (${l.kind}): ${JSON.stringify(l.sample)}`);
    for (const secret of echo) if (secret && surface.includes(secret)) problems.push(`the answer echoes ${JSON.stringify(secret.length > 24 ? `${secret.slice(0, 24)}…` : secret)}`);
    return problems;
}

// ------------------------------------------------------------------ the leak scanner

export type LeakKind = 'stack-trace' | 'exception-class' | 'package' | 'sql' | 'file-path';
export interface Leak {
    kind: LeakKind;
    sample: string;
}

/** The JDK types Spring's type-mismatch text names (`Failed to convert value of type 'java.lang.String' to required type 'java.util.UUID'`). */
const JDK_TYPE = /\bjava\.(?:lang|util|time|math|net)\.[A-Z][\w$]*/g;

const PATTERNS: ReadonlyArray<{ kind: LeakKind; re: RegExp }> = [
    { kind: 'stack-trace', re: /\bat\s+[\w$.]+\([\w$]+\.(?:java|kt|groovy|scala):\d+\)/ },
    { kind: 'stack-trace', re: /\bCaused by:\s*[\w$.]+/ },
    { kind: 'stack-trace', re: /\b[\w$]+\.(?:java|kt|groovy):\d+\b/ },
    // Class names ending in Exception / Error: ConstraintViolationException, NullPointerException, PSQLException (never the bare word).
    { kind: 'exception-class', re: /\b[A-Za-z][A-Za-z0-9]+(?:Exception|Error)\b/ },
    // Application, framework and library packages (a JDK type of the documented type-mismatch sentence is stripped first).
    { kind: 'package', re: /\b(?:com|org|io|net|jakarta|javax|jdk|sun|reactor|ch|de)\.(?:otilm|czertainly|springframework|hibernate|postgresql|apache|fasterxml|swagger|bouncycastle|zaxxer|netty|sql|io|security|persistence|validation|servlet|tomcat|catalina|slf4j|logging|opentelemetry)\b[\w.$]*/ },
    { kind: 'package', re: /\bjava\.(?:sql|io|nio|security|net\.http)\b[\w.$]*/ },
    { kind: 'package', re: /(?:^|[\s'"(\[@])(?:[a-z][a-z0-9]*\.){3,}[A-Z][\w$]*/ },
    { kind: 'sql', re: /\bselect\b[^\n]{1,200}\bfrom\b/i },
    { kind: 'sql', re: /\b(?:insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i },
    { kind: 'sql', re: /\b(?:violates (?:unique|foreign key|not-null|check) constraint|could not execute statement|SQLSTATE|duplicate key value)\b/i },
    { kind: 'file-path', re: /(?:^|[\s'"(=:])\/(?:home|opt|usr|var|etc|app|tmp|root|srv|Users|workspace|build)\/[\w.\-/]+/ },
    { kind: 'file-path', re: /\b[A-Za-z]:\\[\w.\-\\]+/ },
    { kind: 'file-path', re: /\b[\w-]+\.(?:java|kt|xml|properties|yml|yaml|jar|class)\b/ },
];

/** What an error body must never show: stack frames, class and package names, SQL, file paths. */
export function leaks(text: string): Leak[] {
    const scan = text.replace(JDK_TYPE, 'JDKTYPE');
    const found: Leak[] = [];
    for (const { kind, re } of PATTERNS) {
        const m = re.exec(scan);
        if (m) found.push({ kind, sample: m[0].trim().slice(0, 80) });
    }
    return found;
}

/** True when `secret` (a token, a password, a marker) appears in `text`. */
export const echoes = (text: string, secret: string): boolean => secret.length > 0 && text.includes(secret);

// ------------------------------------------------------------------ requests (what is sent) and the answer

/** One request of a table: exactly what the spec sends and what the unit test hands to `api.check`. */
export interface Req {
    method: 'GET' | 'POST' | 'TRACE';
    url: string;
    /** An object (sent as JSON), a Buffer (byte for byte), or a string (`text/plain` rows). */
    data?: unknown;
    headers?: Record<string, string>;
    /** The guard's own switch for identity headers (401 negatives). */
    identityOverride?: boolean;
}

/** `Req` as the arguments of `api.check(method, url, data, options)`. */
export function checkArgs(r: Req): [string, string, unknown, RequestShape] {
    const options: RequestShape = {};
    if (r.headers) options.headers = r.headers;
    if (r.identityOverride) options.identityOverride = true;
    return [r.method, r.url, r.data, options];
}

/** An answer as a `Probe` (status, headers, text, parsed JSON): the spec hands it the response of an anonymous GET. */
export async function answerOf(res: APIResponse): Promise<Probe> {
    const text = await res.text();
    const json = parsed(text);
    const headers = res.headers();
    return { status: res.status(), contentType: headers['content-type'] ?? '', headers, text, json, ms: 0 };
}

/** Sends one table request through the guarded context; a status never throws, the guard may still refuse the request. */
export async function sendReq(api: GuardedApi, r: Req, timeout = 30_000): Promise<Probe> {
    const started = Date.now();
    const res = await api.fetch(r.url, {
        method: r.method,
        timeout,
        ...(r.data !== undefined ? { data: r.data } : {}),
        ...(r.headers ? { headers: r.headers } : {}),
        ...(r.identityOverride ? { identityOverride: true } : {}),
    });
    const probe = await answerOf(res);
    probe.ms = Date.now() - started;
    return probe;
}

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

export const LISTINGS: readonly ListingSpec[] = [
    {
        key: 'certificates', url: '/api/v1/certificates',
        fields: { string: 'COMMON_NAME', list: 'KEY_SIZE', datetime: 'NOT_AFTER', nonSortable: 'PRIVATE_KEY', sortable: 'COMMON_NAME' },
        why: { number: 'the certificate catalogue has no NUMBER field (inventory-api rules §3.5; KEY_SIZE is a list)' },
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
        why: { number: 'the audit-log catalogue has no NUMBER field', nonSortable: 'the listing refuses every sort (RequestValidatorHelper.java:24-30): API-GEN-11 owns the sort contract' },
    },
    {
        key: 'oids', url: '/api/v1/oids/list', sortRefusedLabel: 'OID',
        fields: { string: 'OID_ENTRY_OID', list: 'OID_ENTRY_CATEGORY', sortable: 'OID_ENTRY_OID' },
        why: { number: 'the OID catalogue has no NUMBER field', datetime: 'the OID catalogue has no DATETIME field', nonSortable: 'the listing refuses every sort (RequestValidatorHelper.java:24-30)' },
    },
];

export const listing = (key: ResourceKey): ListingSpec => {
    const l = LISTINGS.find((x) => x.key === key);
    if (!l) throw new Error(`no listing ${key}`);
    return l;
};

const searchBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ filters: [], itemsPerPage: 10, pageNumber: 1, ...extra });
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

const refuse = (messages: readonly Oracle[], status = 422): Expectation => ({ status, messages });

export const CASES: readonly CaseDef[] = [
    // M1: PageRequest.of(pageNumber - 1, itemsPerPage) throws IllegalArgumentException (every listing: CertificateServiceImpl.java:608,
    // CryptographicKeyServiceImpl.java:938, DiscoveryServiceImpl.java:279, AuditLogServiceImpl.java:100, CustomOidEntryServiceImpl.java:416).
    { id: 'paging.itemsPerPage0', matrix: 'M1', rule: 'itemsPerPage 0 → 400 "The request could not be processed."', build: () => ({ data: searchBody({ itemsPerPage: 0 }), expect: { status: 400, message: MSG.paging } }) },
    { id: 'paging.pageNumber0', matrix: 'M1', rule: 'pageNumber 0 → 400 "The request could not be processed."', build: () => ({ data: searchBody({ pageNumber: 0 }), expect: { status: 400, message: MSG.paging } }) },
    { id: 'paging.itemsPerPageNegative', matrix: 'M1', rule: 'itemsPerPage -1 → 400 "The request could not be processed."', build: () => ({ data: searchBody({ itemsPerPage: -1 }), expect: { status: 400, message: MSG.paging } }) },
    { id: 'paging.pageNumberNegative', matrix: 'M1', rule: 'pageNumber -1 → 400 "The request could not be processed."', build: () => ({ data: searchBody({ pageNumber: -1 }), expect: { status: 400, message: MSG.paging } }) },
    // M2: Jackson (HttpMessageNotReadableException → ExceptionHandlingAdvice.java:387-400).
    { id: 'json.itemsPerPageOverflow', matrix: 'M2', rule: 'itemsPerPage 2147483648 (int overflow) → 400 "Unable to read HTTP message"', build: () => ({ data: Buffer.from('{"filters":[],"itemsPerPage":2147483648,"pageNumber":1}'), expect: { status: 400, message: MSG.unreadable } }) },
    { id: 'json.notJson', matrix: 'M2', rule: 'body not JSON → 400 "Unable to read HTTP message"', build: () => ({ data: Buffer.from('this is not json'), expect: { status: 400, message: MSG.unreadable } }) },
    { id: 'json.conditionCase', matrix: 'M2', rule: 'condition in the wrong case ("contains") → 400 "Unable to read HTTP message"', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'contains', 'x')] }), expect: { status: 400, message: MSG.unreadable } }) },
    { id: 'json.fieldSourceCase', matrix: 'M2', rule: 'fieldSource in the wrong case ("PROPERTY") → 400 "Unable to read HTTP message"', build: (l) => ({ data: searchBody({ filters: [{ fieldSource: 'PROPERTY', fieldIdentifier: l.fields.string, condition: 'EQUALS', value: 'x' }] }), expect: { status: 400, message: MSG.unreadable } }) },
    { id: 'json.directionCase', matrix: 'M2', rule: 'sort.direction in the wrong case ("ASC") → 400 "Unable to read HTTP message"', build: (l) => ({ data: searchBody({ sort: sortOn(l.fields.sortable, 'ASC') }), expect: { status: 400, message: MSG.unreadable } }) },
    // M3: bean validation runs before any service (SearchRequestDto is `@Valid @RequestBody` on every listing).
    { id: 'sort.blankIdentifier', matrix: 'M3', rule: 'sort.fieldIdentifier blank → 422 ["sort.fieldIdentifier must not be blank"]', build: () => ({ data: searchBody({ sort: sortOn('', 'asc') }), expect: refuse([MSG.blankSortIdentifier]) }) },
    { id: 'sort.nullDirection', matrix: 'M3', rule: 'sort.direction null → 422 ["sort.direction must not be null"]', build: (l) => ({ data: searchBody({ sort: sortOn(l.fields.sortable, null) }), expect: refuse([MSG.nullSortDirection]) }) },
    // M4: SortOrderBuilder.resolveField (unknown / not orderable) on the listings that sort; RequestValidatorHelper.java:24-30 on the others.
    {
        id: 'sort.unknownField', matrix: 'M4', rule: 'sort on an unknown field → 422 ["Unknown sort field identifier X."]; a listing that does not sort refuses any sort',
        build: (l) => ({
            data: searchBody({ sort: sortOn('QA_NO_SUCH_FIELD', 'asc') }),
            expect: refuse([l.sortRefusedLabel ? `Sorting is not supported for the ${l.sortRefusedLabel} listing.` : 'Unknown sort field identifier QA_NO_SUCH_FIELD.']),
        }),
    },
    {
        id: 'sort.nonSortableField', matrix: 'M4', rule: 'sort on a non-sortable field → 422 ["Field X cannot be used to order this listing."]',
        build: (l) => (l.fields.nonSortable
            ? { data: searchBody({ sort: sortOn(l.fields.nonSortable, 'asc') }), expect: refuse([`Field ${l.fields.nonSortable} cannot be used to order this listing.`]) }
            : { na: l.why.nonSortable ?? 'no non-sortable field' }),
    },
    // M5: FilterPredicatesBuilder.requireAdvertisedCondition (:390-402), before any predicate is built.
    {
        id: 'filter.conditionNotAdvertised.list', matrix: 'M5', rule: 'GREATER on a list field → 422 "Field X does not support the GREATER condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY."',
        build: (l) => ({
            data: searchBody({ filters: [prop(l.fields.list, 'GREATER', '1')] }),
            expect: { status: 422, extra: conditionSetCheck(l.fields.list, 'list'), messages: [new RegExp(`^Field ${l.fields.list} does not support the GREATER condition; it supports `)] },
        }),
    },
    {
        id: 'filter.conditionNotAdvertised.string', matrix: 'M5', rule: 'GREATER on a string field → 422 "Field X does not support the GREATER condition; it supports CONTAINS, … NOT_MATCHES."',
        build: (l) => ({
            data: searchBody({ filters: [prop(l.fields.string, 'GREATER', 'x')] }),
            expect: { status: 422, extra: conditionSetCheck(l.fields.string, 'string'), messages: [new RegExp(`^Field ${l.fields.string} does not support the GREATER condition; it supports `)] },
        }),
    },
    // M6: FilterPredicatesBuilder.getPropertyFilterPredicate (:436-440).
    { id: 'filter.valueMissing', matrix: 'M6', rule: 'CONTAINS without a value → 422 "Filter for field X with operator CONTAINS requires at least one value."', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'CONTAINS')] }), expect: refuse([`Filter for field ${l.fields.string} with operator CONTAINS requires at least one value.`]) }) },
    { id: 'filter.valueEmptyList', matrix: 'M6', rule: 'CONTAINS with value [] → 422 "Filter for field X with operator CONTAINS requires at least one value."', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'CONTAINS', [])] }), expect: refuse([`Filter for field ${l.fields.string} with operator CONTAINS requires at least one value.`]) }) },
    // M7: validateRegexForDbQuery (:960-971).
    { id: 'filter.regexInvalid', matrix: 'M7', rule: 'MATCHES with "(" → 422 "Input is not a valid regex: …"', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'MATCHES', '(')] }), expect: refuse([/^Input is not a valid regex: /]) }) },
    { id: 'filter.regexQuote', matrix: 'M7', rule: 'MATCHES with a \\Q literal → 422 "Literal quote sequences … are not supported in PostgreSQL POSIX regex"', build: (l) => ({ data: searchBody({ filters: [prop(l.fields.string, 'MATCHES', '\\Qabc')] }), expect: refuse(['Literal quote sequences \\Q, \\R, \\G, \\h, \\H, \\z, \\X, \\V are not supported in PostgreSQL POSIX regex']) }) },
    // M8: preparePropertyFilterValues (:1081-1099).
    { id: 'filter.durationInvalid', matrix: 'M8', rule: 'IN_NEXT "30 days" on a date-time field → 422 "Filter field value 30 days cannot be parsed to a Duration."', build: (l) => (l.fields.datetime ? { data: searchBody({ filters: [prop(l.fields.datetime, 'IN_NEXT', '30 days')] }), expect: refuse(['Filter field value 30 days cannot be parsed to a Duration.']) } : { na: l.why.datetime ?? 'no DATETIME field' }) },
    { id: 'filter.numberInvalid', matrix: 'M8', rule: 'EQUALS "abc" on a number field → 422 "Filter field value abc cannot be parsed as a Number."', build: (l) => (l.fields.number ? { data: searchBody({ filters: [prop(l.fields.number, 'EQUALS', 'abc')] }), expect: refuse(['Filter field value abc cannot be parsed as a Number.']) } : { na: l.why.number ?? 'no NUMBER field' }) },
    // M9: getAttributeFilterPredicate (:156-176), shared by every listing.
    { id: 'filter.attributeNoSuffix', matrix: 'M9', rule: 'custom-attribute identifier without |CONTENT_TYPE → 422 "Filter field identifier X does not name an attribute."', build: () => ({ data: searchBody({ filters: [{ fieldSource: 'custom', fieldIdentifier: 'qa-no-suffix', condition: 'EQUALS', value: 'x' }] }), expect: refuse(['Filter field identifier qa-no-suffix does not name an attribute.']) }) },
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
    for (const l of LISTINGS) {
        for (const c of CASES) {
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
    for (const l of LISTINGS) {
        for (const c of CASES) {
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

// ------------------------------------------------------------------ the run context (names, markers, probe uuids)

export interface Ctx {
    /** Base-36 stamp: `--repeat-each` safe names. */
    stamp: string;
    /** A run-prefixed name (`regName` of the spec). */
    name(suffix: string): string;
    /** A string no error body may repeat. */
    marker: string;
    /** A uuid the guard accepts as a probe (`api.probeUuid()`). */
    probe(): string;
}

export interface CtxSeams {
    /** `regName` of the run (`<run id>-<suffix>`). */
    regName(suffix: string): string;
    /** `api.probeUuid()`. */
    probe(): string;
    now?: () => number;
}

let counter = 0;
/** A 22-character run of base64 characters is a uuid-like token to the guard's free-text scan: names and markers avoid that length. */
const notUuidLike = (s: string): string => (/^[A-Za-z0-9+/_-]{22}(?:==)?$/.test(s) ? `${s}x` : s);

/** A fresh context per test execution (`--repeat-each` safe: the stamp is the clock in base 36 plus a counter). */
export function makeCtx(tag: string, seams: CtxSeams): Ctx {
    const stamp = `${(seams.now?.() ?? Date.now()).toString(36)}${(counter++).toString(36)}`;
    return {
        stamp,
        name: (suffix) => notUuidLike(seams.regName(`${suffix}-${stamp}`)),
        marker: notUuidLike(`qa-marker-${tag}-${stamp}`),
        probe: seams.probe,
    };
}

/** The `name` a create body carries (an object field, or `"name":"…"` in raw text), for recording an accidental creation. */
export function nameInBody(data: unknown): string | undefined {
    if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
        const n = (data as { name?: unknown }).name;
        return typeof n === 'string' && n.trim() ? n : undefined;
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : '';
    return /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
}

// ------------------------------------------------------------------ API-GEN-01: the battery of ≥ 40 refused requests

export interface BatteryRow {
    id: string;
    matrix: MatrixRow;
    resource: string;
    req: Req;
    expect: Expectation;
    /** The wording of the §1.3 row the request exercises (shown in the failure message). */
    rule: string;
    /** Strings the answer must not repeat (a credential, a marker). */
    echo?: readonly string[];
    /** The request is a refused create: an accidental 2xx must be recorded in the ledger before it fails. */
    creates?: 'groups';
    /** The row needs credentials the suite cannot present on a header-auth stack (skipped there, named in the spec). */
    needsToken?: boolean;
    /** The row is anonymous: not meaningful where a proxy adds the credentials (header auth). */
    anonymous?: boolean;
    note?: string;
}

/** Which (resource, case) pairs of the API-GEN-02 table the battery reuses, with the group they belong to. */
const PICKS: ReadonlyArray<[ResourceKey, CaseId]> = [
    ['certificates', 'paging.itemsPerPage0'], ['certificates', 'paging.pageNumber0'], ['certificates', 'paging.itemsPerPageNegative'], ['keys', 'paging.itemsPerPage0'],
    ['certificates', 'json.itemsPerPageOverflow'], ['certificates', 'json.notJson'], ['certificates', 'json.conditionCase'], ['certificates', 'json.fieldSourceCase'],
    ['certificates', 'json.directionCase'], ['discoveries', 'json.notJson'], ['auditLogs', 'json.itemsPerPageOverflow'],
    ['certificates', 'sort.blankIdentifier'], ['oids', 'sort.nullDirection'],
    ['certificates', 'sort.unknownField'], ['certificates', 'sort.nonSortableField'], ['keys', 'sort.nonSortableField'], ['auditLogs', 'sort.unknownField'], ['oids', 'sort.unknownField'],
    ['certificates', 'filter.conditionNotAdvertised.list'], ['keys', 'filter.conditionNotAdvertised.string'],
    ['certificates', 'filter.valueMissing'], ['discoveries', 'filter.valueEmptyList'],
    ['certificates', 'filter.regexInvalid'], ['auditLogs', 'filter.regexQuote'],
    ['certificates', 'filter.durationInvalid'], ['keys', 'filter.numberInvalid'],
    ['certificates', 'filter.attributeNoSuffix'], ['oids', 'filter.attributeNoSuffix'],
];

const gone = (what: string, id: string): RegExp => new RegExp(`^Object of type '${what}' identified by ${id} is not found\\.$`);

/**
 * The battery: ≥ 40 refused requests, each naming the §1.3 matrix row it exercises. Shape-only rows (the unsupported
 * Content-Type, known bug core#2140) accept 415 or 500: the contract they check is the SHAPE of the answer.
 * `tokens: false` drops the credential rows (a header-auth stack presents no bearer token).
 */
export function gen01Battery(ctx: Ctx): BatteryRow[] {
    const rows: BatteryRow[] = [];
    // M1–M9: the API-GEN-02 requests the shape battery shares.
    for (const [resource, caseId] of PICKS) {
        const c = listingCase(resource, caseId);
        rows.push({ id: `${c.matrix}.${c.id}`, matrix: c.matrix, resource, req: c.req, expect: c.expect, rule: c.rule, echo: [] });
    }
    // M3: columns[0] null on the keys listing (observed v422.search.columns-null).
    rows.push({ id: 'M3.keys.columnNull', matrix: 'M3', resource: 'keys', req: { method: 'POST', url: '/api/v1/keys', data: searchBody({ columns: [null] }) }, expect: refuse([MSG.nullColumn]), rule: 'columns[0] null → 422 ["columns[0] must not be null"]' });
    // M12: path and query type errors.
    const gets: Array<[string, string, string, Expectation, string]> = [
        ['M12.certificates.badUuid', 'certificates', '/api/v1/certificates/not-a-uuid', { status: 400, message: /^Method parameter 'uuid': Failed to convert value of type 'java\.lang\.String' to required type 'java\.util\.UUID'; Invalid UUID string: not-a-uuid$/ }, 'a bad uuid in a path variable → 400 "Method parameter \'uuid\': Failed to convert value …"'],
        ['M12.keys.badUuid', 'keys', '/api/v1/keys/not-a-uuid', refuse(['Invalid UUID not-a-uuid in the request']), 'a bad key uuid → 422 ["Invalid UUID … in the request"] (CryptographicKeyControllerImpl.getKey takes a String path variable and parses it with SecuredUUID.fromString)'],
        ['M12.groups.badUuid', 'groups', '/api/v1/groups/not-a-uuid', refuse(['Invalid UUID not-a-uuid in the request']), 'a bad group uuid → 422 ["Invalid UUID … in the request"] (SecuredUUID.java:22)'],
        ['M12.credentials.badUuid', 'credentials', '/api/v1/credentials/not-a-uuid', refuse(['Invalid UUID not-a-uuid in the request']), 'a bad credential uuid → 422 ["Invalid UUID … in the request"]'],
        ['M12.statistics.badBoolean', 'statistics', '/api/v1/statistics?includeArchived=maybe', { status: 400, message: /^Method parameter 'includeArchived': Failed to convert value of type 'java\.lang\.String' to required type 'boolean'; Invalid boolean value \[maybe\]$/ }, 'includeArchived=maybe → 400 "Method parameter … Invalid boolean value"'],
        ['M12.listViews.badResource', 'listViews', '/api/v1/listViews?resource=CERTIFICATES', refuse(['Unknown Resource Name CERTIFICATES']), 'a resource name in the wrong case → 422 ["Unknown Resource Name …"]'],
        ['M12.resources.badResource', 'resources', '/api/v1/resources/bogus/events', refuse(['Unknown Resource Name bogus']), 'an unknown resource in a path → 422 ["Unknown Resource Name …"]'],
        ['M12.scheduler.badInteger', 'scheduler', '/api/v1/scheduler/jobs?itemsPerPage=abc', { status: 422, messages: [/^itemsPerPage Failed to convert property value of type 'java\.lang\.String' to required type 'java\.lang\.Integer' for property 'itemsPerPage'; /] }, 'a non-numeric query DTO field → 422 ["itemsPerPage Failed to convert property value …"]'],
    ];
    for (const [id, resource, url, expect, rule] of gets) rows.push({ id, matrix: 'M12', resource, req: { method: 'GET', url }, expect, rule });
    // M13: unknown objects and an unmatched path.
    const unknown: Array<[string, string, string, string, string]> = [
        ['certificates', '/api/v1/certificates', 'Certificate', '', ''],
        ['groups', '/api/v1/groups', 'Group', '', ''],
        ['credentials', '/api/v1/credentials', 'Credential', '', ''],
        ['raProfiles', '/api/v1/raProfiles', 'RaProfile', '', ''],
        ['certificates', '/api/v1/certificates', 'Certificate', '/history', '.history'],
    ];
    for (const [resource, base, type, suffix, tag] of unknown) {
        const id = ctx.probe();
        rows.push({ id: `M13.${resource}${tag}.unknownUuid`, matrix: 'M13', resource, req: { method: 'GET', url: `${base}/${id}${suffix}` }, expect: { status: 404, message: gone(type, id) }, rule: `an unknown ${type} uuid → 404 "Object of type '${type}' identified by <uuid> is not found."` });
    }
    rows.push({ id: 'M13.nope.unmatchedPath', matrix: 'M13', resource: 'none', req: { method: 'GET', url: '/api/v1/nope' }, expect: { status: 404, message: 'No endpoint GET /api/v1/nope.' }, rule: 'an unmatched path → 404 "No endpoint GET /api/v1/nope."' });
    // M17: a defined path with a method it does not define (a GET on a POST-only path).
    rows.push({ id: 'M17.authorities.wrongMethod', matrix: 'M17', resource: 'authorities', req: { method: 'GET', url: '/api/v1/authorities/not-a-uuid/raProfiles' }, expect: { status: [400, 405], message: /^Request method 'GET' is not supported$/ }, rule: 'a GET on a POST-only path → 4xx {"message":"Request method \'GET\' is not supported"}' });
    // G1 / G2: refused creates (nothing is created: the core refuses before any write; an accidental 2xx is recorded by the spec).
    const group = (data: unknown): Req => ({ method: 'POST', url: '/api/v1/groups', data });
    rows.push({ id: 'G1.groups.emptyObject', matrix: 'G1', resource: 'groups', req: group({}), expect: refuse([MSG.nameEmpty]), rule: 'a group without a name → 422 ["Name must not be empty"]', creates: 'groups' });
    rows.push({ id: 'G1.groups.emptyName', matrix: 'G1', resource: 'groups', req: group({ name: '' }), expect: refuse([MSG.nameEmpty]), rule: 'a group with name "" → 422 ["Name must not be empty"]', creates: 'groups' });
    rows.push({ id: 'G1.groups.blankName', matrix: 'G1', resource: 'groups', req: group({ name: '   ' }), expect: refuse([MSG.nameEmpty]), rule: 'a group with name "   " → 422 ["Name must not be empty"]', creates: 'groups' });
    rows.push({ id: 'G2.groups.trailingComma', matrix: 'G2', resource: 'groups', req: group(Buffer.from(`{"name":"${ctx.name('gen01-tc')}",}`)), expect: { status: 400, message: MSG.unreadable }, rule: 'a group body with a trailing comma → 400 "Unable to read HTTP message"', creates: 'groups' });
    rows.push({ id: 'G2.groups.nameObject', matrix: 'G2', resource: 'groups', req: group({ name: { a: ctx.marker } }), expect: { status: 400, message: MSG.unreadable }, rule: 'a group whose name is an object → 400 "Unable to read HTTP message"', echo: [ctx.marker], creates: 'groups' });
    rows.push({
        id: 'G1.credentials.emptyName', matrix: 'G1', resource: 'credentials',
        req: { method: 'POST', url: '/api/v1/credentials', data: { name: '', connectorUuid: ctx.probe(), kind: 'Basic', attributes: [] } },
        expect: refuse([MSG.nameEmpty]), rule: 'a credential with name "" → 422 ["Name must not be empty"] (checked before the connector lookup)',
    });
    // C1: the unsupported Content-Type answers 415 (core#2140: 500 today); here only the SHAPE of whatever answers.
    rows.push({ id: 'C1.groups.textPlain', matrix: 'C1', resource: 'groups', req: { method: 'POST', url: '/api/v1/groups', data: '{"name":""}', headers: { 'content-type': 'text/plain' } }, expect: { status: [415, 500] }, rule: 'text/plain on a JSON create → 415 (500 today, core#2140): the answer keeps the contract shape', note: 'status is judged by API-GEN-06; the shape and the leak scan here' });
    rows.push({ id: 'C1.certificates.textPlain', matrix: 'C1', resource: 'certificates', req: { method: 'POST', url: '/api/v1/certificates', data: JSON.stringify(searchBody()), headers: { 'content-type': 'text/plain' } }, expect: { status: [415, 500] }, rule: 'text/plain on a JSON search → 415 (500 today, core#2140): the answer keeps the contract shape', note: 'status is judged by API-GEN-06; the shape and the leak scan here' });
    return rows;
}

/** The credential rows of API-GEN-01 (a 401 body does not echo the token); the spec skips them on a header-auth stack. */
export function gen01AuthRows(ctx: Ctx): BatteryRow[] {
    const bearer = `Bearer ${ctx.marker}`;
    const basic = `Basic ${Buffer.from(`${ctx.marker}:${ctx.marker}`).toString('base64')}`;
    return [
        { id: 'A1.groups.anonymous', matrix: 'A1', resource: 'groups', req: { method: 'GET', url: '/api/v1/groups' }, expect: { status: 401 }, rule: 'no credentials → 401, no data in the body', anonymous: true },
        { id: 'A1.certificates.garbageBearer', matrix: 'A1', resource: 'certificates', req: { method: 'GET', url: '/api/v1/certificates/search', headers: { authorization: bearer }, identityOverride: true }, expect: { status: 401 }, rule: 'a garbage Bearer token → 401, the body and WWW-Authenticate do not echo it', echo: [ctx.marker], needsToken: true },
        { id: 'A1.keys.garbageBearer', matrix: 'A1', resource: 'keys', req: { method: 'GET', url: '/api/v1/keys/search', headers: { authorization: bearer }, identityOverride: true }, expect: { status: 401 }, rule: 'a garbage Bearer token → 401, the body and WWW-Authenticate do not echo it', echo: [ctx.marker], needsToken: true },
        { id: 'A1.credentials.garbageBasic', matrix: 'A1', resource: 'credentials', req: { method: 'GET', url: '/api/v1/credentials', headers: { authorization: basic }, identityOverride: true }, expect: { status: 401 }, rule: 'a garbage Basic header → 401, the body does not echo it', echo: [ctx.marker, basic.slice('Basic '.length)], needsToken: true },
    ];
}

// ------------------------------------------------------------------ API-GEN-03: the 5 MiB upload limit (guard-refused routes)

/** `UploadedFile.MAXIMUM_LENGTH` (interfaces core/secret/UploadedFile.java:25). */
export const UPLOAD_LIMIT = 5 * 1024 * 1024;
/** Characters of the base64 text of `bytes` decoded bytes. */
export const encodedLength = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export type UploadRoute = 'inspections' | 'import';
export const UPLOAD_ROUTES: Record<UploadRoute, string> = { inspections: '/api/v1/inspections', import: '/api/v1/certificates/import' };

/** 64 lowercase hex characters: the shape of an entry reference (CertificateImportServiceImpl.java:109); it names nothing the file holds. */
export const PLACEHOLDER_ENTRY = `${'0'.repeat(63)}1`;

/** Garbage the platform cannot read as any container: `bytes` bytes of the letter A (decodes to a base64 text of zero bytes). */
export const garbageBytes = (bytes: number): Buffer => Buffer.alloc(bytes, 0x41);

/** The JSON body of an upload route whose decoded file is `bytes` long; an import names one placeholder entry. */
export function uploadBody(route: UploadRoute, bytes: number): { file: string; entries?: Array<{ entryReference: string }> } {
    const file = garbageBytes(bytes).toString('base64');
    return route === 'import' ? { file, entries: [{ entryReference: PLACEHOLDER_ENTRY }] } : { file };
}

export interface SizeRow {
    id: string;
    bytes: number;
    /** `format`: the size rule passes and the container reader refuses the garbage; `limit`: the size rule refuses. */
    outcome: 'format' | 'limit';
    rule: string;
}

export const SIZE_ROWS: readonly SizeRow[] = [
    { id: '5242880', bytes: UPLOAD_LIMIT, outcome: 'format', rule: '5 242 880 decoded bytes pass the size rule and answer the format refusal (UploadedFile.MAXIMUM_LENGTH; ContainerRefusal.java:13-15)' },
    { id: '5242881', bytes: UPLOAD_LIMIT + 1, outcome: 'limit', rule: '5 242 881 decoded bytes → 422 ["fileWithinLimit file must not exceed 5242880 bytes"] (UploadRequestDto.java:46-51)' },
    { id: '6MiB', bytes: 6 * 1024 * 1024, outcome: 'limit', rule: '6 MiB → 422 ["fileWithinLimit file must not exceed 5242880 bytes"]; never 413 (inventory-api rules §1.2 r5)' },
];

/** The oracle of one upload row: a 422 with the size text or the format text; never 413, never 5xx. */
export function sizeProblems(row: SizeRow, a: Answer): string[] {
    const problems: string[] = [];
    if (a.status === 413) problems.push('413: core has no 413 path (inventory-api rules §1.2 r5); a 413 comes from a proxy in front of it');
    if (a.status >= 500) problems.push(`${a.status}: a refused upload must never be a server error`);
    const expectation: Expectation = row.outcome === 'limit'
        ? { status: 422, messages: [MSG.oversize] }
        : { status: 422, messages: [MSG.notSupportedFormat] };
    problems.push(...judge(expectation, a));
    return problems;
}

// ------------------------------------------------------------------ API-GEN-05: the JSON parsing battery

export type JsonTarget = 'certificates' | 'groups';

export interface JsonRow {
    /** `<target>.<case>` */
    id: string;
    target: JsonTarget;
    /** The raw bytes (a Buffer: a string body that is not JSON is re-quoted by the guard). */
    data: Buffer;
    /**
     * `p1`: the documented refusal; `control`: a well-formed request that must NOT be refused (the 400s are the defect's, not the
     * body's); `pin`: today's behaviour where no written rule exists (never P1).
     */
    kind: 'p1' | 'control' | 'pin';
    expect: Expectation;
    rule: string;
    /** Pins: the open question that flips the pin. */
    pin?: string;
    /** The guard refuses this body (a duplicate key on a create): the row is a `test.fixme`. */
    guardRefused?: string;
    echo?: readonly string[];
}

const nest = (depth: number, leaf = '1'): string => '['.repeat(depth) + leaf + ']'.repeat(depth);

/** The search page shape (CertificateResponseDto): used by the control and pin rows that are answered 200. */
function searchPageProblems(p: { status: number; json: unknown }): string[] {
    if (p.status !== 200) return [];
    const j = p.json as { certificates?: unknown; itemsPerPage?: unknown; pageNumber?: unknown } | undefined;
    return j && Array.isArray(j.certificates) && typeof j.itemsPerPage === 'number' && typeof j.pageNumber === 'number' ? [] : ['a 200 answer must be a search page {certificates, itemsPerPage, pageNumber, …}'];
}

const unreadable: Expectation = { status: 400, message: MSG.unreadable };

/**
 * The parsing battery of API-GEN-05 on `POST /api/v1/certificates` (a read) and `POST /api/v1/groups` (refused, creates
 * nothing). Oracles: the 400 text of inventory-api rules §1.3, observed on both builds by the ilm#442 `js.*` probes
 * (trailing comma, comment, NaN, filters as an object / string, nesting); derived from Jackson for the rest. Two rows
 * contradict the written §1.4 line and are pins: a duplicate key is NOT refused (Jackson keeps the last value: the
 * `js.dup-key` probe answered 200 on both builds), and a leading BOM is skipped by Jackson (status pinned from the first
 * probe).
 */
export function jsonBattery(ctx: Ctx): JsonRow[] {
    const m = ctx.marker;
    const base = '"itemsPerPage":10,"pageNumber":1,"filters":[]';
    const group = ctx.name('gen05');
    const t = (s: string): Buffer => Buffer.from(s, 'utf8');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const rows: JsonRow[] = [
        // --- POST /api/v1/certificates (read-only)
        { id: 'certificates.control', target: 'certificates', kind: 'control', data: t(`{${base}}`), expect: { status: 200, extra: searchPageProblems }, rule: 'a well-formed search body is answered 200 (the control of the refusals below)' },
        { id: 'certificates.trailing-comma', target: 'certificates', kind: 'p1', data: t(`{${base},}`), expect: unreadable, rule: 'a trailing comma → 400 "Unable to read HTTP message" (ilm#442 js.trailing-comma)' },
        { id: 'certificates.trailing-comma-marker', target: 'certificates', kind: 'p1', data: t(`{${base},"note":"${m}",}`), expect: unreadable, echo: [m], rule: 'the parser\'s message quotes the token it stopped at, a body can carry a secret: the answer never echoes it (ExceptionHandlingAdvice.java:388-398)' },
        { id: 'certificates.comment-block', target: 'certificates', kind: 'p1', data: t(`/*c*/{${base}}`), expect: unreadable, rule: 'a block comment → 400 (ilm#442 js.comment)' },
        { id: 'certificates.comment-line', target: 'certificates', kind: 'p1', data: t(`// c\n{${base}}`), expect: unreadable, rule: 'a line comment → 400 (Jackson ALLOW_COMMENTS is off)' },
        { id: 'certificates.nan', target: 'certificates', kind: 'p1', data: t('{"itemsPerPage":NaN,"pageNumber":1,"filters":[]}'), expect: unreadable, rule: 'NaN → 400 (ilm#442 js.nan)' },
        { id: 'certificates.nesting-25', target: 'certificates', kind: 'p1', data: t(`{"itemsPerPage":10,"pageNumber":1,"filters":${nest(25, '{}')}}`), expect: unreadable, rule: '25-level nesting in `filters` → 400 (an array where an object is expected; ilm#442 js.depth)' },
        { id: 'certificates.body-null', target: 'certificates', kind: 'p1', data: t('null'), expect: unreadable, rule: 'body null → 400 "Unable to read HTTP message" (a required request body that reads as null)' },
        { id: 'certificates.body-array', target: 'certificates', kind: 'p1', data: t('[]'), expect: unreadable, rule: 'body [] → 400 (an array for an object)' },
        { id: 'certificates.body-array-marker', target: 'certificates', kind: 'p1', data: t(`["${m}"]`), expect: unreadable, echo: [m], rule: 'body ["<marker>"] → 400, the marker is not echoed' },
        { id: 'certificates.body-string', target: 'certificates', kind: 'p1', data: t(`"${m}"`), expect: unreadable, echo: [m], rule: 'body "<marker>" → 400, the marker is not echoed (a string for an object)' },
        { id: 'certificates.body-number', target: 'certificates', kind: 'p1', data: t('123'), expect: unreadable, rule: 'body 123 → 400 (a number for an object)' },
        { id: 'certificates.filters-object', target: 'certificates', kind: 'p1', data: t('{"itemsPerPage":10,"pageNumber":1,"filters":{}}'), expect: unreadable, rule: '`filters` as an object → 400 (ilm#442 js.filters-object)' },
        { id: 'certificates.filters-string', target: 'certificates', kind: 'p1', data: t('{"itemsPerPage":10,"pageNumber":1,"filters":"all"}'), expect: unreadable, rule: '`filters` as a string → 400 (ilm#442 js.wrong-type.filters-string)' },
        { id: 'certificates.itemsPerPage-abc', target: 'certificates', kind: 'p1', data: t('{"itemsPerPage":"abc","pageNumber":1,"filters":[]}'), expect: unreadable, rule: '`itemsPerPage: "abc"` → 400 (a string that is no integer)' },
        { id: 'certificates.includeArchived-yes', target: 'certificates', kind: 'p1', data: t(`{${base},"includeArchived":"yes"}`), expect: unreadable, rule: '`includeArchived: "yes"` → 400 (a string that is no boolean)' },
        { id: 'certificates.duplicate-keys', target: 'certificates', kind: 'pin', pin: 'Q-JSON-DUP', data: t('{"itemsPerPage":10,"itemsPerPage":20,"pageNumber":1,"filters":[]}'), expect: { status: 200, extra: searchPageProblems }, rule: 'a duplicate key is not refused: Jackson keeps the last value (ilm#442 js.dup-key answered 200 on both builds); rules §1.4 says 400 — conflict, open question' },
        { id: 'certificates.bom', target: 'certificates', kind: 'pin', pin: 'Q-JSON-BOM', data: Buffer.concat([bom, t(`{${base}}`)]), expect: { status: [200, 400], extra: (p) => (p.status === 200 ? searchPageProblems(p) : []) }, rule: 'a leading UTF-8 BOM is skipped by Jackson (200) or refused (400): status pinned from the first probe, never 5xx' },
        // --- POST /api/v1/groups (refused: every body is rejected before any write; an accidental 2xx is recorded)
        { id: 'groups.trailing-comma', target: 'groups', kind: 'p1', data: t(`{"name":"${group}","description":"${m}",}`), expect: unreadable, echo: [m], rule: 'a trailing comma → 400, nothing created' },
        { id: 'groups.comment-block', target: 'groups', kind: 'p1', data: t(`/*c*/{"name":"${group}"}`), expect: unreadable, rule: 'a block comment → 400, nothing created' },
        { id: 'groups.comment-line', target: 'groups', kind: 'p1', data: t(`// c\n{"name":"${group}"}`), expect: unreadable, rule: 'a line comment → 400, nothing created' },
        { id: 'groups.nan', target: 'groups', kind: 'p1', data: t(`{"name":"${group}","description":NaN}`), expect: unreadable, rule: 'NaN → 400, nothing created' },
        { id: 'groups.nesting-25', target: 'groups', kind: 'p1', data: t(`{"name":"${group}","customAttributes":${nest(25, '{}')}}`), expect: unreadable, rule: '25-level nesting in `customAttributes` → 400, nothing created' },
        { id: 'groups.body-null', target: 'groups', kind: 'p1', data: t('null'), expect: unreadable, rule: 'body null → 400 (a required request body; 422 would also be a refusal, never a creation)' },
        { id: 'groups.body-array', target: 'groups', kind: 'p1', data: t('[]'), expect: unreadable, rule: 'body [] → 400' },
        { id: 'groups.body-array-marker', target: 'groups', kind: 'p1', data: t(`["${m}"]`), expect: unreadable, echo: [m], rule: 'body ["<marker>"] → 400, the marker is not echoed' },
        { id: 'groups.body-string', target: 'groups', kind: 'p1', data: t(`"${m}"`), expect: unreadable, echo: [m], rule: 'body "<marker>" → 400, the marker is not echoed' },
        { id: 'groups.body-number', target: 'groups', kind: 'p1', data: t('123'), expect: unreadable, rule: 'body 123 → 400' },
        { id: 'groups.name-object', target: 'groups', kind: 'p1', data: t(`{"name":{"a":"${m}"}}`), expect: unreadable, echo: [m], rule: '`name` as an object → 400, the marker is not echoed' },
        { id: 'groups.description-array', target: 'groups', kind: 'p1', data: t(`{"name":"${group}","description":["${m}"]}`), expect: unreadable, echo: [m], rule: '`description` as an array → 400, nothing created' },
        { id: 'groups.blank-name-control', target: 'groups', kind: 'control', data: t('{"name":""}'), expect: { status: 422, messages: [MSG.nameEmpty] }, rule: 'a well-formed body with a blank name is parsed and refused by the business rule: 422 ["Name must not be empty"] (the control of the refusals above)' },
        { id: 'groups.bom', target: 'groups', kind: 'pin', pin: 'Q-JSON-BOM', data: Buffer.concat([bom, t('{"name":""}')]), expect: { status: [400, 422], extra: (p) => (p.status === 422 && !(Array.isArray(p.json) && p.json.length === 1 && p.json[0] === MSG.nameEmpty) ? ['a 422 must be ["Name must not be empty"]'] : []) }, rule: 'BOM + a blank name: Jackson skips the BOM (422 ["Name must not be empty"]) or refuses it (400); either way nothing is created' },
        { id: 'groups.duplicate-keys', target: 'groups', kind: 'pin', pin: 'Q-JSON-DUP', guardRefused: 'a JSON body with a duplicate key is refused by the guard (guardedApi.ts judge step 4: readers disagree on which value wins)', data: t('{"name":"","name":""}'), expect: { status: 422, messages: [MSG.nameEmpty] }, rule: 'a duplicate key with blank names: refused by the business rule whichever value wins (422); the parser does not refuse it' },
    ];
    return rows;
}

/** The JSON rows of the P1 test (documented refusals and controls) and of the pin tests. */
export const jsonRowsOf = (rows: readonly JsonRow[], kind: JsonRow['kind']): JsonRow[] => rows.filter((r) => r.kind === kind);

/** The `Req` of a JSON row. */
export const jsonReq = (r: JsonRow): Req => ({ method: 'POST', url: r.target === 'certificates' ? '/api/v1/certificates' : '/api/v1/groups', data: r.data });

// ------------------------------------------------------------------ API-GEN-06: Content-Type and Accept

export interface ContentTypeRow {
    id: string;
    /** What is sent as the content type; `none`: a body with no content type header (Playwright then sends application/octet-stream). */
    contentType: string;
    url: string;
    resource: string;
    /** `guard`: refused by the guard today (the reason); undefined: sendable now. */
    guardRefused?: string;
    data: string;
}

/** A search body / a blank-name group: whatever answers them, nothing can be created or changed. */
const SEARCH_TEXT = JSON.stringify(searchBody());
const BLANK_GROUP_TEXT = '{"name":""}';

export const CONTENT_TYPE_ROWS: readonly ContentTypeRow[] = [
    { id: 'text-plain.search', contentType: 'text/plain', url: '/api/v1/certificates', resource: 'certificates', data: SEARCH_TEXT },
    { id: 'text-plain.create', contentType: 'text/plain', url: '/api/v1/groups', resource: 'groups', data: BLANK_GROUP_TEXT },
    { id: 'application-xml.create', contentType: 'application/xml', url: '/api/v1/groups', resource: 'groups', data: '<group><name></name></group>', guardRefused: 'the guard sends application/json or text/plain only (guardedApi.ts headerProblem: "a content type other than application/json or text/plain")' },
    { id: 'multipart.create', contentType: 'multipart/form-data; boundary=qa-gen06', url: '/api/v1/groups', resource: 'groups', data: '--qa-gen06\r\nContent-Disposition: form-data; name="name"\r\n\r\n\r\n--qa-gen06--\r\n', guardRefused: 'the guard refuses a form / multipart content type (guardedApi.ts headerProblem: the server reads form fields as request parameters)' },
    { id: 'no-content-type.create', contentType: 'none', url: '/api/v1/groups', resource: 'groups', data: BLANK_GROUP_TEXT, guardRefused: 'the guard sets content-type: application/json on every body it sends (snapshot: `headers[\'content-type\'] = JSON_CONTENT`); a body with no content type cannot be expressed' },
];

/** The request of a content-type row (a string body; under text/plain the guard sends it as written). */
export const contentTypeReq = (r: ContentTypeRow): Req => ({
    method: 'POST', url: r.url, data: r.data,
    ...(r.contentType === 'none' ? {} : { headers: { 'content-type': r.contentType } }),
});

/** The Accept probe: a JSON endpoint asked for XML (status pinned from the first probe). */
export const ACCEPT_XML: Req = { method: 'GET', url: '/api/v1/groups', headers: { accept: 'application/xml' } };

/** API-GEN-06 `[accept-xml]`: a 4xx (with the contract shape when it has a body), or a 200 whose body is JSON; never a 5xx. */
export function acceptProblems(a: Answer): string[] {
    const out: string[] = [];
    if (a.status >= 200 && a.status < 300) {
        if (!JSON_TYPE.test(a.contentType) || parsed(a.text) === undefined) out.push(`a ${a.status} answer to Accept: application/xml must be JSON; got content-type ${JSON.stringify(a.contentType)}`);
    } else if (a.status >= 400 && a.status < 500) {
        if (a.status !== 401 && a.status !== 403 && a.text.trim() !== '') out.push(...shapeProblems(a.status, a.contentType, a.text));
    } else {
        out.push(`status ${a.status}: Accept: application/xml must answer a 4xx or a JSON 200, never a server error; ${preview(a.text)}`);
    }
    for (const l of leaks(a.text)) out.push(`the answer leaks internals (${l.kind}): ${JSON.stringify(l.sample)}`);
    return out;
}

// ------------------------------------------------------------------ API-GEN-07: refused methods

export interface TraceRow {
    id: string;
    url: string;
}

/** TRACE on plain read paths (the guard sends TRACE as a bodyless read; a path that persists for a GET is refused outright). */
export const TRACE_ROWS: readonly TraceRow[] = [
    { id: 'trace.info', url: '/api/v1/info' },
    { id: 'trace.certificates', url: '/api/v1/certificates' },
    { id: 'trace.groups', url: '/api/v1/groups' },
];

/** A GET on a path that only defines POST: a defined path with a method it does not define (HttpRequestMethodNotSupportedException). */
export const WRONG_METHOD_GETS: readonly string[] = [
    '/api/v1/auditLogs', '/api/v1/auditLogs/export', '/api/v1/auditLogs/purge', '/api/v1/inspections', '/api/v1/keys',
];

export interface GuardRefusedMethodRow {
    id: string;
    method: string;
    url: string;
    why: string;
}

/** Requests the guard sends since the guard pass (GD-11): the unknown-method sentinel QAPROBE and the two no-handler pairs (every one is answered by the handler mapping, no handler runs). */
export const METHOD_FIXME_ROWS: readonly GuardRefusedMethodRow[] = [
    { id: 'unknown-method.groups', method: 'QAPROBE', url: '/api/v1/groups', why: 'an unknown method: the guard (GD-11) sends only the sentinels TRACE and QAPROBE; PROPFIND / FOO / lower-case stay refused, so the row uses QAPROBE' },
    { id: 'wrong-method.POST-statistics', method: 'POST', url: '/api/v1/statistics', why: 'a mutation without a uuid in the path that is neither an allow-listed create nor a bulk route' },
    { id: 'wrong-method.DELETE-info', method: 'DELETE', url: '/api/v1/info', why: 'a mutation without a uuid in the path that is neither an allow-listed create nor a bulk route' },
];

/** The wrong-method answer: a 4xx with the API-GEN-01 body shape (never 5xx). */
export const wrongMethodExpectation = (method: string): Expectation => ({ status: [400, 405], message: new RegExp(`^Request method '${method}' is not supported`) });

// ------------------------------------------------------------------ API-GEN-08: the security chain

export interface Protected {
    resource: string;
    url: string;
}

/** ≥ 20 protected GET endpoints across resources (each a read-only controller mapping in `interfaces`; none persists anything). */
export const PROTECTED: readonly Protected[] = [
    { resource: 'certificates', url: '/api/v1/certificates/search' },
    { resource: 'keys', url: '/api/v1/keys/search' },
    { resource: 'discoveries', url: '/api/v1/discoveries/search' },
    { resource: 'groups', url: '/api/v1/groups' },
    { resource: 'credentials', url: '/api/v1/credentials' },
    { resource: 'raProfiles', url: '/api/v1/raProfiles' },
    { resource: 'authorities', url: '/api/v1/authorities' },
    { resource: 'connectors', url: '/api/v1/connectors' },
    { resource: 'users', url: '/api/v1/users' },
    { resource: 'roles', url: '/api/v1/roles' },
    { resource: 'acmeProfiles', url: '/api/v1/acmeProfiles' },
    { resource: 'scepProfiles', url: '/api/v1/scepProfiles' },
    { resource: 'cmpProfiles', url: '/api/v1/cmpProfiles' },
    { resource: 'listViews', url: '/api/v1/listViews' },
    { resource: 'statistics', url: '/api/v1/statistics' },
    { resource: 'customAttributes', url: '/api/v1/attributes/custom' },
    { resource: 'auditLogs', url: '/api/v1/auditLogs/search' },
    { resource: 'oids', url: '/api/v1/oids/search' },
    { resource: 'trustedCertificates', url: '/api/v1/trustedCertificates' },
    { resource: 'tokens', url: '/api/v1/tokens' },
    { resource: 'entities', url: '/api/v1/entities/search' },
    { resource: 'locations', url: '/api/v1/locations/search' },
    { resource: 'secrets', url: '/api/v1/secrets/search' },
    { resource: 'vaults', url: '/api/v1/vaults/search' },
    { resource: 'notificationProfiles', url: '/api/v1/notificationProfiles' },
    { resource: 'complianceProfiles', url: '/api/v1/complianceProfiles' },
    { resource: 'approvalProfiles', url: '/api/v1/approvalProfiles' },
    { resource: 'settings', url: '/api/v1/settings/platform' },
    { resource: 'enums', url: '/api/v1/enums' },
    { resource: 'resources', url: '/api/v1/resources' },
    { resource: 'profile', url: '/api/v1/auth/profile' },
    { resource: 'info', url: '/api/v1/info' },
];

export type Identity = 'none' | 'garbage-bearer' | 'garbage-jwt' | 'alg-none' | 'garbage-basic' | 'tampered-bearer';

/** base64url without padding (RFC 7515 §2). */
export const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

export interface ForgeOptions {
    /** The `alg` header value (default `none`). */
    alg?: string;
    /** Claims of the forged token (fixed by the caller; nothing of a real identity). */
    claims?: Record<string, unknown>;
}

/** An unsecured JWT (RFC 7519 §6): `{"alg":"none"}` header, claims, an EMPTY signature segment. */
export function forgeAlgNone(opts: ForgeOptions = {}): string {
    const header = { alg: opts.alg ?? 'none', typ: 'JWT' };
    const claims = opts.claims ?? { sub: 'qa-forged', iat: 1_700_000_000, exp: 4_102_444_800 };
    return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.`;
}

/**
 * The token with ONE character of its signature segment changed (a valid token that no longer verifies): the third
 * character of the signature, never the last one (the last character of a base64url signature may carry only padding bits).
 */
export function tamperToken(token: string): string {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[2].length < 4) throw new Error('not a signed JWT (three segments, a signature of at least 4 characters)');
    const sig = parts[2];
    const i = 2;
    const swapped = sig[i] === 'A' ? 'B' : 'A';
    return [parts[0], parts[1], `${sig.slice(0, i)}${swapped}${sig.slice(i + 1)}`].join('.');
}

/** The Authorization header value of a fabricated identity (never the run's own token), or undefined for `none` / `tampered-bearer`. */
export function authorizationOf(identity: Identity, marker: string): string | undefined {
    switch (identity) {
        case 'garbage-bearer': return `Bearer ${marker}`;
        case 'garbage-jwt': return `Bearer ${b64url('{"alg":"RS256"}')}.${b64url(`{"sub":"${marker}"}`)}.${b64url('not-a-signature')}`;
        case 'alg-none': return `Bearer ${forgeAlgNone({ claims: { sub: marker, iat: 1_700_000_000, exp: 4_102_444_800 } })}`;
        case 'garbage-basic': return `Basic ${Buffer.from(`${marker}:${marker}`).toString('base64')}`;
        default: return undefined;
    }
}

/** The credential strings an answer must not repeat. */
export function secretsOf(authorization: string | undefined, marker: string): string[] {
    if (!authorization) return [];
    const value = authorization.replace(/^(?:Bearer|Basic) /, '');
    return [...new Set([marker, value, ...value.split('.').filter((s) => s.length >= 8)])];
}

/** An identity row request: a GET with the fabricated Authorization header (`identityOverride`, the guard's switch for 401 negatives). */
export const identityReq = (url: string, authorization: string): Req => ({ method: 'GET', url, headers: { authorization }, identityOverride: true });

export const ANONYMOUS_HEALTH = [
    { id: 'health', path: '/api/v1/health', exactBody: false },
    { id: 'liveness', path: '/api/v1/health/liveness', exactBody: true },
    { id: 'readiness', path: '/api/v1/health/readiness', exactBody: true },
] as const;
