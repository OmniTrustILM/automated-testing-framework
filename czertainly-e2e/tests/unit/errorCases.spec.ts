/**
 * errorCases — unit tests of utils/regression/inventory/errorCases/.
 *
 * WHAT: the response check and its shape rule, the leak scanner, the forged token, the upload bodies, and the structure of
 *       the case tables (no duplicates, every listing and case has a request or a stated reason).
 * WHY: the battery judges every refusal of the API; a check that passes a wrong answer, or a table with a hole, would hide a defect.
 * HOW: pure calls over hand-made answers and the case tables; no request is sent.
 */
import { test, expect } from '@playwright/test';
import { jsonDepth, MAX_BODY_DEPTH } from '../../utils/regression/guard/targets';
import { jsonDuplicateKey } from '../../utils/regression/guard/bodies';
import { acceptProblems, CONTENT_TYPE_ROWS, contentTypeReq, jsonBattery, jsonReq, wrongMethodExpectation, TRACE_ROWS, WRONG_METHOD_GETS, METHOD_FIXME_ROWS } from '../../utils/regression/inventory/errorCases/parsing';
import { authorizationOf, forgeAlgNone, identityReq, PROTECTED_ENDPOINTS, secretsOf } from '../../utils/regression/inventory/errorCases/securityChain';
import { LISTING_CASES, LISTING_ENDPOINTS, listingCase, listingCases, ERROR_STATUS_MATRIX, ERROR_MESSAGES, notApplicable } from '../../utils/regression/inventory/errorCases/cases';
import { findEchoedInput, checkResponse, findLeaks, shapeProblems, statusOk } from '../../utils/regression/inventory/errorCases/checks';
import { encodedLength, garbageBytes, PLACEHOLDER_ENTRY, sizeProblems, SIZE_ROWS, UPLOAD_LIMIT, uploadBody, UPLOAD_ROUTES } from '../../utils/regression/inventory/errorCases/uploads';
import { buildAnonymousAccessCases, buildErrorContractCases, createBatteryContext, nameInBody } from '../../utils/regression/inventory/errorCases/requests';
import { base64Url } from '../../utils/regression/text';

const RUN = 'qa-reg-20261014-120000-ab12';
let n = 0;
const ctx = () => createBatteryContext('t', { runName: (s) => `${RUN}-${s}`, probe: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
const answer = (status: number, body: unknown, contentType = 'application/json') => ({ status, contentType, text: typeof body === 'string' ? body : JSON.stringify(body) });

// ------------------------------------------------------------------ the shape rule and the judge

test('shapeProblems: a 422 is an array of non-empty strings, any other error {message}, both application/json', () => {
    expect(shapeProblems(422, 'application/json', '["a","b"]')).toEqual([]);
    expect(shapeProblems(422, 'application/json; charset=UTF-8', '["a"]')).toEqual([]);
    for (const bad of ['{"message":"x"}', '[]', '[""]', '[1]', '"x"', '', 'not json']) expect(shapeProblems(422, 'application/json', bad), bad).not.toEqual([]);
    expect(shapeProblems(400, 'application/json', '{"message":"x"}')).toEqual([]);
    expect(shapeProblems(500, 'application/json', '{"message":"Internal server error."}')).toEqual([]);
    for (const bad of ['["x"]', '{"message":"x","status":400}', '{"error":"x"}', '{"message":1}', '{}', '']) expect(shapeProblems(404, 'application/json', bad), bad).not.toEqual([]);
    expect(shapeProblems(422, 'text/plain', '["x"]')[0]).toMatch(/application\/json/);
});

test('judge: status, messages, message, empty body and the shape in one list of problems', () => {
    expect(checkResponse({ status: 422, messages: ['a'] }, answer(422, ['a']))).toEqual([]);
    expect(checkResponse({ status: 422, messages: [/^Field X /] }, answer(422, ['Field X does not support'])), 'a RegExp oracle').toEqual([]);
    expect(checkResponse({ status: 422, messages: ['a'] }, answer(422, ['b']))[0]).toMatch(/message 1 is "b", expected "a"/);
    expect(checkResponse({ status: 422, messages: ['a', 'b'] }, answer(422, ['a']))[0]).toMatch(/expected 2 message\(s\), got 1/);
    expect(checkResponse({ status: 422 }, answer(422, { message: 'x' }))[0]).toMatch(/a 422 body must be a JSON array/);
    expect(checkResponse({ status: 400, message: 'm' }, answer(400, { message: 'm' }))).toEqual([]);
    expect(checkResponse({ status: 400, message: 'm' }, answer(400, { message: 'other' }))[0]).toMatch(/message is "other", expected "m"/);
    expect(checkResponse({ status: 400 }, answer(500, { message: 'Internal server error.' }))[0]).toMatch(/status 500, expected 400/);
    expect(checkResponse({ status: [415, 500] }, answer(500, { message: 'Internal server error.' })), 'a shape-only family').toEqual([]);
    expect(checkResponse({ status: '4xx' }, answer(404, { message: 'x' }))).toEqual([]);
    expect(checkResponse({ status: '4xx' }, answer(500, { message: 'x' }))[0]).toMatch(/expected a 4xx/);
    expect(checkResponse({ status: 400, empty: true }, answer(400, ''))).toEqual([]);
    expect(checkResponse({ status: 400, empty: true }, answer(400, '{"message":"x"}'))[0]).toMatch(/must be empty/);
    // a 401 / 403 is judged by status and leaks only (its body is not the error contract)
    expect(checkResponse({ status: 401 }, answer(401, '', ''))).toEqual([]);
    expect(checkResponse({ status: 401 }, answer(403, '{"code":"ACCESS_DENIED"}', 'application/problem+json'))[0]).toMatch(/status 403, expected 401/);
    expect(checkResponse({ status: 401 }, answer(200, '[]'))[0]).toMatch(/status 200, expected 401/);
});

test('judge: a leaking body and an echoed secret are findings, also in WWW-Authenticate', () => {
    const leak = answer(500, { message: 'org.hibernate.exception.ConstraintViolationException: could not execute statement' });
    const problems = checkResponse({ status: 500 }, leak);
    expect(problems.join('\n')).toMatch(/leaks internals \(package\)/);
    expect(problems.join('\n')).toMatch(/exception-class/);
    expect(checkResponse({ status: 400, message: /./ }, answer(400, { message: 'bad token SECRET-1' }), ['SECRET-1'])[0]).toMatch(/echoes "SECRET-1"/);
    expect(checkResponse({ status: 401 }, { status: 401, contentType: '', text: '', headers: { 'www-authenticate': 'Bearer error="invalid_token", error_description="SECRET-2"' } }, ['SECRET-2'])[0]).toMatch(/echoes/);
    expect(checkResponse({ status: 401 }, { status: 401, contentType: '', text: '', headers: { 'www-authenticate': 'Bearer error="invalid_token"' } }, ['SECRET-2'])).toEqual([]);
    expect(findEchoedInput('abc SECRET def', 'SECRET')).toBe(true);
    expect(findEchoedInput('abc', '')).toBe(false);
});

test('statusOk: a number, a family and any 4xx', () => {
    expect(statusOk(400, 400)).toBe(true);
    expect(statusOk([415, 500], 500)).toBe(true);
    expect(statusOk([415, 500], 400)).toBe(false);
    expect(statusOk('4xx', 499)).toBe(true);
    expect(statusOk('4xx', 500)).toBe(false);
    expect(statusOk('4xx', 399)).toBe(false);
});

// ------------------------------------------------------------------ the leak scanner

test('leaks: stack frames, class and package names, SQL and file paths are findings', () => {
    const kinds = (text: string) => findLeaks(text).map((l) => l.kind);
    expect(kinds('\tat com.otilm.core.service.Foo.bar(Foo.java:123)')).toEqual(expect.arrayContaining(['stack-trace', 'package']));
    expect(kinds('Caused by: java.sql.SQLException: boom')).toEqual(expect.arrayContaining(['stack-trace', 'exception-class']));
    expect(kinds('PSQLException: ERROR: duplicate key value violates unique constraint "group_name_key"')).toEqual(expect.arrayContaining(['exception-class', 'sql']));
    expect(kinds('NullPointerException')).toEqual(['exception-class']);
    expect(kinds('org.springframework.web.HttpMediaTypeNotSupportedException')).toEqual(expect.arrayContaining(['package', 'exception-class']));
    expect(kinds('select c1_0.uuid from certificate c1_0 where c1_0.state = ?')).toContain('sql');
    expect(kinds('could not execute statement [ERROR: null value in column "name"]')).toContain('sql');
    expect(kinds('failed to open /opt/app/config/application.yml')).toEqual(expect.arrayContaining(['file-path']));
    expect(kinds('C:\\Users\\core\\app.jar')).toContain('file-path');
    expect(kinds('a.b.c.Service')).toContain('package');
    expect(kinds('FooService.java:42')).toEqual(expect.arrayContaining(['stack-trace', 'file-path']));
});

test('leaks: the documented core texts are clean, the JDK types of the type-mismatch sentence are tolerated', () => {
    const clean = [
        ERROR_MESSAGES.paging, ERROR_MESSAGES.unreadable, ERROR_MESSAGES.blankSortIdentifier, ERROR_MESSAGES.nullSortDirection, ERROR_MESSAGES.nullColumn, ERROR_MESSAGES.nameEmpty, ERROR_MESSAGES.oversize, ERROR_MESSAGES.internal,
        'Unknown sort field identifier QA_NO_SUCH_FIELD.', 'Field PRIVATE_KEY cannot be used to order this listing.', 'Sorting is not supported for the Audit logs listing.',
        'Field KEY_SIZE does not support the GREATER condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY.',
        'Filter for field COMMON_NAME with operator CONTAINS requires at least one value.',
        'Input is not a valid regex: Unclosed group near index 1\n(',
        'Literal quote sequences \\Q, \\R, \\G, \\h, \\H, \\z, \\X, \\V are not supported in PostgreSQL POSIX regex',
        'Filter field value 30 days cannot be parsed to a Duration.', 'Filter field value abc cannot be parsed as a Number.', 'Filter field value abc cannot be parsed as an Integer.',
        'Filter field identifier qa-no-suffix does not name an attribute.',
        "Object of type 'Certificate' identified by 00000000-0000-4000-8000-000000000000 is not found.", 'No endpoint GET /api/v1/nope.',
        "Request method 'GET' is not supported", 'Invalid UUID not-a-uuid in the request',
        "Method parameter 'uuid': Failed to convert value of type 'java.lang.String' to required type 'java.util.UUID'; Invalid UUID string: not-a-uuid",
        "Method parameter 'includeArchived': Failed to convert value of type 'java.lang.String' to required type 'boolean'; Invalid boolean value [maybe]",
        'itemsPerPage Failed to convert property value of type \'java.lang.String\' to required type \'java.lang.Integer\' for property \'itemsPerPage\'; For input string: "abc"',
        'The file is not in a supported format: PKCS#12, JKS, JCEKS, PEM, PKCS#7, a certificate, a certificate request, a PKCS#8 key, an OpenSSL traditional key or an OpenSSH private key.',
        'Error in connector communication', 'Unknown Resource Name CERTIFICATES', 'Validation error: must not be blank',
    ];
    for (const text of clean) expect(findLeaks(text), text).toEqual([]);
});

test('leaks: the application enum classes the 400 for an unknown enum value names are a finding (candidate defect, not a known bug)', () => {
    const observed = "Method parameter 'category': Failed to convert value of type 'java.lang.String' to required type 'com.otilm.api.model.core.oid.OidCategory'; Failed to convert from type [java.lang.String] to type [@io.swagger.v3.oas.annotations.Parameter @org.springframework.web.bind.annotation.RequestParam com.otilm.api.model.core.oid.OidCategory] for value [bogus]";
    expect(findLeaks(observed).map((l) => l.kind)).toContain('package');
});

// ------------------------------------------------------------------ the forged token and the credentials

test('forgeAlgNone: an unsecured JWT: {"alg":"none"} header, claims, an empty signature, base64url without padding', () => {
    const token = forgeAlgNone();
    const [h, c, s, ...rest] = token.split('.');
    expect(rest).toEqual([]);
    expect(s, 'the signature segment is empty').toBe('');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))).toEqual({ alg: 'none', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))).toEqual({ sub: 'qa-forged', iat: 1_700_000_000, exp: 4_102_444_800 });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.$/);
    expect(forgeAlgNone({ alg: 'None', claims: { sub: 'x' } }).split('.')[0]).toBe(base64Url('{"alg":"None","typ":"JWT"}'));
    expect(base64Url('??>>~~')).toBe('Pz8-Pn5-');
});

test('authorizationOf / secretsOf: the fabricated identities carry the marker and never a real token', () => {
    const marker = 'qa-marker-x';
    expect(authorizationOf('none', marker)).toBeUndefined();
    expect(authorizationOf('tampered-bearer', marker)).toBeUndefined();
    expect(authorizationOf('garbage-bearer', marker)).toBe(`Bearer ${marker}`);
    expect(authorizationOf('garbage-basic', marker)).toBe(`Basic ${Buffer.from(`${marker}:${marker}`).toString('base64')}`);
    const jwt = authorizationOf('garbage-jwt', marker)!;
    expect(jwt).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const alg = authorizationOf('alg-none', marker)!;
    expect(alg).toMatch(/^Bearer [\w-]+\.[\w-]+\.$/);
    expect(JSON.parse(Buffer.from(alg.split('.')[1], 'base64url').toString()).sub).toBe(marker);
    expect(secretsOf(`Bearer ${marker}`, marker)).toContain(marker);
    expect(secretsOf(jwt, marker).length, 'the whole token and its segments').toBeGreaterThan(2);
    expect(secretsOf(undefined, marker)).toEqual([]);
    expect(identityReq('/api/v1/groups', 'Bearer x')).toEqual({ method: 'GET', url: '/api/v1/groups', headers: { authorization: 'Bearer x' }, identityOverride: true });
});

// ------------------------------------------------------------------ the five listings (API-GEN-02)

test('the listing table: five resources, every (resource × case) pair has a request or a stated reason', () => {
    expect(LISTING_ENDPOINTS.map((l) => l.key)).toEqual(['certificates', 'keys', 'discoveries', 'auditLogs', 'oids']);
    expect(LISTING_ENDPOINTS.map((l) => l.url)).toEqual(['/api/v1/certificates', '/api/v1/keys', '/api/v1/discoveries/list', '/api/v1/auditLogs', '/api/v1/oids/list']);
    const cases = listingCases();
    const na = notApplicable();
    expect(cases.length + na.length).toBe(5 * LISTING_CASES.length);
    expect(na.every((x) => x.why.length > 20)).toBe(true);
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size, 'ids are unique').toBe(ids.length);
    for (const l of LISTING_ENDPOINTS) expect(cases.filter((c) => c.resource === l.key).length, l.key).toBeGreaterThanOrEqual(LISTING_CASES.length - 3);
    // The gaps are the ones the code explains: the certificate has no number field, audit logs and OIDs do not sort, OIDs have no date-time.
    expect(na.map((x) => `${x.resource}.${x.caseId}`).sort()).toEqual([
        'auditLogs.filter.numberInvalid', 'auditLogs.sort.nonSortableField',
        'certificates.filter.numberInvalid',
        'discoveries.sort.nonSortableField',
        'oids.filter.durationInvalid', 'oids.filter.numberInvalid', 'oids.sort.nonSortableField',
    ]);
});

test('the listing table: the refusal text per resource', () => {
    expect(listingCase('certificates', 'paging.itemsPerPage0').expect).toEqual({ status: 400, message: 'The request could not be processed.' });
    expect(listingCase('oids', 'json.notJson').expect).toEqual({ status: 400, message: 'Unable to read HTTP message' });
    expect(listingCase('keys', 'sort.blankIdentifier').expect).toEqual({ status: 422, messages: ['sort.fieldIdentifier must not be blank'] });
    expect(listingCase('discoveries', 'sort.nullDirection').expect).toEqual({ status: 422, messages: ['sort.direction must not be null'] });
    expect(listingCase('certificates', 'sort.unknownField').expect.messages).toEqual(['Unknown sort field identifier QA_NO_SUCH_FIELD.']);
    expect(listingCase('keys', 'sort.unknownField').expect.messages).toEqual(['Unknown sort field identifier QA_NO_SUCH_FIELD.']);
    expect(listingCase('discoveries', 'sort.unknownField').expect.messages).toEqual(['Unknown sort field identifier QA_NO_SUCH_FIELD.']);
    expect(listingCase('auditLogs', 'sort.unknownField').expect.messages).toEqual(['Sorting is not supported for the Audit logs listing.']);
    expect(listingCase('oids', 'sort.unknownField').expect.messages).toEqual(['Sorting is not supported for the OID listing.']);
    expect(listingCase('certificates', 'sort.nonSortableField').expect.messages).toEqual(['Field PRIVATE_KEY cannot be used to order this listing.']);
    expect(listingCase('keys', 'sort.nonSortableField').expect.messages).toEqual(['Field CKI_USAGE cannot be used to order this listing.']);
    expect(listingCase('keys', 'filter.numberInvalid').expect.messages).toEqual(['Filter field value abc cannot be parsed as a Number.']);
    expect(listingCase('auditLogs', 'filter.durationInvalid').expect.messages).toEqual(['Filter field value 30 days cannot be parsed to a Duration.']);
    expect(listingCase('oids', 'filter.valueMissing').expect.messages).toEqual(['Filter for field OID_ENTRY_OID with operator CONTAINS requires at least one value.']);
    expect(listingCase('discoveries', 'filter.attributeNoSuffix').expect.messages).toEqual(['Filter field identifier qa-no-suffix does not name an attribute.']);
});

test('the listing table: each request body is what its case says', () => {
    const body = (r: Parameters<typeof listingCase>[0], c: Parameters<typeof listingCase>[1]) => listingCase(r, c).req.data;
    expect(body('certificates', 'paging.itemsPerPage0')).toEqual({ filters: [], itemsPerPage: 0, pageNumber: 1 });
    expect(body('keys', 'paging.pageNumberNegative')).toEqual({ filters: [], itemsPerPage: 10, pageNumber: -1 });
    expect(Buffer.isBuffer(body('discoveries', 'json.notJson'))).toBe(true);
    expect(() => JSON.parse(String(body('discoveries', 'json.notJson')))).toThrow();
    expect(JSON.parse((body('auditLogs', 'json.itemsPerPageOverflow') as Buffer).toString()).itemsPerPage).toBe(2 ** 31);
    const cond = body('certificates', 'json.conditionCase') as { filters: Array<{ condition: string }> };
    expect(cond.filters[0].condition, 'wrong case').toBe('contains');
    expect((body('keys', 'json.fieldSourceCase') as { filters: Array<{ fieldSource: string }> }).filters[0].fieldSource).toBe('PROPERTY');
    expect((body('oids', 'json.directionCase') as { sort: { direction: string } }).sort.direction).toBe('ASC');
    expect((body('certificates', 'sort.nullDirection') as { sort: { direction: unknown } }).sort.direction).toBeNull();
    const nv = body('keys', 'filter.valueMissing') as { filters: Array<Record<string, unknown>> };
    expect(Object.keys(nv.filters[0]), 'no value key at all').toEqual(['fieldSource', 'fieldIdentifier', 'condition']);
    expect((body('keys', 'filter.valueEmptyList') as { filters: Array<{ value: unknown }> }).filters[0].value).toEqual([]);
    expect((body('certificates', 'filter.regexQuote') as { filters: Array<{ value: string }> }).filters[0].value).toBe('\\Qabc');
});

test('the conditionNotAdvertised oracle compares the listed conditions with the absolute set of the field type, in any order', () => {
    const c = listingCase('certificates', 'filter.conditionNotAdvertised.list');
    const okText = 'Field KEY_SIZE does not support the GREATER condition; it supports EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY.';
    expect(checkResponse(c.expect, answer(422, [okText]))).toEqual([]);
    expect(checkResponse(c.expect, answer(422, ['Field KEY_SIZE does not support the GREATER condition; it supports NOT_EMPTY, EMPTY, NOT_EQUALS, EQUALS.']))).toEqual([]);
    expect(checkResponse(c.expect, answer(422, ['Field KEY_SIZE does not support the GREATER condition; it supports EQUALS, NOT_EQUALS.']))[0]).toMatch(/absolute set/);
    const s = listingCase('keys', 'filter.conditionNotAdvertised.string');
    expect(checkResponse(s.expect, answer(422, ['Field CKI_NAME does not support the GREATER condition; it supports CONTAINS, NOT_CONTAINS, EQUALS, NOT_EQUALS, EMPTY, NOT_EMPTY, STARTS_WITH, ENDS_WITH, MATCHES, NOT_MATCHES.']))).toEqual([]);
    expect(checkResponse(s.expect, answer(422, ['Field CKI_NAME does not support the GREATER condition; it supports CONTAINS.']))[0]).toMatch(/absolute set of a string field/);
});

// ------------------------------------------------------------------ API-GEN-01: the battery

test('the battery: at least 40 refused requests, each with a status-matrix row, a rule and an expectation; ids unique', () => {
    const rows = buildErrorContractCases(ctx());
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rows) {
        expect(Object.keys(ERROR_STATUS_MATRIX), r.id).toContain(r.matrix);
        expect(r.rule.length, r.id).toBeGreaterThan(10);
        expect(r.id.startsWith(`${r.matrix}.`), r.id).toBe(true);
        expect(['GET', 'POST']).toContain(r.req.method);
        expect(r.req.url).toMatch(/^\/api\/v[12]\//);
    }
    // Path uuids: a String path variable parsed with SecuredUUID answers 422 ["Invalid UUID <v> in the request"] (keys, groups, credentials); a
    // typed `UUID` path variable answers 400 "Method parameter 'uuid': Failed to convert value …" (certificates). Keys answer 422, not 400.
    const expectOf = (id: string) => rows.find((r) => r.id === id)!.expect;
    for (const id of ['pathAndQueryTypes.keys.badUuid', 'pathAndQueryTypes.groups.badUuid', 'pathAndQueryTypes.credentials.badUuid']) expect(expectOf(id), id).toEqual({ status: 422, messages: ['Invalid UUID not-a-uuid in the request'] });
    expect(expectOf('pathAndQueryTypes.certificates.badUuid').status).toBe(400);
    // Every matrix row of the battery is exercised, search / create / path / body endpoints alike.
    const matrix = new Set<string>(rows.map((r) => r.matrix));
    for (const m of ['paging', 'unreadableBody', 'beanValidation', 'sorting', 'conditionNotOffered', 'valueMissing', 'regex', 'valueFormat', 'attributeIdentifier', 'pathAndQueryTypes', 'unknownObject', 'wrongMethod', 'createName', 'createBody', 'contentType']) expect(matrix.has(m), m).toBe(true);
    const methods = new Set(rows.map((r) => r.req.method));
    expect([...methods].sort()).toEqual(['GET', 'POST']);
    expect(new Set(rows.map((r) => r.resource)).size, 'resources').toBeGreaterThanOrEqual(10);
    // Refused creates are the only POSTs that could create: they are all marked, and none carries a valid new name.
    for (const r of rows.filter((x) => x.creates)) expect(r.req.url).toMatch(/^\/api\/v1\/groups$/);
    expect(rows.filter((r) => r.req.url === '/api/v1/credentials').every((r) => (r.req.data as { name: string }).name === ''), 'the credential create is refused for its blank name').toBe(true);
});

test('the battery: the credential rows name the marker and the base64 of the Basic value', () => {
    const c = ctx();
    const rows = buildAnonymousAccessCases(c);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.filter((r) => r.anonymous).length).toBe(1);
    for (const r of rows.filter((x) => x.needsToken)) {
        expect(r.req.identityOverride).toBe(true);
        expect(r.req.headers?.authorization).toMatch(/^(Bearer|Basic) /);
        expect(r.echo).toContain(c.marker);
        expect(r.expect.status).toBe(401);
    }
    const basic = rows.find((r) => r.id.endsWith('garbageBasic'))!;
    expect(basic.echo).toContain(basic.req.headers!.authorization.slice('Basic '.length));
});

test('the battery: names and markers cannot be taken for a uuid by the guard\'s free-text scan, and are unique per context', () => {
    const a = ctx();
    const b = ctx();
    expect(a.stamp).not.toBe(b.stamp);
    expect(a.marker).not.toBe(b.marker);
    for (const s of [a.marker, a.name('gen05'), a.name('x'), b.name('gen01-tc')]) {
        expect(s, s).not.toMatch(/^[A-Za-z0-9+/_-]{22}(?:==)?$/);
        expect(s, s).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
    expect(a.name('gen05').startsWith(RUN)).toBe(true);
    // A 22-character run of base64 characters is lengthened.
    const padded = createBatteryContext('x'.repeat(2), { runName: (s) => s, probe: () => 'p', now: () => 0 });
    expect(padded.marker).not.toMatch(/^[A-Za-z0-9+/_-]{22}$/);
    const exactly22 = createBatteryContext('t', { runName: () => 'a'.repeat(22), probe: () => 'p' });
    expect(exactly22.name('s')).toBe(`${'a'.repeat(22)}x`);
});

test('nameInBody: the name of a create body, from an object or raw text', () => {
    expect(nameInBody({ name: 'n1' })).toBe('n1');
    expect(nameInBody({ name: '' })).toBeUndefined();
    expect(nameInBody({ name: '   ' })).toBeUndefined();
    expect(nameInBody(Buffer.from('{"name":"name2","description":"x",}'))).toBe('name2');
    expect(nameInBody('{"name": "name3"}')).toBe('name3');
    expect(nameInBody(Buffer.from('null'))).toBeUndefined();
    expect(nameInBody(undefined)).toBeUndefined();
});

// ------------------------------------------------------------------ API-GEN-03: the upload bodies

test('uploadBody: the decoded file is exactly the stated size, the import names one placeholder entry', () => {
    expect(UPLOAD_LIMIT).toBe(5_242_880);
    expect(encodedLength(UPLOAD_LIMIT), 'UploadedFile.MAXIMUM_ENCODED_LENGTH').toBe(6_990_508);
    for (const row of SIZE_ROWS) {
        for (const route of ['inspections', 'import'] as const) {
            const body = uploadBody(route, row.bytes);
            expect(Buffer.from(body.file, 'base64').length, `${route} ${row.id}`).toBe(row.bytes);
            expect(body.file.length).toBe(encodedLength(row.bytes));
            expect(Object.keys(body).sort(), route).toEqual(route === 'import' ? ['entries', 'file'] : ['file']);
        }
    }
    expect(uploadBody('import', 10).entries).toEqual([{ entryReference: PLACEHOLDER_ENTRY }]);
    expect(PLACEHOLDER_ENTRY).toMatch(/^[0-9a-f]{64}$/);
    expect(SIZE_ROWS.map((r) => r.bytes)).toEqual([5_242_880, 5_242_881, 6_291_456]);
    expect(UPLOAD_ROUTES).toEqual({ inspections: '/api/v1/inspections', import: '/api/v1/certificates/import' });
    expect(garbageBytes(4).toString()).toBe('AAAA');
});

test('sizeProblems: the limit rows answer the size text, the boundary row the format text, never 413 or 5xx', () => {
    const [atLimit, over, six] = SIZE_ROWS;
    const sizeText = ['fileWithinLimit file must not exceed 5242880 bytes'];
    const formatText = ['The file is not in a supported format: PKCS#12, JKS, JCEKS, PEM, PKCS#7, a certificate, a certificate request, a PKCS#8 key, an OpenSSL traditional key or an OpenSSH private key.'];
    expect(sizeProblems(atLimit, answer(422, formatText))).toEqual([]);
    expect(sizeProblems(over, answer(422, sizeText))).toEqual([]);
    expect(sizeProblems(six, answer(422, sizeText))).toEqual([]);
    expect(sizeProblems(atLimit, answer(422, sizeText)).join('\n'), 'the boundary row must NOT be refused for its size').toMatch(/message 1 is/);
    expect(sizeProblems(over, answer(422, formatText)).join('\n')).toMatch(/message 1 is/);
    expect(sizeProblems(six, answer(413, '')).join('\n')).toMatch(/413: core has no 413 path/);
    expect(sizeProblems(six, answer(500, { message: 'Internal server error.' })).join('\n')).toMatch(/never be a server error/);
    expect(sizeProblems(six, answer(400, { message: ERROR_MESSAGES.unreadable })).join('\n'), 'a 400 is not the limit refusal').toMatch(/expected 422/);
});

// ------------------------------------------------------------------ API-GEN-05: the JSON battery

test('the JSON battery: the bodies are what their rows say (malformed, type-invalid, valid, BOM, duplicate key, nesting)', () => {
    const rows = jsonBattery(ctx());
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    const parses = (r: { data: Buffer }) => {
        try {
            JSON.parse(r.data.toString('utf8'));
            return true;
        } catch {
            return false;
        }
    };
    // Syntax errors: Jackson refuses them, JSON.parse refuses them too.
    for (const id of ['certificates.trailing-comma', 'certificates.trailing-comma-marker', 'certificates.comment-block', 'certificates.comment-line', 'certificates.nan', 'groups.trailing-comma', 'groups.comment-block', 'groups.comment-line', 'groups.nan']) {
        expect(parses(byId(id)), id).toBe(false);
    }
    // Valid JSON of the wrong type or shape.
    for (const id of ['certificates.body-null', 'certificates.body-array', 'certificates.body-string', 'certificates.body-number', 'certificates.filters-object', 'certificates.filters-string', 'certificates.itemsPerPage-abc', 'certificates.includeArchived-yes', 'certificates.nesting-25', 'groups.body-null', 'groups.body-array', 'groups.body-number', 'groups.name-object', 'groups.description-array', 'groups.nesting-25', 'certificates.control', 'groups.blank-name-control']) {
        expect(parses(byId(id)), id).toBe(true);
    }
    expect(byId('certificates.body-null').data.toString()).toBe('null');
    expect(byId('certificates.body-array').data.toString()).toBe('[]');
    expect(byId('certificates.body-number').data.toString()).toBe('123');
    expect(JSON.parse(byId('certificates.body-string').data.toString())).toContain('qa-marker-t-');
    // Nesting: 25 levels of arrays in the typed field; inside the guard's own depth limit.
    const nested = JSON.parse(byId('certificates.nesting-25').data.toString()).filters;
    let depth = 0;
    for (let v: unknown = nested; Array.isArray(v); v = (v as unknown[])[0]) depth++;
    expect(depth).toBe(25);
    expect(jsonDepth(JSON.parse(byId('groups.nesting-25').data.toString()))).toBeLessThan(MAX_BODY_DEPTH);
    // BOM and duplicate keys.
    expect([...byId('certificates.bom').data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect([...byId('groups.bom').data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(jsonDuplicateKey(byId('certificates.duplicate-keys').data.toString())).toBe('itemsPerPage');
    expect(jsonDuplicateKey(byId('groups.duplicate-keys').data.toString())).toBe('name');
    // Markers sit in the echo rows; the marker is a plain string in the body, never a uuid.
    for (const r of rows.filter((x) => x.echo?.length)) expect(r.data.toString(), r.id).toContain(r.echo![0]);
    // Kinds: documented refusals are P1 rows, the two contradictions of the written rules are pins, the controls are controls.
    expect(rows.filter((r) => r.kind === 'pin').map((r) => r.id).sort()).toEqual(['certificates.bom', 'certificates.duplicate-keys', 'groups.bom', 'groups.duplicate-keys']);
    expect(rows.filter((r) => r.kind === 'control').map((r) => r.id).sort()).toEqual(['certificates.control', 'groups.blank-name-control']);
    expect(rows.filter((r) => r.guardRefused).map((r) => r.id)).toEqual(['groups.duplicate-keys']);
    expect(rows.filter((r) => r.target === 'certificates').length).toBeGreaterThanOrEqual(15);
    expect(rows.filter((r) => r.target === 'groups').length).toBeGreaterThanOrEqual(12);
    // A create body that names a group names a run-prefixed one: an accidental acceptance leaves a recordable, own object.
    for (const r of rows.filter((x) => x.target === 'groups')) {
        const name = nameInBody(r.data);
        if (name) expect(name.startsWith(RUN), r.id).toBe(true);
    }
    expect(jsonReq(byId('certificates.nan'))).toMatchObject({ method: 'POST', url: '/api/v1/certificates' });
    expect(jsonReq(byId('groups.nan'))).toMatchObject({ method: 'POST', url: '/api/v1/groups' });
});

test('the JSON battery: pins accept their family, the groups BOM row can only be a refusal', () => {
    const rows = jsonBattery(ctx());
    const dup = rows.find((r) => r.id === 'certificates.duplicate-keys')!;
    expect(checkResponse(dup.expect, answer(200, { certificates: [], itemsPerPage: 20, pageNumber: 1, totalItems: 0, totalPages: 0 }))).toEqual([]);
    expect(checkResponse(dup.expect, answer(400, { message: ERROR_MESSAGES.unreadable }))[0], 'a refusal contradicts the pin').toMatch(/status 400, expected 200/);
    const bom = rows.find((r) => r.id === 'certificates.bom')!;
    expect(checkResponse(bom.expect, answer(200, { certificates: [], itemsPerPage: 10, pageNumber: 1 }))).toEqual([]);
    expect(checkResponse(bom.expect, answer(400, { message: ERROR_MESSAGES.unreadable }))).toEqual([]);
    expect(checkResponse(bom.expect, answer(200, { other: 1 }))[0]).toMatch(/a 200 answer must be a search page/);
    expect(checkResponse(bom.expect, answer(500, { message: ERROR_MESSAGES.internal }))[0]).toMatch(/status 500/);
    const gbom = rows.find((r) => r.id === 'groups.bom')!;
    expect(checkResponse(gbom.expect, answer(422, [ERROR_MESSAGES.nameEmpty]))).toEqual([]);
    expect(checkResponse(gbom.expect, answer(400, { message: ERROR_MESSAGES.unreadable }))).toEqual([]);
    expect(checkResponse(gbom.expect, answer(201, { uuid: 'x' }))[0], 'a 201 is a creation: never an accepted answer').toMatch(/status 201/);
    expect(checkResponse(gbom.expect, answer(422, ['something else']))[0]).toMatch(/a 422 must be/);
    const control = rows.find((r) => r.id === 'certificates.control')!;
    expect(checkResponse(control.expect, answer(200, { certificates: [], itemsPerPage: 10, pageNumber: 1 }))).toEqual([]);
    expect(checkResponse(control.expect, answer(400, { message: ERROR_MESSAGES.unreadable }))[0]).toMatch(/status 400, expected 200/);
});

// ------------------------------------------------------------------ API-GEN-06 / 07 / 08 tables

test('the content-type rows: text/plain rows are sendable, xml / multipart / no content type are the guard requests', () => {
    expect(CONTENT_TYPE_ROWS.map((r) => r.id)).toEqual(['text-plain.search', 'text-plain.create', 'application-xml.create', 'multipart.create', 'no-content-type.create']);
    expect(CONTENT_TYPE_ROWS.filter((r) => !r.guardRefused).map((r) => r.id)).toEqual(['text-plain.search', 'text-plain.create']);
    for (const r of CONTENT_TYPE_ROWS.filter((x) => x.guardRefused)) expect(r.guardRefused!.length, r.id).toBeGreaterThan(20);
    expect(contentTypeReq(CONTENT_TYPE_ROWS[0])).toMatchObject({ method: 'POST', url: '/api/v1/certificates', headers: { 'content-type': 'text/plain' } });
    expect(contentTypeReq(CONTENT_TYPE_ROWS[4]).headers, 'no content type: no header').toBeUndefined();
    // The group bodies of the content-type rows are blank-name groups: nothing can be created by them.
    for (const r of CONTENT_TYPE_ROWS.filter((x) => x.resource === 'groups')) expect(nameInBody(r.data), r.id).toBeUndefined();
    expect(acceptProblems(answer(200, { a: 1 }))).toEqual([]);
    expect(acceptProblems(answer(200, 'x', 'application/xml'))[0]).toMatch(/must be JSON/);
    expect(acceptProblems(answer(406, '', ''))).toEqual([]);
    expect(acceptProblems(answer(415, { message: 'x' }))).toEqual([]);
    expect(acceptProblems(answer(404, '[1]'))[0]).toMatch(/must be \{"message"/);
    expect(acceptProblems(answer(500, { message: ERROR_MESSAGES.internal }))[0]).toMatch(/never a server error/);
});

test('the method tables: TRACE rows, GET-on-POST-only rows, the guard-refused rows', () => {
    expect(TRACE_ROWS.map((r) => r.url)).toEqual(['/api/v1/info', '/api/v1/certificates', '/api/v1/groups']);
    expect(WRONG_METHOD_GETS.length).toBeGreaterThanOrEqual(5);
    expect(METHOD_FIXME_ROWS.map((r) => `${r.method} ${r.url}`)).toEqual(['QAPROBE /api/v1/groups', 'POST /api/v1/statistics', 'DELETE /api/v1/info']);
    expect(checkResponse(wrongMethodExpectation('GET'), answer(400, { message: "Request method 'GET' is not supported" }))).toEqual([]);
    expect(checkResponse(wrongMethodExpectation('GET'), answer(405, { message: "Request method 'GET' is not supported" }))).toEqual([]);
    expect(checkResponse(wrongMethodExpectation('GET'), answer(500, { message: ERROR_MESSAGES.internal }))[0]).toMatch(/status 500/);
    expect(checkResponse(wrongMethodExpectation('GET'), answer(400, { message: 'other' }))[0]).toMatch(/message is "other"/);
    expect(checkResponse({ status: 400, empty: true }, answer(400, ''))).toEqual([]);
    expect(checkResponse({ status: 400, empty: true }, answer(401, ''))[0], 'the migrated build answers 401 (core#2502)').toMatch(/status 401, expected 400/);
});

test('the protected endpoints: at least 20 distinct read-only paths across resources', () => {
    expect(PROTECTED_ENDPOINTS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(PROTECTED_ENDPOINTS.map((p) => p.url)).size).toBe(PROTECTED_ENDPOINTS.length);
    expect(new Set(PROTECTED_ENDPOINTS.map((p) => p.resource)).size).toBe(PROTECTED_ENDPOINTS.length);
    for (const p of PROTECTED_ENDPOINTS) expect(p.url, p.resource).toMatch(/^\/api\/v1\/[A-Za-z/]+$/);
    // none of them is a public endpoint (core AuthHelper.PERMITTED_ENDPOINTS: /v?/health/**, /v?/connector/register; branding for GET)
    for (const p of PROTECTED_ENDPOINTS) expect(p.url, p.resource).not.toMatch(/health|connector\/register|branding/);
    expect(PROTECTED_ENDPOINTS.map((p) => p.url)).toContain('/api/v1/info');
});
