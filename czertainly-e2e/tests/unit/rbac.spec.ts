/**
 * The pure parts of the rbac/ folder, no server and no browser: jwtTools (decode, tamper, forge, the token variants), identities (profile
 * shape, second-identity and local-Keycloak preflights, the anonymous target, the 401 leak check), authApi's permission body, and
 * permissionMatrix's decision table (fixture documents, the certificate and administration tables, consistency).
 */
import { expect, test } from '@playwright/test';
import { permissionBody } from '../../utils/regression/rbac/authApi';
import { anonymousTarget, coreReplicas, rolesAfterSignInProblem, DOCUMENTATION_ADDRESS, isNotGrantableAction, keycloakLocalBlocker, leaksInternals, parseProfile, replicaBlocker, restrictedIdentity, SECOND_IDENTITY_REQUEST, secondIdentityBlocker } from '../../utils/regression/rbac/identities';
import { ANONYMOUS_VARIANTS, buildVariant, claimOf, decodeJwt, echoesToken, signWithThrowawayKey, syntheticClaims, tamperPayload, tamperSignature, TOKEN_VARIANTS, TOKENLESS_VARIANTS, TokenVariant, UNKNOWN_ISSUER, unsignedToken } from '../../utils/regression/rbac/jwtTools';
import { base64Url } from '../../utils/regression/text';
import { accessDeniedProblems, cellPair, cellStatus, CERT_KEYS, DENY_NUANCES, expectedResourceActions, Fixture, fixtureDocument, FIXTURES, MATRIX_A_DETAIL, MATRIX_A_LIST, MATRIX_A_PROFILE, MATRIX_B_ISSUE_P1, MATRIX_B_ISSUE_P2, MATRIX_B_RA_CREATE, MATRIX_B_RA_DETAIL_P1, MATRIX_B_RA_DETAIL_P2, MATRIX_B_RA_LIST, MATRIX_B_ROLES_LIST, NESTED_GATE_FIXTURES } from '../../utils/regression/rbac/permissionMatrix';
import { randomBytes } from 'node:crypto';
// Run-scoped generated test passwords: no password-like literal in the file.
const GEN_PW_1 = `qa-${randomBytes(9).toString('base64url')}`;

// ------------------------------------------------------------------ jwtTools

const REAL_ISSUER = 'https://idp.example.test/realms/qa';
const validToken = (): string => signWithThrowawayKey({ kid: 'key-1' }, { iss: REAL_ISSUER, sub: 'subject-1', username: 'qa-user', jti: 'jti-1', exp: 4_000_000_000 });
const sigBytes = (token: string): Buffer => Buffer.from(token.split('.')[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('decodeJwt / claimOf read a compact token without verifying it; a malformed token throws', () => {
    const t = validToken();
    const d = decodeJwt(t);
    expect(d.header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'key-1' });
    expect(claimOf(t, 'username')).toBe('qa-user');
    expect(claimOf(t, 'nope')).toBeUndefined();
    expect(() => decodeJwt('a.b')).toThrow(/3|segment/);
    expect(() => decodeJwt(`${base64Url('{"a":1}')}.${base64Url('[1]')}.x`)).toThrow(/payload is not a JSON object/);
    expect(sigBytes(t).length, 'an RS256-2048 signature is 256 bytes').toBe(256);
});

test('tamperSignature changes the FIRST signature character and so the signature bytes; the last character of an RS256 signature can change without changing them (why it is not used)', () => {
    const t = validToken();
    const tampered = tamperSignature(t);
    expect(tampered.split('.').slice(0, 2)).toEqual(t.split('.').slice(0, 2));
    expect(tampered).not.toBe(t);
    expect(sigBytes(tampered).equals(sigBytes(t)), 'the decoded signature differs').toBe(false);
    const sig = t.split('.')[2];
    expect(sig.length).toBe(342);
    // The last base64url character holds 2 data bits and 4 padding bits: a neighbour with the same two data bits decodes identically.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(sig[sig.length - 1]);
    const sibling = alphabet[(last & 0b110000) | ((last & 0b1111) === 0 ? 1 : 0)];
    const same = `${sig.slice(0, -1)}${sibling}`;
    if (sibling !== sig[sig.length - 1]) expect(Buffer.from(same.replace(/-/g, '+').replace(/_/g, '/'), 'base64').equals(sigBytes(t))).toBe(true);
});

test('tamperPayload changes exactly one character of the payload JSON (still valid JSON, different claims); head and signature are kept', () => {
    const t = validToken();
    const tampered = tamperPayload(t);
    const [h, p, s] = t.split('.');
    const [h2, p2, s2] = tampered.split('.');
    expect([h2, s2]).toEqual([h, s]);
    const a = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const b = Buffer.from(p2.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(b.length).toBe(a.length);
    expect([...a].filter((c, i) => c !== b[i])).toHaveLength(1);
    expect(() => JSON.parse(b)).not.toThrow();
    expect(JSON.parse(b)).not.toEqual(JSON.parse(a));
});

test('unsignedToken is `alg: none` with an empty signature segment', () => {
    const t = unsignedToken({ username: 'qa-user' });
    expect(t.endsWith('.')).toBe(true);
    expect(decodeJwt(t).header).toMatchObject({ alg: 'none' });
    expect(decodeJwt(t).segments[2]).toBe('');
});

test('buildVariant: the ten PT-03 variants — token-less ones need no token, the others refuse to be built without it', () => {
    const t = validToken();
    const all = [...TOKENLESS_VARIANTS, ...TOKEN_VARIANTS, ...ANONYMOUS_VARIANTS];
    expect(new Set(all).size).toBe(10);
    for (const v of TOKENLESS_VARIANTS) {
        const r = buildVariant(v, { username: 'qa-user' });
        expect(r.variant).toBe(v);
        expect(r.authorization, v).toBeDefined();
        expect(r.authorization).not.toContain(t);
    }
    for (const v of [...TOKEN_VARIANTS, ...ANONYMOUS_VARIANTS] as TokenVariant[]) expect(() => buildVariant(v, { username: 'qa-user' }), v).toThrow(/needs the valid token/);

    expect(buildVariant('signature', { username: 'u', validToken: t }).authorization).toBe(`Bearer ${tamperSignature(t)}`);
    expect(buildVariant('payload', { username: 'u', validToken: t }).authorization).toBe(`Bearer ${tamperPayload(t)}`);
    const forged = buildVariant('forged-real-issuer', { username: 'u', validToken: t }).authorization!.replace('Bearer ', '');
    expect(decodeJwt(forged).payload, 'the real claims, issuer included').toEqual(decodeJwt(t).payload);
    expect(decodeJwt(forged).header.kid).toBe('key-1');
    const unknown = decodeJwt(buildVariant('forged-unknown-issuer', { username: 'u' }).authorization!.replace('Bearer ', ''));
    expect(unknown.payload.iss).toBe(UNKNOWN_ISSUER);
    const noIss = decodeJwt(buildVariant('no-iss', { username: 'u' }).authorization!.replace('Bearer ', ''));
    expect('iss' in noIss.payload).toBe(false);
    expect(buildVariant('not-a-jwt', { username: 'u' }).authorization).toBe('Bearer not-a-token');
    expect(buildVariant('empty', { username: 'u' }).authorization).toBe('Bearer ');
    expect(buildVariant('wrong-scheme', { username: 'u' }).authorization).toMatch(/^Basic /);
    expect(buildVariant('query-only', { username: 'u', validToken: t })).toMatchObject({ query: { access_token: tamperSignature(t) } });
    expect(buildVariant('query-only', { username: 'u', validToken: t }).query?.access_token, 'the valid token never goes into a URL').not.toBe(t);
    expect(buildVariant('query-only', { username: 'u', validToken: t }).authorization).toBeUndefined();
    expect(syntheticClaims('u').username).toBe('u');
});

test('echoesToken: a refusal that repeats the token (or any JWT-shaped run) is caught', () => {
    const t = validToken();
    expect(echoesToken('', t)).toBe(false);
    expect(echoesToken('{"message":"Unauthorized"}', t)).toBe(false);
    expect(echoesToken(`{"message":"bad ${t}"}`, t)).toBe(true);
    expect(echoesToken(`{"message":"bad ${t.slice(0, 40)}"}`, t)).toBe(true);
    expect(echoesToken('see eyJhbGciOiJSUzI1NiJ9.eyJ1c2VybmFtZSI6InFhIn0.sig', undefined)).toBe(true);
});

// ------------------------------------------------------------------ identities

const PROFILE = {
    uuid: '00000000-0000-4000-8000-000000000001', username: 'qa-user', enabled: true, roles: [{ uuid: '00000000-0000-4000-8000-000000000002', name: 'admin' }],
    permissions: { allowedListings: ['dashboard', 'approvals'], allowedActions: [{ resource: 'certificates', actions: ['list', 'detail'] }] },
};

test('parseProfile reads the real UserProfileDetailDto (top-level username, permissions.*) and names the old shape when it sees it', () => {
    expect(parseProfile(PROFILE)).toEqual({
        uuid: PROFILE.uuid, username: 'qa-user', enabled: true, roles: [{ uuid: PROFILE.roles[0].uuid, name: 'admin' }], allowedListings: ['dashboard', 'approvals'],
        allowedActions: [{ resource: 'certificates', actions: ['list', 'detail'] }],
    });
    expect(() => parseProfile({ user: { username: 'qa-user' }, allowedListings: [], allowedActions: [] })).toThrow(/top-level `username`/);
    expect(() => parseProfile({ username: 'x' })).toThrow(/permissions\.allowedListings/);
    expect(() => parseProfile(undefined)).toThrow(/not a JSON object/);
    expect(isNotGrantableAction('ANY')).toBe(true);
    expect(isNotGrantableAction('none')).toBe(true);
    expect(isNotGrantableAction('list')).toBe(false);
});

test('secondIdentityBlocker names the DevOps request while DED is missing, and refuses DED = the admin account', () => {
    expect(secondIdentityBlocker('admin-test', {})).toContain(SECOND_IDENTITY_REQUEST);
    expect(secondIdentityBlocker('admin-test', {})).toMatch(/^\[blocked: second identity\]/);
    expect(secondIdentityBlocker('admin-test', { REG_RESTRICTED_USERNAME: 'qa-ded' })).toContain('DevOps request 2');
    expect(secondIdentityBlocker('Admin-Test', { REG_RESTRICTED_USERNAME: ' admin-TEST ', REG_RESTRICTED_PASSWORD: GEN_PW_1 })).toMatch(/equals the admin test user/);
    expect(secondIdentityBlocker('admin-test', { REG_RESTRICTED_USERNAME: 'qa-ded', REG_RESTRICTED_PASSWORD: GEN_PW_1 })).toBeUndefined();
    expect(restrictedIdentity({ REG_RESTRICTED_USERNAME: ' qa-ded ', REG_RESTRICTED_PASSWORD: GEN_PW_1 })).toEqual({ username: 'qa-ded', password: GEN_PW_1 });
    expect(restrictedIdentity({ REG_RESTRICTED_USERNAME: 'qa-ded' })).toBeUndefined();
});

test('keycloakLocalBlocker: a shared tier and a header-mode stack are named; only a local stack with a sign-in form passes. replicaBlocker: one core replica only', () => {
    expect(keycloakLocalBlocker('local', { TIER_KIND: 'shared' })).toMatch(/local stack \(TIER_KIND=local\) is required/);
    expect(keycloakLocalBlocker('header', { TIER_KIND: 'local' })).toMatch(/AUTH_MODE=header.*Keycloak in the local compose/);
    expect(keycloakLocalBlocker('local', { TIER_KIND: 'local' })).toBeUndefined();
    expect(coreReplicas({})).toBe(1);
    expect(coreReplicas({ REG_CORE_REPLICAS: '3' })).toBe(3);
    expect(coreReplicas({ REG_CORE_REPLICAS: 'x' })).toBe(1);
    expect(replicaBlocker({})).toBeUndefined();
    expect(replicaBlocker({ REG_CORE_REPLICAS: '2' })).toMatch(/2 core replicas/);
});

test('anonymousTarget: BASE_URL without extras on a shared tier; the core\'s own port with a documentation-range X-Forwarded-For on a local stack', () => {
    expect(anonymousTarget({ TIER_KIND: 'shared', REG_LOCAL_CORE_URL: 'http://127.0.0.1:8080' })).toEqual({ base: '', headers: { Accept: 'application/json' } });
    expect(anonymousTarget({ TIER_KIND: 'local' })).toEqual({ base: '', headers: { Accept: 'application/json' } });
    expect(anonymousTarget({ TIER_KIND: 'local', REG_LOCAL_CORE_URL: 'http://127.0.0.1:8080/' })).toEqual({
        base: 'http://127.0.0.1:8080', headers: { 'X-Forwarded-For': DOCUMENTATION_ADDRESS, Accept: 'application/json' },
    });
    expect(DOCUMENTATION_ADDRESS).toMatch(/^192\.0\.2\./);
});

test('leaksInternals: stack traces, exception classes, source references and the Whitelabel page are caught; a plain 401 body is not', () => {
    expect(leaksInternals('')).toBeUndefined();
    expect(leaksInternals('{"message":"Unauthorized"}')).toBeUndefined();
    expect(leaksInternals('{"timestamp":"x","status":401,"error":"Unauthorized","path":"/api/v1/roles"}')).toBeUndefined();
    expect(leaksInternals('<h1>Whitelabel Error Page</h1>')).toBe('the Whitelabel error page');
    expect(leaksInternals('java.lang.IllegalStateException: boom')).toBe('a Java exception class');
    expect(leaksInternals('trace\n\tat com.example.Foo.bar(Foo.java:42)')).toBe('a stack trace');
    expect(leaksInternals('see Foo.java:42')).toBe('a source file reference');
});

// ------------------------------------------------------------------ permissionMatrix

const REFS = {
    p1: { uuid: '00000000-0000-4000-8000-0000000000a1', name: 'p1' }, p2: { uuid: '00000000-0000-4000-8000-0000000000a2', name: 'p2' },
    g1: { uuid: '00000000-0000-4000-8000-0000000000b1', name: 'g1' }, g2: { uuid: '00000000-0000-4000-8000-0000000000b2', name: 'g2' },
};
const AUDITOR = { allowAllResources: false, resources: [{ name: 'certificates', allowAllActions: false, actions: ['list', 'detail', 'members', 'export'] }] };

test('fixture documents: F0…F6 as the RBAC decision table defines them; none grants ANY / NONE; F6 needs the auditor document', () => {
    for (const f of FIXTURES) {
        const doc = fixtureDocument(f, REFS, f === 'F6' ? AUDITOR : undefined);
        for (const r of doc.resources ?? []) {
            expect((r.actions ?? []).filter(isNotGrantableAction), `${f} ${r.name}`).toEqual([]);
            for (const o of r.objects ?? []) expect([...(o.allow ?? []), ...(o.deny ?? [])].filter(isNotGrantableAction)).toEqual([]);
        }
    }
    expect(() => fixtureDocument('F6', REFS)).toThrow(/auditor/);
    expect(fixtureDocument('F0', {})).toEqual({ allowAllResources: false, resources: [] });
    expect(fixtureDocument('F1', {})).toEqual({ allowAllResources: false, resources: [{ name: 'certificates', actions: ['list', 'detail'] }] });
    expect(() => fixtureDocument('F2', {})).toThrow(/names p1/);
    const f2 = fixtureDocument('F2', REFS);
    const f2b = fixtureDocument('F2b', REFS);
    expect(f2.resources!.find((r) => r.name === 'raProfiles')).toMatchObject({ actions: ['list'], objects: [{ uuid: REFS.p1.uuid, allow: ['detail', 'members'] }] });
    expect(f2b.resources!.find((r) => r.name === 'raProfiles')).toMatchObject({ actions: [], objects: [{ uuid: REFS.p1.uuid, allow: ['list', 'detail', 'members'] }] });
    expect(fixtureDocument('F3', REFS)).toEqual({ allowAllResources: false, resources: [{ name: 'groups', actions: [], objects: [{ uuid: REFS.g1.uuid, name: 'g1', allow: ['members'], deny: [] }] }] });
    const deny = (f: Fixture) => fixtureDocument(f, REFS).resources!.find((r) => r.name === 'raProfiles')!.objects![0];
    expect([deny('F4a').deny, deny('F4b').deny, deny('F4c').deny]).toEqual([['detail'], ['members'], ['list']]);
    expect(deny('F4a').uuid).toBe(REFS.p2.uuid);
    const f5 = fixtureDocument('F5', REFS);
    expect(f5.allowAllResources).toBe(true);
    expect(f5.resources![0].objects![0]).toMatchObject({ uuid: REFS.p2.uuid, deny: ['detail', 'members'] });
    expect(fixtureDocument('F6', REFS, AUDITOR)).toBe(AUDITOR);
});

test('the profile expectations of matrix A equal the resource-level actions of the fixture documents (a transcription check)', () => {
    for (const f of FIXTURES.filter((x) => x !== 'F5' && x !== 'F6')) {
        const want = MATRIX_A_PROFILE[f].actions;
        expect(want, f).not.toBe('all');
        expect(expectedResourceActions(fixtureDocument(f, REFS)), f).toEqual(want);
    }
    expect(expectedResourceActions(fixtureDocument('F5', REFS))).toBeUndefined();
});

test('matrix A is internally consistent: every listed certificate has a 200 detail cell, every absent one a 403; the H-1 rows (c3, cg*) are not asserted for F4b / F5', () => {
    for (const f of FIXTURES) {
        const { present, absent } = MATRIX_A_LIST[f];
        for (const k of present) expect(cellStatus(MATRIX_A_DETAIL[k][f]), `${f} lists ${k}`).toBe(200);
        for (const k of absent) expect(cellStatus(MATRIX_A_DETAIL[k][f]), `${f} hides ${k}`).toBe(403);
        expect(present.filter((k) => absent.includes(k))).toEqual([]);
    }
    for (const f of ['F4b', 'F5'] as Fixture[]) {
        const asserted = new Set([...MATRIX_A_LIST[f].present, ...MATRIX_A_LIST[f].absent]);
        expect(CERT_KEYS.filter((k) => !asserted.has(k)).sort(), `${f}: the H-1 rows`).toEqual(['c3', 'cg1', 'cg12', 'cg2']);
    }
    // Every 403 of matrix A names its pair (first gate Detail / Certificate, second gate Members / RA Profile).
    for (const k of CERT_KEYS) for (const f of FIXTURES) {
        const c = MATRIX_A_DETAIL[k][f];
        if (cellStatus(c) === 403) expect(cellPair(c), `${k} ${f}`).toBeDefined();
    }
});

test('matrix B is internally consistent: issue needs RA-profile detail on P1; P2 is never issued; the deny nuances of F4a / b / c match matrix A and B', () => {
    for (const f of FIXTURES) {
        if (cellStatus(MATRIX_B_ISSUE_P1[f]) === 200) expect(cellStatus(MATRIX_B_RA_DETAIL_P1[f]), `${f}: issue on P1 needs detail on P1`).toBe(200);
        expect(cellStatus(MATRIX_B_ISSUE_P2[f]), `${f}: nobody issues on P2`).toBe(403);
        if (cellStatus(MATRIX_B_RA_CREATE[f]) === 200) expect(cellStatus(MATRIX_B_ROLES_LIST[f]), `${f}: the only creator holds every resource`).toBe(200);
    }
    for (const f of ['F4a', 'F4b', 'F4c'] as const) {
        const n = DENY_NUANCES[f];
        expect(cellStatus(n.p2Detail)).toBe(cellStatus(MATRIX_B_RA_DETAIL_P2[f]));
        const list = MATRIX_B_RA_LIST[f];
        expect(list.status === 200 && list.has.includes('p2'), `${f}: P2 in the RA list`).toBe(n.p2InRaList);
        expect(MATRIX_A_LIST[f].present.includes('c2') || MATRIX_A_LIST[f].absent.includes('c2')).toBe(true);
        expect(MATRIX_A_LIST[f].present.includes('c2'), `${f}: c2 visible`).toBe(n.certificatesOfP2 === 'visible');
    }
    expect(NESTED_GATE_FIXTURES).not.toContain('F5');
    expect(NESTED_GATE_FIXTURES).not.toContain('F2');
});

test('accessDeniedProblems: the 403 contract — problem+json, ACCESS_DENIED, the message shape and the pair', () => {
    const ok = { code: 'ACCESS_DENIED', message: "Access Denied. Required 'Detail' permission for 'Certificate'", statusCode: 403 };
    expect(accessDeniedProblems('application/problem+json', ok, { action: 'Detail', resource: 'Certificate' })).toEqual([]);
    expect(accessDeniedProblems('application/problem+json;charset=UTF-8', ok, undefined)).toEqual([]);
    expect(accessDeniedProblems('application/json', ok, undefined)).toEqual([expect.stringContaining('application/problem+json')]);
    expect(accessDeniedProblems('application/problem+json', { ...ok, code: 'X' }, undefined)).toEqual([expect.stringContaining('ACCESS_DENIED')]);
    expect(accessDeniedProblems('application/problem+json', { ...ok, message: 'Access denied' }, undefined)).toEqual([expect.stringContaining('does not match')]);
    expect(accessDeniedProblems('application/problem+json', ok, { action: 'Members', resource: 'RA Profile' })).toEqual([expect.stringContaining('expected the pair Members / RA Profile')]);
    expect(accessDeniedProblems('application/problem+json', 'x', undefined)).toContain('the body is not a JSON object');
});

test('permissionBody: explicit allowAllActions, empty action lists, and `objects` only where the document names them', () => {
    expect(permissionBody({ allowAllResources: false })).toEqual({ allowAllResources: false, resources: [] });
    expect(permissionBody({ allowAllResources: true, resources: [{ name: 'certificates', actions: ['list'] }, { name: 'raProfiles', objects: [] }, { name: 'groups', allowAllActions: true }] })).toEqual({
        allowAllResources: true,
        resources: [
            { name: 'certificates', allowAllActions: false, actions: ['list'] },
            { name: 'raProfiles', allowAllActions: false, actions: [], objects: [] },
            { name: 'groups', allowAllActions: true, actions: [] },
        ],
    });
});

test('the multi-word action of API-AUTH-30 is the human form core builds: "Check Compliance" (camelToHumanForm) for "Compliance Profile"', () => {
    const ok = { code: 'ACCESS_DENIED', message: "Access Denied. Required 'Check Compliance' permission for 'Compliance Profile'", statusCode: 403 };
    expect(accessDeniedProblems('application/problem+json', ok, { action: 'Check Compliance', resource: 'Compliance Profile' })).toEqual([]);
    expect(accessDeniedProblems('application/problem+json', { ...ok, message: ok.message.replace('Check Compliance', 'Check compliance') }, { action: 'Check Compliance', resource: 'Compliance Profile' }))
        .toEqual([expect.stringContaining('expected the pair Check Compliance / Compliance Profile')]);
});

test('rolesAfterSignInProblem: the roles the API set must survive the UI sign-in; a mismatch names the sync policy, not RBAC', () => {
    expect(rolesAfterSignInProblem(['b', 'a'], ['a', 'b'])).toBeUndefined();
    expect(rolesAfterSignInProblem([], ['a'])).toMatch(/SYNC_POLICY=sync-data.*DevOps request 4.*core#2226.*not an RBAC failure/);
    expect(rolesAfterSignInProblem(['a', 'x'], ['a'])).toMatch(/SYNC_POLICY/);
    expect(rolesAfterSignInProblem(['x'], ['a'])).toMatch(/SYNC_POLICY/);
    expect(rolesAfterSignInProblem([], [])).toBeUndefined();
});
