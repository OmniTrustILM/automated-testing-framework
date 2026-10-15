/**
 * B0 fix pass 4, N3 (Sonnet N3 + Fable, Major) and the body minors — the pure recognition rules behind the guard:
 * - uuid-like = what a server parser could read as a uuid, over-approximated: trimmed first (Java `String.trim`, JS
 *   whitespace), canonical, Java's lenient `+`-signed groups of any length (Unicode digits too), 22-character
 *   (unpadded) and 24-character (`==`) base64 incl. the URL-safe `-_` alphabet, `urn:uuid:` prefixes;
 * - only an EXACT canonical string is canonical (`canonicalUuid`); everything else uuid-like is refused, never
 *   canonicalised;
 * - object KEYS are scanned like values; reference fields are waived at the top level only, for canonical values only;
 * - bodies are judged as serialised (`JSON.parse(JSON.stringify(data))`: toJSON, dropped functions, typed arrays);
 * - bulk targets: top-level lists only, empty `uuids` / `*Uuids` and `filters` anywhere refused;
 * - prototype keys (`constructor`, `__proto__`, `toString`) never count as reference fields.
 * The rev4/canon probe's uuid half lives here (its absence half in absenceWire.spec.ts).
 */
import { expect, test } from '@playwright/test';
import {
    bodyFindings, bulkTargets, canonicalUuid, isCanonicalUuid, isUuidLike, platformDenied, queryFindings, readBody, REFERENCE_FIELDS, serverTrim,
    stringFindings, unsafePath, uuidTokens,
} from '../../utils/regression/guardedApi';

const U = '00000000-0000-4000-8000-000000000002';
const K = 'fbff0000-0000-4000-8000-0000000000fe';
const std24 = Buffer.from(K.replace(/-/g, ''), 'hex').toString('base64');
const url24 = std24.replace(/\+/g, '-').replace(/\//g, '_');
const url22 = url24.replace(/=+$/, '');

test('rev4/canon: canonical is exact; every other uuid-like form is recognised and never canonicalised', () => {
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

test('string findings: canonical uuids anywhere in a string must be own; non-canonical forms are refused; comma lists split', () => {
    expect(stringFindings(U)).toEqual({ canonical: [U], nonCanonical: [] });
    expect(stringFindings(` ${U}`).nonCanonical).toHaveLength(1);
    expect(stringFindings(`a,${U}, ${K}`)).toEqual({ canonical: [U, K], nonCanonical: [] });
    expect(stringFindings(`x,0-0-4000-8000-2`).nonCanonical).toHaveLength(1);
    expect(stringFindings(`see u${U} too`).canonical, 'glued or embedded: still named').toEqual([U]);
    // JSON string values are read whole by the server: bounded base64 / lenient tokens inside them are not refused there,
    // but query values and unparseable bodies (free text) are scanned for them.
    expect(stringFindings(`a ${url22} b`).nonCanonical).toEqual([]);
    expect(stringFindings(`a ${url22} b`, { free: true }).nonCanonical).toHaveLength(1);
    expect(stringFindings('qa-reg-20261013-120000-ab12-ca-1', { free: true }), 'a run-prefixed name is not a token').toEqual({ canonical: [], nonCanonical: [] });
    expect(uuidTokens(`x=${U}&y=${url22}`)).toEqual([U]);
    // Messages never carry a whole value.
    expect(stringFindings(` ${K}`).nonCanonical[0]).not.toContain(K);
});

test('body findings: keys are scanned, attribute subtrees skipped, reference fields waived at the top level only and for canonical values only', () => {
    expect(bodyFindings({ map: { [U]: ['read'] } }).canonical, 'a uuid as a map key').toEqual([U]);
    expect(bodyFindings({ [` ${U}`]: 1 }).nonCanonical, 'a padded uuid key').toHaveLength(1);
    expect(bodyFindings({ customAttributes: [{ uuid: U, content: [{ data: K }] }], attributes: [{ uuid: U }], fooAttributes: [K], metadata: { x: U } }))
        .toEqual({ canonical: [], nonCanonical: [] });
    expect(bodyFindings({ raProfileUuid: U, connectorUuid: K }, { references: true }).canonical, 'top-level references are waived').toEqual([]);
    expect(bodyFindings({ raProfileUuid: U }, { references: false }).canonical, 'never on a DELETE').toEqual([U]);
    expect(bodyFindings({ nested: [{ connectorUuid: U }], inner: { raProfileUuid: K } }, { references: true }).canonical, 'nested: no waiver').toEqual([U, K]);
    expect(bodyFindings({ raProfileUuid: '0-0-4000-8000-2' }, { references: true }).nonCanonical, 'a lenient reference value').toHaveLength(1);
    // Fix pass 4: the token-profile fields are no reference fields until the B2 key handler exists.
    expect(Object.keys(REFERENCE_FIELDS)).toEqual(['connectorUuid', 'interfaceUuid', 'raProfileUuid']);
    expect(bodyFindings({ tokenProfileUuid: U, altTokenProfileUuid: K }, { references: true }).canonical).toEqual([U, K]);
    // Prototype keys are no reference fields (Object.hasOwn): `constructor` / `toString` / `__proto__` subtrees are scanned.
    const proto = JSON.parse(`{"constructor": "${U}", "toString": ["${K}"], "__proto__": {"x": "${U}"}}`);
    expect(bodyFindings(proto, { references: true }).canonical).toEqual([U, K]);
});

test('bodies are judged as Playwright serialises them (toJSON, functions, typed arrays, String objects, UTF-16)', () => {
    expect(readBody({ toJSON: () => [U] })).toEqual({ kind: 'json', value: [U] });
    expect(readBody({ pipe() {}, userUuids: U })).toEqual({ kind: 'json', value: { userUuids: U } });
    expect(readBody(Object.defineProperty({}, 'hidden', { enumerable: false, value: U }))).toEqual({ kind: 'json', value: {} });
    expect(readBody(new Uint8Array([91, 93]))).toEqual({ kind: 'json', value: { 0: 91, 1: 93 } });
    expect(readBody(new URLSearchParams({ a: U }))).toEqual({ kind: 'json', value: {} });
    expect(readBody(new String(JSON.stringify([U])))).toEqual({ kind: 'json', value: [U], raw: JSON.stringify([U]) });
    expect(readBody({ toJSON: () => undefined })).toEqual({ kind: 'none' });
    expect(readBody(Buffer.from(JSON.stringify([U]), 'utf16le')).kind, 'NUL bytes: another encoding').toBe('unreadable');
    expect(readBody(Buffer.from([0xff, 0xfe, 0x5b, 0x00])).kind, 'not UTF-8').toBe('unreadable');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(readBody(circular).kind).toBe('unreadable');
    expect(readBody(5)).toEqual({ kind: 'json', value: 5 });
});

test('bulk targets: top-level lists only; empty lists, nested lists, filters anywhere and non-canonical values are refused', () => {
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
    expect(queryFindings(`/x?a=%30${U.slice(1)}`).canonical).toEqual([U]);
    expect(queryFindings('/x', { [U]: '1' }).canonical).toEqual([U]);
    // Fix pass 5 (F3): the base64 forms count only as the value of a uuid-shaped key.
    expect(queryFindings(`/x?a=${url22}`).nonCanonical).toHaveLength(0);
    expect(queryFindings(`/x?keyUuid=${url22}`).nonCanonical).toHaveLength(1);
    expect(queryFindings(`/x?ids=${url24}`).nonCanonical).toHaveLength(1);
    expect(queryFindings('/x', `a=urn:uuid:${U}`).nonCanonical.length).toBeGreaterThan(0);
    expect(queryFindings('/x?name=qa-reg-20261013-120000-ab12-x&force=true')).toEqual({ canonical: [], nonCanonical: [] });
});

test('unsafePath: printable ASCII, the path as written = as sent, unreserved segments, no non-canonical uuid segment', () => {
    expect(unsafePath(`/api/v1/roles/${U}/users`)).toBeUndefined();
    const refused: Array<[string, RegExp]> = [
        [`/api/v1/roles/${U}\t`, /control character/], [`/api/v1/roles/${U} `, /control character/], ['/api/v1/röles', /control character/],
        ['/api/v1/roles/./x', /dot segment/], ['/api/v1/roles/x/..', /dot segment/], ['/api/v1/roles/%2e%2e/x', /encoded/], ['/api/v1\\roles', /backslash/],
        ['/api/v1/roles/', /trailing slash/], ['api/v1/roles', /would change/], ['/api/v1/ro"les', /would change/], ['/api/v1/ro{les', /would change/], ['/api/v1/ro!les', /outside/], ['/api/v1/ro+les', /outside/],
        [`/api/v1/roles/${U}.`, /non-canonical uuid/], ['/api/v1/roles/0-0-4000-8000-2', /non-canonical uuid/],
    ];
    for (const [u, why] of refused) expect(unsafePath(u), JSON.stringify(u)).toMatch(why);
    // Fix pass 5 (F3): base64 is no path form (Spring converts a path variable with UUID.fromString); the guard refuses
    // such a mutation segment as a name (nameSegmentProblem), tested in guardWire5.
    expect(unsafePath(`/api/v1/roles/${url22}`)).toBeUndefined();
});

test('the platform deny-list: v1 and v2, case-insensitive, the fix-pass-4 additions, objectUuid must be canonical', () => {
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
