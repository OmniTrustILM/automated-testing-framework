/**
 * What the guard counts as a uuid and how it reads bodies, without a network: every form a server could parse (trimmed,
 * lenient groups, base64, `urn:uuid:`) is uuid-like, only the exact canonical form is accepted, keys are scanned like
 * values, bodies are judged as serialised, and bulk targets sit in top-level lists only. The absence half of the
 * canonical-form probe is in runTeardownAbsenceProof.spec.ts.
 */
import { expect, test } from '@playwright/test';
import { findUuidsInBody, findUuidsInQuery, bodyView } from '../../utils/regression/guard/bodies';
import { bulkTargets } from '../../utils/regression/guard/targets';
import { canonicalUuid, isCanonicalUuid, isUuidLike, serverTrim, findUuidsInString, uuidTokens } from '../../utils/regression/guard/uuids';
import { platformDenied, REFERENCE_FIELDS } from '../../utils/regression/guard/allowLists';
import { pathProblem } from '../../utils/regression/guard/urls';

const U = '00000000-0000-4000-8000-000000000002';
const K = 'fbff0000-0000-4000-8000-0000000000fe';
const std24 = Buffer.from(K.replace(/-/g, ''), 'hex').toString('base64');
const url24 = std24.replace(/\+/g, '-').replace(/\//g, '_');
const url22 = url24.replace(/=+$/, '');

test('canonical form: canonical is exact; every other uuid-like form is recognised and never canonicalised', () => {
    expect([canonicalUuid(U), canonicalUuid(U.toUpperCase()), canonicalUuid(` ${U}`), canonicalUuid(std24), canonicalUuid(url24), canonicalUuid(url22)])
        .toEqual([U, U, undefined, undefined, undefined, undefined]);
    const like = [
        ` ${U}`, `${U} `, `${U}\t`, `${U}\n`, `\u0000${U}`, `${U}\u0001`, ` ${U}`, // padded (Java trim, JS whitespace)
        '0-0-4000-8000-2', '+0000000-0000-4000-8000-000000000002', '0-+0-4000-8000-2', '100000000-0-4000-8000-000000000002', // lenient groups
        U.replace(/0/g, '０'), '١-0-4000-8000-2', // Unicode digits (Character.digit)
        std24, url24, url22, std24.replace(/=+$/, ''), // base64 forms
        `urn:uuid:${U}`, `URN:UUID:${U}`, 'urn:uuid:anything', // urn prefix
    ];
    for (const v of like) expect(isUuidLike(v), JSON.stringify(v)).toBe(true);
    const not = ['', 'qa-reg-20261013-120000-ab12-role', '2026-10-14', '1-2-3-4', '1-2-3-4-5-6', 'certificateStatusChanged', 'SHA256withRSA', 'abc', 'x'.repeat(23), `${U}-x`];
    for (const v of not) expect(isUuidLike(v), JSON.stringify(v)).toBe(false);
    expect(serverTrim(`\u0000 \t${U}\r\n\u0085`)).toBe(U);
    expect(isCanonicalUuid(U.toUpperCase())).toBe(true);
});

// string findings: canonical uuids anywhere in a string must be own; non-canonical forms are refused; comma lists split
test('string findings: canonical uuids must be own; non-canonical forms refused; comma lists split', () => {
    expect(findUuidsInString(U)).toEqual({ canonical: [U], nonCanonical: [] });
    expect(findUuidsInString(` ${U}`).nonCanonical).toHaveLength(1);
    expect(findUuidsInString(`a,${U}, ${K}`)).toEqual({ canonical: [U, K], nonCanonical: [] });
    expect(findUuidsInString(`x,0-0-4000-8000-2`).nonCanonical).toHaveLength(1);
    expect(findUuidsInString(`see u${U} too`).canonical, 'glued or embedded: still named').toEqual([U]);
    // JSON string values are read whole by the server: bounded base64 / lenient tokens inside them are not refused there,
    // but query values and unparseable bodies (free text) are scanned for them.
    expect(findUuidsInString(`a ${url22} b`).nonCanonical).toEqual([]);
    expect(findUuidsInString(`a ${url22} b`, { free: true }).nonCanonical).toHaveLength(1);
    expect(findUuidsInString('qa-reg-20261013-120000-ab12-ca-1', { free: true }), 'a run-prefixed name is not a token').toEqual({ canonical: [], nonCanonical: [] });
    expect(uuidTokens(`x=${U}&y=${url22}`)).toEqual([U]);
    // Messages never carry a whole value.
    expect(findUuidsInString(` ${K}`).nonCanonical[0]).not.toContain(K);
});

// body findings: keys are scanned, attribute subtrees skipped, reference fields waived at the top level only and for canonical
// values only
test('body findings: keys scanned, attribute subtrees skipped, reference fields waived at top level', () => {
    expect(findUuidsInBody({ map: { [U]: ['read'] } }).canonical, 'a uuid as a map key').toEqual([U]);
    expect(findUuidsInBody({ [` ${U}`]: 1 }).nonCanonical, 'a padded uuid key').toHaveLength(1);
    expect(findUuidsInBody({ customAttributes: [{ uuid: U, content: [{ data: K }] }], attributes: [{ uuid: U }], fooAttributes: [K], metadata: { x: U } }))
        .toEqual({ canonical: [], nonCanonical: [] });
    expect(findUuidsInBody({ raProfileUuid: U, connectorUuid: K }, { references: true }).canonical, 'top-level references are waived').toEqual([]);
    expect(findUuidsInBody({ raProfileUuid: U }, { references: false }).canonical, 'never on a DELETE').toEqual([U]);
    expect(findUuidsInBody({ nested: [{ connectorUuid: U }], inner: { raProfileUuid: K } }, { references: true }).canonical, 'nested: no waiver').toEqual([U, K]);
    expect(findUuidsInBody({ raProfileUuid: '0-0-4000-8000-2' }, { references: true }).nonCanonical, 'a lenient reference value').toHaveLength(1);
    // The token-profile fields are no reference fields until a key teardown handler exists.
    expect(Object.keys(REFERENCE_FIELDS)).toEqual(['connectorUuid', 'interfaceUuid', 'raProfileUuid']);
    expect(findUuidsInBody({ tokenProfileUuid: U, altTokenProfileUuid: K }, { references: true }).canonical).toEqual([U, K]);
    // Prototype keys are no reference fields (Object.hasOwn): `constructor` / `toString` / `__proto__` subtrees are scanned.
    const proto = JSON.parse(`{"constructor": "${U}", "toString": ["${K}"], "__proto__": {"x": "${U}"}}`);
    expect(findUuidsInBody(proto, { references: true }).canonical).toEqual([U, K]);
});

// bodies are judged as Playwright serialises them (toJSON, functions, typed arrays, String objects, UTF-16)
test('bodies are judged as Playwright serialises them: toJSON, typed arrays, String objects, UTF-16', () => {
    expect(bodyView({ toJSON: () => [U] })).toEqual({ kind: 'json', value: [U] });
    expect(bodyView({ pipe() {}, userUuids: U })).toEqual({ kind: 'json', value: { userUuids: U } });
    expect(bodyView(Object.defineProperty({}, 'hidden', { enumerable: false, value: U }))).toEqual({ kind: 'json', value: {} });
    expect(bodyView(new Uint8Array([91, 93]))).toEqual({ kind: 'json', value: { 0: 91, 1: 93 } });
    expect(bodyView(new URLSearchParams({ a: U }))).toEqual({ kind: 'json', value: {} });
    expect(bodyView(new String(JSON.stringify([U])))).toEqual({ kind: 'json', value: [U], raw: JSON.stringify([U]) });
    expect(bodyView({ toJSON: () => undefined })).toEqual({ kind: 'none' });
    expect(bodyView(Buffer.from(JSON.stringify([U]), 'utf16le')).kind, 'NUL bytes: another encoding').toBe('unreadable');
    expect(bodyView(Buffer.from([0xff, 0xfe, 0x5b, 0x00])).kind, 'not UTF-8').toBe('unreadable');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(bodyView(circular).kind).toBe('unreadable');
    expect(bodyView(5)).toEqual({ kind: 'json', value: 5 });
});

// bulk targets: top-level lists only; empty lists, nested lists, filters anywhere and non-canonical values are refused
test('bulk targets: top-level lists only; empty, nested, filter and non-canonical values are refused', () => {
    expect(bulkTargets([U])).toEqual({ uuids: [U] });
    expect(bulkTargets({ uuids: [U], certificateUuids: [K] })).toEqual({ uuids: [U, K] });
    const problem = (d: unknown) => ('problem' in bulkTargets(d) ? (bulkTargets(d) as { problem: string }).problem : 'accepted');
    expect(problem([])).toMatch(/explicit, non-empty uuid list at the top level/);
    expect(problem({ uuids: [] })).toMatch(/empty uuids/);
    expect(problem({ uuids: [], certificateUuids: [K] })).toMatch(/empty uuids/);
    expect(problem({ x: { roleUuids: [U] } })).toMatch(/top level/);
    expect(problem([{ uuids: [U] }])).toMatch(/not a canonical uuid/);
    expect(problem({ uuids: [U], inner: { filters: [] } })).toMatch(/filters/);
    expect(problem({ uuids: [` ${U}`] })).toMatch(/not a canonical uuid/);
    expect(problem({ certificateUuids: U })).toMatch(/not a list/);
});

test('query findings read the effective URL (decoded) and the params option, keys included', () => {
    expect(findUuidsInQuery(`/x?a=%30${U.slice(1)}`).canonical).toEqual([U]);
    expect(findUuidsInQuery('/x', { [U]: '1' }).canonical).toEqual([U]);
    // The base64 forms count only as the value of a uuid-shaped key.
    expect(findUuidsInQuery(`/x?a=${url22}`).nonCanonical).toHaveLength(0);
    expect(findUuidsInQuery(`/x?keyUuid=${url22}`).nonCanonical).toHaveLength(1);
    expect(findUuidsInQuery(`/x?ids=${url24}`).nonCanonical).toHaveLength(1);
    expect(findUuidsInQuery('/x', `a=urn:uuid:${U}`).nonCanonical.length).toBeGreaterThan(0);
    expect(findUuidsInQuery('/x?name=qa-reg-20261013-120000-ab12-x&force=true')).toEqual({ canonical: [], nonCanonical: [] });
});

// pathProblem: printable ASCII, the path as written = as sent, unreserved segments, no non-canonical uuid segment
test('unsafePath: printable ASCII, path as written equals as sent, no non-canonical uuid segment', () => {
    expect(pathProblem(`/api/v1/roles/${U}/users`)).toBeUndefined();
    const refused: Array<[string, RegExp]> = [
        [`/api/v1/roles/${U}\t`, /control character/], [`/api/v1/roles/${U} `, /control character/], ['/api/v1/röles', /control character/],
        ['/api/v1/roles/./x', /dot segment/], ['/api/v1/roles/x/..', /dot segment/], ['/api/v1/roles/%2e%2e/x', /encoded/], ['/api/v1\\roles', /backslash/],
        ['/api/v1/roles/', /trailing slash/], ['api/v1/roles', /would change/], ['/api/v1/ro"les', /would change/], ['/api/v1/ro{les', /would change/], ['/api/v1/ro!les', /outside/], ['/api/v1/ro+les', /outside/],
        [`/api/v1/roles/${U}.`, /non-canonical uuid/], ['/api/v1/roles/0-0-4000-8000-2', /non-canonical uuid/],
    ];
    for (const [u, why] of refused) expect(pathProblem(u), JSON.stringify(u)).toMatch(why);
    // Base64 is no path form (Spring converts a path variable with UUID.fromString); the guard refuses
    // such a mutation segment as a name (nameSegmentProblem), tested in guardedApiInputSnapshot.spec.ts.
    expect(pathProblem(`/api/v1/roles/${url22}`)).toBeUndefined();
});

// the platform deny-list: v1 and v2, case-insensitive, purge / CBOM / OID / schedule / settings / local admins, objectUuid must
// be canonical
test('the platform deny-list covers v1 and v2, is case-insensitive, and objectUuid must be canonical', () => {
    for (const p of ['/v1/auditLogs/purge', '/v1/cboms', '/v1/cboms/upload', '/v1/cboms/sync', '/v1/oids', '/v1/oids/1.2.3', '/v1/discoveries/schedule',
        '/v2/settings/platform', '/v1/Settings/platform', '/V1/settings', '/v1/LOCAL/admins']) {
        expect(platformDenied(p), p).toBeDefined();
    }
    expect(platformDenied('/v1/workflows/events', { objectUuid: U })).toBeUndefined();
    for (const body of [{ objectUuid: ' ' }, { objectUuid: true }, { objectUuid: ` ${U}` }, { objectUuid: [U] }, [], undefined]) {
        expect(platformDenied('/v1/workflows/events', body), JSON.stringify(body)).toBeDefined();
    }
    expect(platformDenied('/v1/discoveries'), 'a discovery create is not platform-level').toBeUndefined();
});
