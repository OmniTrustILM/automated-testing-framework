/**
 * requests — sending the error-contract requests.
 *
 * Provides the request shape, a per-execution context with unique markers and names (so repeated runs and the guard's
 * free-text scan stay quiet), and the batteries of the error-contract spec: at least 40 refused requests, each naming
 * the status-matrix row it exercises, and the anonymous-access rows. Requests go through the guarded `api` fixture;
 * reads and refused creates only.
 */
import { uniqueSuffix } from '../../text';
import { ApiAnswer, answerOf } from '../../apiReads';
import type { GuardedApi } from '../../guard/types';
import { CaseId, ERROR_MESSAGES, MatrixRow, ResourceKey, listingCase, refuse, searchBody } from './cases';
import { Expectation } from './checks';

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

/** Sends one table request through the guarded context; a status never throws, the guard may still refuse the request. */
export async function sendCaseRequest(api: GuardedApi, r: Req, timeout = 30_000): Promise<ApiAnswer> {
    const started = Date.now();
    const res = await api.fetch(r.url, {
        method: r.method,
        timeout,
        ...(r.data !== undefined ? { data: r.data } : {}),
        ...(r.headers ? { headers: r.headers } : {}),
        ...(r.identityOverride ? { identityOverride: true } : {}),
    });
    return answerOf(res, started);
}

// ------------------------------------------------------------------ the run context (names, markers, probe uuids)

export interface Ctx {
    /** Base-36 stamp: `--repeat-each` safe names. */
    stamp: string;
    /** A run-prefixed name (`runName` of the spec). */
    name(suffix: string): string;
    /** A string no error body may repeat. */
    marker: string;
    /** A uuid the guard accepts as a probe (`api.probeUuid()`). */
    probe(): string;
}

export interface CtxSeams {
    /** `runName` of the run (`<run id>-<suffix>`). */
    runName(suffix: string): string;
    /** `api.probeUuid()`. */
    probe(): string;
    /** A fixed clock for a deterministic stamp (unit tests). */
    now?: () => number;
}

let counter = 0;
/** A 22-character run of base64 characters is a uuid-like token to the guard's free-text scan: names and markers avoid that length. */
const notUuidLike = (s: string): string => (/^[A-Za-z0-9+/_-]{22}(?:==)?$/.test(s) ? `${s}x` : s);

/**
 * A fresh context per test execution (`--repeat-each` safe: the stamp is the one unique suffix; a test that injects a clock gets the clock
 * plus a counter instead).
 */
export function createBatteryContext(tag: string, seams: CtxSeams): Ctx {
    const stamp = seams.now ? `${seams.now().toString(36)}${(counter++).toString(36)}` : uniqueSuffix();
    return {
        stamp,
        name: (suffix) => notUuidLike(seams.runName(`${suffix}-${stamp}`)),
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
    /** The wording of the status-matrix row the request exercises (shown in the failure message). */
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
 * The battery: ≥ 40 refused requests, each naming the status-matrix row it exercises. Shape-only rows (the unsupported
 * Content-Type, known bug core#2140) accept 415 or 500: the contract they check is the SHAPE of the answer.
 * `tokens: false` drops the credential rows (a header-auth stack presents no bearer token).
 */
export function buildErrorContractCases(ctx: Ctx): BatteryRow[] {
    const rows: BatteryRow[] = [];
    // matrix rows paging to attributeIdentifier: the API-GEN-02 requests the shape battery shares.
    for (const [resource, caseId] of PICKS) {
        const c = listingCase(resource, caseId);
        rows.push({ id: `${c.matrix}.${c.id}`, matrix: c.matrix, resource, req: c.req, expect: c.expect, rule: c.rule, echo: [] });
    }
    // beanValidation: columns[0] null on the keys listing (observed v422.search.columns-null).
    rows.push({ id: 'beanValidation.keys.columnNull', matrix: 'beanValidation', resource: 'keys', req: { method: 'POST', url: '/api/v1/keys', data: searchBody({ columns: [null] }) }, expect: refuse([ERROR_MESSAGES.nullColumn]), rule: 'columns[0] null → 422 ["columns[0] must not be null"]' });
    // pathAndQueryTypes: path and query type errors.
    const gets: Array<[string, string, string, Expectation, string]> = [
        ['pathAndQueryTypes.certificates.badUuid', 'certificates', '/api/v1/certificates/not-a-uuid', { status: 400, message: /^Method parameter 'uuid': Failed to convert value of type 'java\.lang\.String' to required type 'java\.util\.UUID'; Invalid UUID string: not-a-uuid$/ }, 'a bad uuid in a path variable → 400 "Method parameter \'uuid\': Failed to convert value …"'],
        ['pathAndQueryTypes.keys.badUuid', 'keys', '/api/v1/keys/not-a-uuid', refuse(['Invalid UUID not-a-uuid in the request']), 'a bad key uuid → 422 ["Invalid UUID … in the request"] (CryptographicKeyControllerImpl.getKey takes a String path variable and parses it with SecuredUUID.fromString)'],
        ['pathAndQueryTypes.groups.badUuid', 'groups', '/api/v1/groups/not-a-uuid', refuse(['Invalid UUID not-a-uuid in the request']), 'a bad group uuid → 422 ["Invalid UUID … in the request"] (SecuredUUID.java)'],
        ['pathAndQueryTypes.credentials.badUuid', 'credentials', '/api/v1/credentials/not-a-uuid', refuse(['Invalid UUID not-a-uuid in the request']), 'a bad credential uuid → 422 ["Invalid UUID … in the request"]'],
        ['pathAndQueryTypes.statistics.badBoolean', 'statistics', '/api/v1/statistics?includeArchived=maybe', { status: 400, message: /^Method parameter 'includeArchived': Failed to convert value of type 'java\.lang\.String' to required type 'boolean'; Invalid boolean value \[maybe\]$/ }, 'includeArchived=maybe → 400 "Method parameter … Invalid boolean value"'],
        ['pathAndQueryTypes.listViews.badResource', 'listViews', '/api/v1/listViews?resource=CERTIFICATES', refuse(['Unknown Resource Name CERTIFICATES']), 'a resource name in the wrong case → 422 ["Unknown Resource Name …"]'],
        ['pathAndQueryTypes.resources.badResource', 'resources', '/api/v1/resources/bogus/events', refuse(['Unknown Resource Name bogus']), 'an unknown resource in a path → 422 ["Unknown Resource Name …"]'],
        ['pathAndQueryTypes.scheduler.badInteger', 'scheduler', '/api/v1/scheduler/jobs?itemsPerPage=abc', { status: 422, messages: [/^itemsPerPage Failed to convert property value of type 'java\.lang\.String' to required type 'java\.lang\.Integer' for property 'itemsPerPage'; /] }, 'a non-numeric query DTO field → 422 ["itemsPerPage Failed to convert property value …"]'],
    ];
    for (const [id, resource, url, expect, rule] of gets) rows.push({ id, matrix: 'pathAndQueryTypes', resource, req: { method: 'GET', url }, expect, rule });
    // unknownObject: unknown objects and an unmatched path.
    const unknown: Array<[string, string, string, string, string]> = [
        ['certificates', '/api/v1/certificates', 'Certificate', '', ''],
        ['groups', '/api/v1/groups', 'Group', '', ''],
        ['credentials', '/api/v1/credentials', 'Credential', '', ''],
        ['raProfiles', '/api/v1/raProfiles', 'RaProfile', '', ''],
        ['certificates', '/api/v1/certificates', 'Certificate', '/history', '.history'],
    ];
    for (const [resource, base, type, suffix, tag] of unknown) {
        const id = ctx.probe();
        rows.push({ id: `unknownObject.${resource}${tag}.unknownUuid`, matrix: 'unknownObject', resource, req: { method: 'GET', url: `${base}/${id}${suffix}` }, expect: { status: 404, message: gone(type, id) }, rule: `an unknown ${type} uuid → 404 "Object of type '${type}' identified by <uuid> is not found."` });
    }
    rows.push({ id: 'unknownObject.nope.unmatchedPath', matrix: 'unknownObject', resource: 'none', req: { method: 'GET', url: '/api/v1/nope' }, expect: { status: 404, message: 'No endpoint GET /api/v1/nope.' }, rule: 'an unmatched path → 404 "No endpoint GET /api/v1/nope."' });
    // wrongMethod: a defined path with a method it does not define (a GET on a POST-only path).
    rows.push({ id: 'wrongMethod.authorities.wrongMethod', matrix: 'wrongMethod', resource: 'authorities', req: { method: 'GET', url: '/api/v1/authorities/not-a-uuid/raProfiles' }, expect: { status: [400, 405], message: /^Request method 'GET' is not supported$/ }, rule: 'a GET on a POST-only path → 4xx {"message":"Request method \'GET\' is not supported"}' });
    // create name and create body: refused creates (nothing is created: the core refuses before any write; an accidental 2xx is recorded by
    // the spec).
    const group = (data: unknown): Req => ({ method: 'POST', url: '/api/v1/groups', data });
    rows.push({ id: 'createName.groups.emptyObject', matrix: 'createName', resource: 'groups', req: group({}), expect: refuse([ERROR_MESSAGES.nameEmpty]), rule: 'a group without a name → 422 ["Name must not be empty"]', creates: 'groups' });
    rows.push({ id: 'createName.groups.emptyName', matrix: 'createName', resource: 'groups', req: group({ name: '' }), expect: refuse([ERROR_MESSAGES.nameEmpty]), rule: 'a group with name "" → 422 ["Name must not be empty"]', creates: 'groups' });
    rows.push({ id: 'createName.groups.blankName', matrix: 'createName', resource: 'groups', req: group({ name: '   ' }), expect: refuse([ERROR_MESSAGES.nameEmpty]), rule: 'a group with name "   " → 422 ["Name must not be empty"]', creates: 'groups' });
    rows.push({ id: 'createBody.groups.trailingComma', matrix: 'createBody', resource: 'groups', req: group(Buffer.from(`{"name":"${ctx.name('gen01-tc')}",}`)), expect: { status: 400, message: ERROR_MESSAGES.unreadable }, rule: 'a group body with a trailing comma → 400 "Unable to read HTTP message"', creates: 'groups' });
    rows.push({ id: 'createBody.groups.nameObject', matrix: 'createBody', resource: 'groups', req: group({ name: { a: ctx.marker } }), expect: { status: 400, message: ERROR_MESSAGES.unreadable }, rule: 'a group whose name is an object → 400 "Unable to read HTTP message"', echo: [ctx.marker], creates: 'groups' });
    rows.push({
        id: 'createName.credentials.emptyName', matrix: 'createName', resource: 'credentials',
        req: { method: 'POST', url: '/api/v1/credentials', data: { name: '', connectorUuid: ctx.probe(), kind: 'Basic', attributes: [] } },
        expect: refuse([ERROR_MESSAGES.nameEmpty]), rule: 'a credential with name "" → 422 ["Name must not be empty"] (checked before the connector lookup)',
    });
    // contentType: the unsupported Content-Type answers 415 (core#2140: 500 today); here only the SHAPE of whatever answers.
    rows.push({ id: 'contentType.groups.textPlain', matrix: 'contentType', resource: 'groups', req: { method: 'POST', url: '/api/v1/groups', data: '{"name":""}', headers: { 'content-type': 'text/plain' } }, expect: { status: [415, 500] }, rule: 'text/plain on a JSON create → 415 (500 today, core#2140): the answer keeps the contract shape', note: 'status is judged by API-GEN-06; the shape and the leak scan here' });
    rows.push({ id: 'contentType.certificates.textPlain', matrix: 'contentType', resource: 'certificates', req: { method: 'POST', url: '/api/v1/certificates', data: JSON.stringify(searchBody()), headers: { 'content-type': 'text/plain' } }, expect: { status: [415, 500] }, rule: 'text/plain on a JSON search → 415 (500 today, core#2140): the answer keeps the contract shape', note: 'status is judged by API-GEN-06; the shape and the leak scan here' });
    return rows;
}

/** The credential rows of API-GEN-01 (a 401 body does not echo the token); the spec skips them on a header-auth stack. */
export function buildAnonymousAccessCases(ctx: Ctx): BatteryRow[] {
    const bearer = `Bearer ${ctx.marker}`;
    const basic = `Basic ${Buffer.from(`${ctx.marker}:${ctx.marker}`).toString('base64')}`;
    return [
        { id: 'credentials.groups.anonymous', matrix: 'credentials', resource: 'groups', req: { method: 'GET', url: '/api/v1/groups' }, expect: { status: 401 }, rule: 'no credentials → 401, no data in the body', anonymous: true },
        { id: 'credentials.certificates.garbageBearer', matrix: 'credentials', resource: 'certificates', req: { method: 'GET', url: '/api/v1/certificates/search', headers: { authorization: bearer }, identityOverride: true }, expect: { status: 401 }, rule: 'a garbage Bearer token → 401, the body and WWW-Authenticate do not echo it', echo: [ctx.marker], needsToken: true },
        { id: 'credentials.keys.garbageBearer', matrix: 'credentials', resource: 'keys', req: { method: 'GET', url: '/api/v1/keys/search', headers: { authorization: bearer }, identityOverride: true }, expect: { status: 401 }, rule: 'a garbage Bearer token → 401, the body and WWW-Authenticate do not echo it', echo: [ctx.marker], needsToken: true },
        { id: 'credentials.credentials.garbageBasic', matrix: 'credentials', resource: 'credentials', req: { method: 'GET', url: '/api/v1/credentials', headers: { authorization: basic }, identityOverride: true }, expect: { status: 401 }, rule: 'a garbage Basic header → 401, the body does not echo it', echo: [ctx.marker, basic.slice('Basic '.length)], needsToken: true },
    ];
}
