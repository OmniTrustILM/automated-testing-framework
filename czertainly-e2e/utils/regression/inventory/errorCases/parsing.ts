/**
 * parsing — the request-parsing rows of the error-contract spec.
 *
 * Data rows for the JSON parsing battery, the content-type and Accept rows, TRACE, and the wrong-method rows (marking
 * the ones the guard refuses before sending). Malformed bodies, content types and methods are where a framework
 * migration changes behaviour first.
 */
import { ERROR_MESSAGES, searchBody } from './cases';
import { Answer, Expectation, JSON_TYPE, findLeaks, parsed, preview, shapeProblems } from './checks';
import { Ctx, Req } from './requests';

// ------------------------------------------------------------------ API-GEN-05: the JSON parsing battery

type JsonTarget = 'certificates' | 'groups';

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

const unreadable: Expectation = { status: 400, message: ERROR_MESSAGES.unreadable };

/**
 * The parsing battery of API-GEN-05 on `POST /api/v1/certificates` (a read) and `POST /api/v1/groups` (refused, creates nothing). Oracles:
 * the 400 text of the inventory API status matrix, observed on both builds by the ilm#442 `js.*` probes (trailing comma, comment, NaN,
 * filters as an object / string, nesting); derived from Jackson for the rest. Two rows contradict the written error-shape rule and are
 * pins: a duplicate key is NOT refused (Jackson keeps the last value: the `js.dup-key` probe answered 200 on both builds), and a leading
 * BOM is skipped by Jackson (status pinned from the first probe).
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
        { id: 'certificates.trailing-comma-marker', target: 'certificates', kind: 'p1', data: t(`{${base},"note":"${m}",}`), expect: unreadable, echo: [m], rule: 'the parser\'s message quotes the token it stopped at, a body can carry a secret: the answer never echoes it (ExceptionHandlingAdvice.java)' },
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
        { id: 'certificates.duplicate-keys', target: 'certificates', kind: 'pin', pin: 'json-duplicate-keys', data: t('{"itemsPerPage":10,"itemsPerPage":20,"pageNumber":1,"filters":[]}'), expect: { status: 200, extra: searchPageProblems }, rule: 'a duplicate key is not refused: Jackson keeps the last value (ilm#442 js.dup-key answered 200 on both builds); the documented rule says 400 — conflict, open question' },
        { id: 'certificates.bom', target: 'certificates', kind: 'pin', pin: 'json-byte-order-mark', data: Buffer.concat([bom, t(`{${base}}`)]), expect: { status: [200, 400], extra: (p) => (p.status === 200 ? searchPageProblems(p) : []) }, rule: 'a leading UTF-8 BOM is skipped by Jackson (200) or refused (400): status pinned from the first probe, never 5xx' },
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
        { id: 'groups.blank-name-control', target: 'groups', kind: 'control', data: t('{"name":""}'), expect: { status: 422, messages: [ERROR_MESSAGES.nameEmpty] }, rule: 'a well-formed body with a blank name is parsed and refused by the business rule: 422 ["Name must not be empty"] (the control of the refusals above)' },
        { id: 'groups.bom', target: 'groups', kind: 'pin', pin: 'json-byte-order-mark', data: Buffer.concat([bom, t('{"name":""}')]), expect: { status: [400, 422], extra: (p) => (p.status === 422 && !(Array.isArray(p.json) && p.json.length === 1 && p.json[0] === ERROR_MESSAGES.nameEmpty) ? ['a 422 must be ["Name must not be empty"]'] : []) }, rule: 'BOM + a blank name: Jackson skips the BOM (422 ["Name must not be empty"]) or refuses it (400); either way nothing is created' },
        { id: 'groups.duplicate-keys', target: 'groups', kind: 'pin', pin: 'json-duplicate-keys', guardRefused: 'a JSON body with a duplicate key is refused by the guard (guard/createGuard.ts checkRequest step 4: readers disagree on which value wins)', data: t('{"name":"","name":""}'), expect: { status: 422, messages: [ERROR_MESSAGES.nameEmpty] }, rule: 'a duplicate key with blank names: refused by the business rule whichever value wins (422); the parser does not refuse it' },
    ];
    return rows;
}

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
    { id: 'application-xml.create', contentType: 'application/xml', url: '/api/v1/groups', resource: 'groups', data: '<group><name></name></group>', guardRefused: 'the guard sends application/json or text/plain only (guard/headers.ts headerProblem: "a content type other than application/json or text/plain")' },
    { id: 'multipart.create', contentType: 'multipart/form-data; boundary=qa-gen06', url: '/api/v1/groups', resource: 'groups', data: '--qa-gen06\r\nContent-Disposition: form-data; name="name"\r\n\r\n\r\n--qa-gen06--\r\n', guardRefused: 'the guard refuses a form / multipart content type (guard/headers.ts headerProblem: the server reads form fields as request parameters)' },
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
    for (const l of findLeaks(a.text)) out.push(`the answer leaks internals (${l.kind}): ${JSON.stringify(l.sample)}`);
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

/**
 * Requests the guard sends since the guard learned the sentinels: the unknown-method sentinel QAPROBE and the two no-handler pairs (every
 * one is answered by the handler mapping, no handler runs).
 */
export const METHOD_FIXME_ROWS: readonly GuardRefusedMethodRow[] = [
    { id: 'unknown-method.groups', method: 'QAPROBE', url: '/api/v1/groups', why: 'an unknown method: the guard sends only the sentinels TRACE and QAPROBE; PROPFIND / FOO / lower-case stay refused, so the row uses QAPROBE' },
    { id: 'wrong-method.POST-statistics', method: 'POST', url: '/api/v1/statistics', why: 'a mutation without a uuid in the path that is neither an allow-listed create nor a bulk route' },
    { id: 'wrong-method.DELETE-info', method: 'DELETE', url: '/api/v1/info', why: 'a mutation without a uuid in the path that is neither an allow-listed create nor a bulk route' },
];

/** The wrong-method answer: a 4xx with the API-GEN-01 body shape (never 5xx). */
export const wrongMethodExpectation = (method: string): Expectation => ({ status: [400, 405], message: new RegExp(`^Request method '${method}' is not supported`) });
