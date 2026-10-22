/**
 * Path rules and resource typing of the guard, on the wire: reads and redirect hops obey the structural path rule; an
 * ownership claim counts only with a ledger line of the type of the resource the route acts on (path targets, bulk
 * routes, typed body fields); the base64 uuid forms. The `safety list:` rows pin the literal route and field tables of
 * utils/regression/guard/routes.ts: change those tables deliberately, and these rows with them.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import {
    BODY_FIELD_TYPES, BULK_ROUTES, bulkRoute, LIST_BODY_TYPES, listBodyRoute, RESOURCE_TYPES, resourceTypeAt, SIBLING_TYPED_FIELDS, SIDE_EFFECT_GETS,
    sideEffectGet, TARGET_TYPES, UNMAPPED_UUID_FIELDS, UUID_TYPED_FIELDS,
} from '../../utils/regression/guard/routes';
import { assertSameOrigin, readPathProblem, resolveSentUrl } from '../../utils/regression/guard/urls';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { isUuidField, UUID_FIELD_NAME } from '../../utils/regression/guard/uuids';
import { pathTargets } from '../../utils/regression/guard/targets';
import { PLATFORM_DENY, platformDenied, POST_CREATE, POST_READ, postRouteKind } from '../../utils/regression/guard/allowLists';
import { ID_NAMED, LIVE_READS, OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { apiJson } from '../../utils/regression/apiReads';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { Arrived, LoopbackServer } from './helpers/loopbackServer';
import { registerGuardRig, withProcessEnv, looseApi } from './helpers/guardRig';

const RUN = 'qa-reg-20261014-150000-gh78';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A pre-existing RA profile that a spec (wrongly) recorded under the id-named type `approvals`. */
const PRE_RA = U(40);
/** A pre-existing authority: a scope parent, never a target. */
const AUTH = U(9);
const FOREIGN = U(11);
const TOKEN = U(90);
const ENTITY = U(91);
const VAULT = U(92);

/** One own object per ledger type (live-checked and id-named), U(100 + i). */
const TYPES = [...Object.keys(LIVE_READS), ...ID_NAMED];
const OWN: Record<string, string> = Object.fromEntries(TYPES.map((t, i) => [t, U(100 + i)]));
// A key item (`keyItems`) is read live under its parent key.
const PARENTS: Record<string, Record<string, string>> = {
    tokenProfiles: { token: TOKEN }, locations: { entity: ENTITY }, vaultProfiles: { vault: VAULT }, keyItems: { key: OWN.keys },
    // An approval is decided only for an own certificate and an own approval profile, named here.
    approvals: { certificate: OWN.certificates, approvalProfile: OWN.approvalProfiles },
};
const nameOf = (t: string) => (t === 'certificates' ? `${RUN}.example.test` : `${RUN}-${t}`);
const line = (type: string, uuid: string, name = nameOf(type)): LedgerLine =>
    ({ at: 'a', runId: RUN, type, name, uuid, spec: 'T', event: 'created', ...(PARENTS[type] ? { parents: PARENTS[type] } : {}) });
const lines: LedgerLine[] = [...TYPES.map((t) => line(t, OWN[t])), line('approvals', PRE_RA, `${RUN}-approval`)];

/** One uuid, recorded as `approvals` in `lines` and as `groups` in `linesAsGroup`. */
const X = U(300);
const linesAsApproval: LedgerLine[] = [...lines, line('approvals', X)];
const linesAsGroup: LedgerLine[] = [...lines, line('groups', X)];
/** The same X recorded as a user / a role. */
const linesAsUser: LedgerLine[] = [...lines, line('users', X)];
const linesAsRole: LedgerLine[] = [...lines, line('roles', X)];

/** The fake core's live objects (GET), filled in beforeAll from LIVE_READS; every other GET answers 404. */
const live: Record<string, unknown> = {
    [`/api/v1/raProfiles/${PRE_RA}`]: { name: 'Pre-existing RA profile' }, [`/api/v1/groups/${X}`]: { name: nameOf('groups') },
    [`/api/v1/users/${X}`]: { username: nameOf('users') }, [`/api/v1/roles/${X}`]: { name: nameOf('roles') },
};
/**
 * The own approval's detail names its own certificate and approval profile (not in `live`: the GET is a side-effect GET the rows count).
 */
const approvalDetails: Record<string, unknown> = {
    [`/api/v1/approvals/${OWN.approvals}`]: { resource: 'certificates', objectUuid: OWN.certificates, approvalProfileUuid: OWN.approvalProfiles },
};

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

const coreAnswer = (a: Arrived) => {
    if (a.method === 'GET' || a.method === 'HEAD') {
        // The Location travels in the QUERY (a query may hold any escape; the GET path itself must be plain).
        const m = /^\/api\/v1\/redirect\?to=(.*)$/.exec(a.url);
        if (m) return { status: 302, headers: { location: decodeURIComponent(m[1]) } };
        const body = live[a.url] ?? approvalDetails[a.url];
        return body ? { status: 200, body } : { status: 404, body: {} };
    }
    return undefined;
};

registerGuardRig(
    {
        answer: coreAnswer,
        afterStart: async () => {
            for (const t of Object.keys(LIVE_READS)) {
                const l = lines.find((x) => x.uuid === OWN[t])!;
                const url = await LIVE_READS[t].url(raw, OWN[t], l);
                live[url!] = t === 'users' ? { username: nameOf(t) } : t === 'certificates' ? { commonName: nameOf(t) } : { name: nameOf(t) };
            }
        },
    },
    (rig) => {
        A = rig.A;
        B = rig.B;
        raw = rig.raw;
        BASE_URL = rig.BASE_URL;
    },
);

const guard = () => guardApiWithSeams(raw, { lines, runId: RUN, tier: null, env: { BASE_URL } });

/** The refusal kind and reason of a guarded call ('sent' when it went through). */
async function refusal(call: Promise<unknown>): Promise<{ kind: RefusalKind | 'sent' | string; reason: string }> {
    try {
        await call;
        return { kind: 'sent', reason: '' };
    } catch (e) {
        return e instanceof OwnObjectViolation ? { kind: e.kind, reason: e.reason } : { kind: `error: ${String(e).slice(0, 160)}`, reason: '' };
    }
}

/** Everything that reached a server except the guard's own live reads of the own objects. */
const sentTo = (s: LoopbackServer) => s.arrived.filter((a) => !(a.method === 'GET' && live[a.url] !== undefined && !a.url.includes(PRE_RA))).map((a) => `${a.method} ${a.url}`);

const b64 = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex').toString('base64');
const url24 = (u: string) => b64(u).replace(/\+/g, '-').replace(/\//g, '_');
const b22 = (u: string) => b64(u).replace(/=+$/, '');
const url22 = (u: string) => url24(u).replace(/=+$/, '');

// ------------------------------------------------------------------ read path rule

/** GET paths that reached a side-effect endpoint (or another one) through a spelling the old rule did not normalise. */
const G1_REFUSED: Array<[string, RegExp]> = [
    // Tomcat-normalised spellings
    [`/api/v1//certificates/${FOREIGN}/validate`, /empty segment/],
    [`/api//v1/certificates/${FOREIGN}/validate`, /empty segment/],
    [`/api/v1/certificates//${FOREIGN}/validate`, /empty segment/],
    [`/api/v1/x/..;/certificates/${FOREIGN}/validate`, /semicolon/],
    [`/api/v1/certificates/${FOREIGN}/x/..;/validate`, /semicolon/],
    ['/api/v1/approvals;x', /semicolon/],
    ['/api/v1//approvals', /empty segment/],
    // empty segments, /api spellings and semicolons anywhere in the path
    [`/api/v1/certificates/${FOREIGN}//validate`, /empty segment/],
    ['/api/v2//oauth2/providers/x/login', /empty segment/],
    [`/API/v1/certificates/${FOREIGN}/validate`, /spelling of \/api/],
    ['/Api/v1/approvals', /spelling of \/api/],
    ['/apiv1/approvals', /spelling of \/api/],
    [`/api/v1/tokens//${FOREIGN}`, /empty segment/],
    [`/api/v1/secrets/${FOREIGN}//content`, /empty segment/],
    [`/api/..;/api/v1/certificates/${FOREIGN}/validate`, /semicolon/],
    [`/;x/api/v1/certificates/${FOREIGN}/validate`, /semicolon/],
    [`/foo/..;/api/v1/certificates/${FOREIGN}/validate`, /semicolon/],
    [`/api;x/v1/certificates/${FOREIGN}/validate`, /semicolon/],
    [`/api/v1/certificates/${FOREIGN}/validate;a=b`, /semicolon/],
    // encoded separators and dots, any case; plain dot segments; backslashes
    [`/api/v1/certificates%2F${FOREIGN}%2Fvalidate`, /encoded slash, backslash or dot/],
    [`/api/v1/certificates/${FOREIGN}%2fvalidate`, /encoded slash, backslash or dot/],
    [`/api/v1/certificates/${FOREIGN}/%2e/validate`, /encoded slash, backslash or dot/],
    [`/api/v1/certificates/${FOREIGN}/%2E%2E/${FOREIGN}/validate`, /encoded slash, backslash or dot/],
    [`/api/v1/certificates/${FOREIGN}%5cvalidate`, /encoded slash, backslash or dot/],
    [`/api/v1/certificates/${FOREIGN}/./validate`, /dot segment/],
    [`/api/v1/certificates/${FOREIGN}/x/../validate`, /dot segment/],
    [`/api/v1/certificates/${FOREIGN}\\validate`, /backslash/],
    // a path the URL parser re-encodes
    ['/api/v1/ro"les', /would change/],
];

// read path rule: GET and assertSameOrigin refuse every non-normalised spelling; nothing is sent
test('read path rule: GET and assertSameOrigin refuse non-normalised spellings, sending nothing', async () => {
    const g = looseApi(guard());
    const wrong: string[] = [];
    for (const [url, reason] of G1_REFUSED) {
        const got = await refusal(g.get(url, { failOnStatusCode: false }));
        if (got.kind !== 'request' || !reason.test(got.reason)) wrong.push(`get ${url}: ${got.kind} ${got.reason.slice(0, 100)}`);
        try {
            assertSameOrigin(url, 'unit', { BASE_URL });
            wrong.push(`assertSameOrigin ${url}: allowed`);
        } catch (e) {
            if (!(e instanceof OwnObjectViolation) || e.kind !== 'request' || !reason.test(e.reason)) wrong.push(`assertSameOrigin ${url}: ${String(e).slice(0, 100)}`);
        }
    }
    expect(wrong).toEqual([]);
    // apiJson's raw GET goes through assertSameOrigin.
    await withProcessEnv({ BASE_URL }, async () => {
        await expect(apiJson(raw, 'GET', `/api/v1//certificates/${FOREIGN}/validate`)).rejects.toThrow(/empty segment/);
        await expect(apiJson(raw, 'GET', `/API/v1/certificates/${FOREIGN}/validate`)).rejects.toThrow(/spelling of \/api/);
    });
    expect(A.arrived, 'nothing reached the core').toEqual([]);
    expect(B.arrived).toEqual([]);
});

// read path rule, controls: plain GETs, query strings (with `;`, `//`, `%2F` in the QUERY), other escapes and own side-effect
// GETs are sent
test('read path rule controls: plain GETs, query strings, other escapes and own side-effect GETs are sent', async () => {
    const g = looseApi(guard());
    const urls = [
        `/api/v1/certificates/${FOREIGN}`, '/api/v1/raProfiles', '/api/v1/scheduler/jobs?itemsPerPage=100&pageNumber=1',
        '/api/v1/settings/events', `/api/v1/connectors/${FOREIGN}/health`, `/api/v1/certificates?x=a%2Fb;c//d&y=%2e`,
        `/api/v1/certificates/${OWN.certificates}/valid%61te`, `${A.origin}/api/v1/raProfiles`,
        // Case-sensitive like Spring: not the side-effect endpoint, the core answers 404.
        `/api/v1/Certificates/${FOREIGN}/Validate`,
    ];
    for (const u of urls) {
        expect((await refusal(g.get(u, { failOnStatusCode: false }))).kind, u).toBe('sent');
        // A raw GET is judged by the same rule; a side-effect GET (the own validate) stays for the guarded context.
        if (!u.includes('valid%61te')) expect(() => assertSameOrigin(u, 'unit', { BASE_URL }), u).not.toThrow();
    }
    expect(sentTo(A)).toEqual(urls.map((u) => `GET ${u.replace(A.origin, '')}`));
    expect(sideEffectGet(`/v1/Certificates/${FOREIGN}/Validate`), 'the table is case-sensitive').toBeUndefined();
    expect(sideEffectGet(`/v1/certificates/${FOREIGN}/validate`)?.types).toEqual(['certificates']);
    expect(B.arrived).toEqual([]);
});

// read path rule: a same-origin redirect hop is held to the same rule — a non-normalised Location is not followed (the 3xx is returned)
test('read path rule: a redirect hop follows the same rule; a non-normalised Location is not followed', async () => {
    const g = looseApi(guard());
    const hops = [
        `/api/v1//certificates/${FOREIGN}/validate`, '/API/v1/approvals', `/api/v1/x/..;/roles/${OWN.roles}`, '/api/v1/approvals;x',
        `/api/v1/certificates/${FOREIGN}%2fvalidate`, `/api/v1/x/%2e%2e/roles/${OWN.roles}`, `../roles/${OWN.roles}`, `/api/v1/roles//${OWN.roles}`,
    ];
    for (const h of hops) expect((await g.get(`/api/v1/redirect?to=${encodeURIComponent(h)}`)).status(), h).toBe(302);
    expect(A.arrived.map((a) => a.url), 'only the redirecting GETs arrived').toEqual(hops.map((h) => `/api/v1/redirect?to=${encodeURIComponent(h)}`));
    // Control: a plain same-origin Location is followed.
    A.reset();
    const ok = await g.get(`/api/v1/redirect?to=${encodeURIComponent(`/api/v1/roles/${OWN.roles}`)}`);
    expect([ok.status(), (await ok.json()).name]).toEqual([200, nameOf('roles')]);
    expect(B.arrived).toEqual([]);
});

// read path rule: the shared rule is the first part of the mutation rule (readPathProblem ⊂ structuralPathProblem)
test('read path rule: the shared rule is the first part of the mutation path rule', () => {
    const sent = (u: string) => {
        const r = resolveSentUrl(u, { env: { BASE_URL: 'http://127.0.0.1:1/' } });
        if ('problem' in r) throw new Error(r.problem);
        return r.sent;
    };
    for (const [u, why] of G1_REFUSED) expect(readPathProblem(sent(u)), u).toMatch(why);
    for (const u of [`/api/v1/roles/${U(1)}`, '/api/v1/certificates?x=a;b//c', '/api/v1/approvals/', '/administrator/', '/']) expect(readPathProblem(sent(u)), u).toBeUndefined();
});

// ------------------------------------------------------------------ resource typing

// resource typing: an id-named `approvals` line naming a pre-existing RA profile authorises nothing on an RA profile route
test('resource typing: an id-named approvals line for an RA profile authorises nothing on RA routes', async () => {
    const g = looseApi(guard());
    const forged = [
        () => g.delete(`/api/v1/authorities/${AUTH}/raProfiles/${PRE_RA}`),
        () => g.patch('/api/v1/raProfiles/disable', { data: [PRE_RA] }),
        () => g.put(`/api/v1/raProfiles/${PRE_RA}`, { data: { name: 'renamed-by-the-run' } }),
    ];
    for (const f of forged) {
        const got = await refusal(f());
        expect(got.kind).toBe('ownership');
        expect(got.reason).toMatch(/the ledger records it as approvals, but the request acts on raProfiles/);
    }
    expect(A.arrived, 'refused before any read or write').toEqual([]);
    // The same three requests on the run's own RA profile (a real `raProfiles` line): sent.
    const RA = OWN.raProfiles;
    await g.delete(`/api/v1/authorities/${AUTH}/raProfiles/${RA}`);
    await g.patch('/api/v1/raProfiles/disable', { data: [RA] });
    await g.put(`/api/v1/raProfiles/${RA}`, { data: { name: `${RUN}-renamed` } });
    expect(A.mutations().map((a) => `${a.method} ${a.url} ${a.body}`)).toEqual([
        `DELETE /api/v1/authorities/${AUTH}/raProfiles/${RA} `,
        `PATCH /api/v1/raProfiles/disable ${JSON.stringify([RA])}`,
        `PUT /api/v1/raProfiles/${RA} ${JSON.stringify({ name: `${RUN}-renamed` })}`,
    ]);
    expect(B.arrived).toEqual([]);
});

// resource typing: every ledger type, live-checked or id-named, counts only for its own resource — before any live read
test('resource typing: every ledger type counts only for its own resource, before any live read', async () => {
    const g = looseApi(guard());
    const wrong: string[] = [];
    for (const t of TYPES.filter((x) => x !== 'raProfiles')) {
        for (const f of [() => g.delete(`/api/v1/raProfiles/${OWN[t]}`), () => g.patch('/api/v1/raProfiles/enable', { data: [OWN[t]] })]) {
            const got = await refusal(f());
            if (got.kind !== 'ownership' || !got.reason.includes(`records it as ${t}, but the request acts on raProfiles`)) wrong.push(`${t}: ${got.kind} ${got.reason.slice(0, 90)}`);
        }
    }
    expect(wrong).toEqual([]);
    expect(A.arrived, 'no live read, no write').toEqual([]);
    // Matching types are sent: id-named ones on their own routes too.
    await g.patch(`/api/v1/approvals/${OWN.approvals}/approve`, { data: {} });
    await g.patch(`/api/v1/acmeProfiles/${U(77)}/acmeAccounts/${OWN.acmeAccounts}/disable`);
    await g.patch('/api/v1/acmeAccounts/disable', { data: [OWN.acmeAccounts] });
    await g.patch(`/api/v1/authorities/${AUTH}/raProfiles/${OWN.raProfiles}/protocols/acme/activate/${OWN.acmeProfiles}`, { data: {} });
    await g.put(`/api/v1/users/${OWN.users}/roles/${OWN.roles}`);
    await g.delete(`/api/v1/tokens/${TOKEN}/tokenProfiles/${OWN.tokenProfiles}`);
    await g.patch(`/api/v1/attributes/custom/resources/raProfiles/objects/${OWN.raProfiles}/${OWN.customAttributes}`, { data: [] });
    expect(A.mutations()).toHaveLength(7);
    // A body association may name any own object (no type), a target may not be two resources at once.
    await g.patch(`/api/v1/roles/${OWN.roles}/users`, { data: [OWN.users] });
    expect(A.mutations()).toHaveLength(8);
    const twice = await refusal(g.put(`/api/v1/users/${OWN.users}/roles/${OWN.users}`));
    expect([twice.kind, twice.reason]).toEqual(['request', 'one uuid named as two different resources in one request']);
    expect(B.arrived).toEqual([]);
});

// resource typing: an unresolvable target or bulk route is refused for an own uuid, sent for a probe (it names no object);
// side-effect GETs too
test('resource typing: unresolvable target or bulk route is refused for an own uuid, sent for a probe', async () => {
    const g = looseApi(guard());
    const RA = OWN.raProfiles;
    const unresolved = [
        () => g.delete(`/api/v1/signingProfiles/${RA}`), () => g.put(`/api/v1/tspProfiles/${RA}`, { data: {} }), () => g.delete(`/api/v1/notifications/${RA}`),
        () => g.delete(`/api/v1/comments/${RA}`),
        () => g.put(`/api/v2/complianceProfiles/rules/${RA}`, { data: {} }), () => g.post(`/api/v1/roles/${OWN.roles}/permissions/${RA}/objects`, { data: [] }),
        () => g.delete('/api/v1/signingRecords', { data: [RA] }),
        () => g.get(`/api/v1/proxies/${RA}/instructions`),
    ];
    for (const f of unresolved) {
        const got = await refusal(f());
        expect(got.kind).toBe('request');
        expect(got.reason).toMatch(/on a resource the suite has no ledger type for/);
    }
    expect(A.arrived).toEqual([]);
    // Key items are typed `keyItems` — an own RA profile there is a type mismatch, not "no type".
    for (const f of [() => g.patch(`/api/v1/keys/${OWN.keys}/items/${RA}`, { data: {} }), () => g.patch('/api/v1/keys/items/disable', { data: [RA] })]) {
        const got = await refusal(f());
        expect([got.kind, got.reason]).toEqual(['ownership', expect.stringMatching(/records it as raProfiles, but the (request acts on|list body of .* names) keyItems/)]);
    }
    expect(A.mutations(), 'the own key may have been read live; nothing was sent').toEqual([]);
    A.reset();
    const p = g.probeUuid();
    await g.delete(`/api/v1/signingProfiles/${p}`);
    await g.patch('/api/v1/keys/items/disable', { data: [p] });
    await g.get(`/api/v1/proxies/${p}/instructions`, { failOnStatusCode: false });
    expect(sentTo(A)).toEqual([`DELETE /api/v1/signingProfiles/${p}`, 'PATCH /api/v1/keys/items/disable', `GET /api/v1/proxies/${p}/instructions`]);
    // A side-effect GET checks the type as well: an own role is no certificate.
    A.reset();
    const got = await refusal(g.get(`/api/v1/certificates/${OWN.roles}/validate`));
    expect([got.kind, got.reason]).toEqual(['ownership', 'the ledger records it as roles, but the request acts on certificates (an ownership claim counts only for the resource the request acts on)']);
    await g.get(`/api/v1/certificates/${OWN.certificates}/validate`, { failOnStatusCode: false });
    await g.get(`/api/v1/approvals/${OWN.approvals}`, { failOnStatusCode: false });
    expect(sentTo(A)).toEqual([`GET /api/v1/certificates/${OWN.certificates}/validate`, `GET /api/v1/approvals/${OWN.approvals}`]);
    expect(B.arrived).toEqual([]);
});

test('resource typing: the route → ledger type resolver over the core routes with uuid path variables', () => {
    const LEDGER_TYPES = new Set(TYPES);
    for (const v of [...Object.values(TARGET_TYPES), ...Object.values(RESOURCE_TYPES)]) expect(LEDGER_TYPES.has(v), v).toBe(true);
    for (const r of BULK_ROUTES) if (r.type !== undefined) expect(LEDGER_TYPES.has(r.type), r.path).toBe(true);
    const a = U(1);
    const b = U(2);
    const c = U(3);
    const p = U(4);
    const q = U(5);
    const rows: Array<[string, Array<string | undefined>]> = [
        [`/v1/raProfiles/${a}`, ['raProfiles']], [`/v1/authorities/${p}/raProfiles/${a}/enable`, ['raProfiles']], [`/v1/authorities/${a}`, ['authorities']],
        [`/v1/authorities/${p}/raProfiles/${a}/protocols/acme/activate/${b}`, ['raProfiles', 'acmeProfiles']],
        [`/v1/authorities/${p}/raProfiles/${a}/protocols/scep/activate/${b}`, ['raProfiles', 'scepProfiles']],
        [`/v1/authorities/${p}/raProfiles/${a}/protocols/cmp/activate/${b}`, ['raProfiles', 'cmpProfiles']],
        [`/v1/authorities/${p}/raProfiles/${a}/approvalProfiles/${b}`, ['raProfiles', 'approvalProfiles']],
        [`/v1/approvals/${a}/reject`, ['approvals']], [`/v1/acmeProfiles/${p}/acmeAccounts/${a}/enable`, ['acmeAccounts']],
        [`/v1/acmeProfiles/${a}/raprofile/${b}`, ['acmeProfiles', 'raProfiles']], [`/v1/cmpProfiles/${a}/raProfiles/${b}`, ['cmpProfiles', 'raProfiles']],
        [`/v1/scepProfiles/${a}/raProfiles/${b}`, ['scepProfiles', 'raProfiles']], [`/v1/scheduler/jobs/${a}/enable`, ['scheduledJobs']],
        [`/v1/attributes/custom/${a}/disable`, ['customAttributes']],
        [`/v1/attributes/custom/resources/raProfiles/objects/${a}/${b}`, ['raProfiles', 'customAttributes']],
        [`/v1/attributes/custom/resources/keyItems/objects/${a}/${b}`, [undefined, 'customAttributes']],
        [`/v1/approvalProfiles/${a}/associations/raProfiles/${b}`, ['approvalProfiles', 'raProfiles']],
        [`/v2/complianceProfiles/${a}/associations/vaults/${b}`, ['complianceProfiles', 'vaultInstances']],
        [`/v1/comments/certificates/${a}`, ['certificates']], [`/v1/comments/${a}/resolve`, [undefined]], [`/v2/compliance/raProfiles/${a}`, ['raProfiles']],
        // A Resource code that is no collection word of TARGET_TYPES: only the Resource context resolves it.
        [`/v1/approvalProfiles/${a}/associations/triggers/${b}`, ['approvalProfiles', 'triggers']], [`/v1/comments/rules/${a}`, ['rules']],
        [`/v2/compliance/jobs/${a}`, ['scheduledJobs']], [`/v1/approvalProfiles/${a}/associations/keyItems/${b}`, ['approvalProfiles', undefined]],
        [`/v2/complianceProfiles/rules/${a}`, [undefined]], [`/v2/complianceProfiles/${a}/groups`, ['complianceProfiles']],
        [`/v1/workflows/triggers/${a}`, ['triggers']], [`/v1/workflows/rules/${a}`, ['rules']], [`/v1/workflows/conditions/${a}`, ['conditions']],
        [`/v1/workflows/actions/${a}`, ['actions']], [`/v1/workflows/executions/${a}`, ['executions']],
        [`/v1/certificates/${a}/relations/${b}`, ['certificates', 'certificates']], [`/v1/secrets/${a}/syncVaultProfiles/${b}`, ['secrets', 'vaultProfiles']],
        [`/v1/vaults/${a}`, ['vaultInstances']], [`/v1/vaults/${p}/vaultProfiles/${a}/disable`, ['vaultProfiles']],
        [`/v1/entities/${p}/locations/${a}/certificates/${b}`, ['locations', 'certificates']], [`/v1/entities/${a}`, ['entities']],
        [`/v1/tokens/${p}/keys/${a}/compromise`, ['keys']], [`/v1/tokens/${p}/tokenProfiles/${a}/usages`, ['tokenProfiles']], [`/v1/tokens/${a}/activate`, ['tokens']],
        [`/v1/keys/${a}/items/${b}`, ['keys', 'keyItems']], [`/v1/operations/tokens/${p}/tokenProfiles/${a}/keys/${b}/items/${c}/sign`, ['tokenProfiles', 'keys', 'keyItems']],
        [`/v2/operations/authorities/${p}/raProfiles/${q}/certificates/${a}/revoke`, ['certificates']], [`/v1/users/${a}/roles/${b}`, ['users', 'roles']],
        [`/v1/roles/${a}/permissions/${b}/objects/${c}`, ['roles', undefined, undefined]], [`/v1/raProfiles/${a}/callback`, ['raProfiles']],
        [`/v2/connectors/${a}/reconnect`, ['connectors']], [`/v1/connectors/${a}`, ['connectors']], [`/v1/credentials/${a}/enable`, ['credentials']],
        [`/v1/groups/${a}`, ['groups']], [`/v1/discoveries/${a}/stop`, ['discoveries']], [`/v1/keys/${a}/destroy`, ['keys']],
        [`/v1/notificationProfiles/${a}`, ['notificationProfiles']], [`/v1/notificationInstances/${a}`, ['notificationInstances']],
        [`/v1/roles/${a}`, ['roles']], [`/v1/secrets/${a}/enable`, ['secrets']], [`/v1/complianceProfiles/${a}/rules`, ['complianceProfiles']],
        [`/v1/tspProfiles/${a}/basicCredentials/${b}`, [undefined, undefined]], [`/v1/signingProfiles/${a}`, [undefined]], [`/v1/signingRecords/${a}`, [undefined]],
        [`/v1/notifications/${a}`, [undefined]], [`/v1/proxies/${a}`, [undefined]], [`/v1/trustedCertificates/${a}`, [undefined]], [`/v1/cboms/${a}`, [undefined]],
        [`/v1/timeQualityConfigurations/${a}`, [undefined]], [`/v1/attributes/metadata/${a}`, [undefined]],
    ];
    for (const [path, types] of rows) expect(pathTargets(path).map((t) => t.type), path).toEqual(types);
    expect(resourceTypeAt(['v1', 'raProfiles', a], 2)).toBe('raProfiles');
    // The side-effect GET table: each object's type, read from its template (proxies: none, so refused unless a probe).
    expect(SIDE_EFFECT_GETS.map((t) => sideEffectGet(t.replace(/\{(id|parent)\}/g, a).replace('{seg}', 'pem'))?.types)).toEqual([
        ['certificates'], ['certificates'], ['certificates'], ['raProfiles'], ['acmeAccounts'], ['secrets'], ['tokens'], [], [], ['approvals'], [], [], [undefined],
    ]);
});

// ------------------------------------------------------------------ base64 forms

/** The uuid-typed request DTO fields of `interfaces` 2b7962c7 (b0fix6/uuidfields.py): a missing one fails here. */
const KNOWN_UUID_FIELDS = [
    'attributeDefinitionUuids', 'eabSecretUuids', // hidden by `List<@NotNull …>` from a plain field derivation
    'altKeyUuid', 'altTokenProfileUuid', 'connectorUuid', 'defaultSigningProfileUuid', 'groupUuid', 'groupUuids', 'groups', 'interfaceUuid',
    'internalRules', 'keyUuid', 'mappedUserUuid', 'notificationInstanceUuid', 'objectUuid', 'ownerUuid', 'parentUuid', 'raProfileUuid',
    'recipientUuids', 'roleUuid', 'ruleUuid', 'sourceCertificateUuid', 'sourceVaultProfileUuid', 'tokenProfileUuid', 'triggerUuids', 'triggers',
    'userUuid', 'uuid', 'uuids', 'vaultProfileUuid',
];

// base64 forms: UUID_TYPED_FIELDS holds every uuid-typed request DTO field derived from interfaces (triggers, internalRules,
// groups among them)
test('safety list: UUID_TYPED_FIELDS holds every uuid-typed request DTO field derived from interfaces', () => {
    const missing = KNOWN_UUID_FIELDS.filter((f) => !UUID_TYPED_FIELDS.has(f));
    expect(missing).toEqual([]);
    for (const f of KNOWN_UUID_FIELDS) expect(isUuidField(f), f).toBe(true);
    expect(KNOWN_UUID_FIELDS.filter((f) => !UUID_FIELD_NAME.test(f))).toEqual(['groups', 'internalRules', 'triggers']);
    for (const f of ['name', 'reason', 'event', 'description', 'usage']) expect(isUuidField(f), f).toBe(false);
});

// base64 forms: the base64 forms under triggers / internalRules / providerRules[].groups are refused; enum values and names pass
test('base64 forms of uuid fields under triggers and rules are refused; enums and names pass', async () => {
    const g = looseApi(guard());
    const CP = OWN.complianceProfiles;
    const probe = g.probeUuid();
    const rows: Array<[string, () => Promise<unknown>]> = [];
    for (const [form, v] of [['24 (`==`)', b64(FOREIGN)], ['24 URL-safe', url24(FOREIGN)], ['22', b22(FOREIGN)], ['22 URL-safe', url22(FOREIGN)]] as const) {
        rows.push([`POST discoveries triggers ${form}`, () => g.post('/api/v1/discoveries', { data: { name: `${RUN}-d`, triggers: [v] } })]);
        rows.push([`PUT v2 complianceProfiles internalRules ${form}`, () => g.put(`/api/v2/complianceProfiles/${CP}`, { data: { internalRules: [v] } })]);
        rows.push([`PUT v2 complianceProfiles providerRules[].groups ${form}`,
            () => g.put(`/api/v2/complianceProfiles/${CP}`, { data: { providerRules: [{ connectorUuid: probe, groups: [v] }] } })]);
    }
    // The 24-character form under ANY key, a map key, and a query value; the 22-character form under every uuid-typed field.
    rows.push(['24 under description', () => g.put(`/api/v1/roles/${OWN.roles}`, { data: { description: b64(FOREIGN) } })]);
    rows.push(['24 as a map key', () => g.put(`/api/v1/roles/${OWN.roles}`, { data: { customMap: { [b64(FOREIGN)]: 1 } } })]);
    rows.push(['24 in a query value', () => g.patch(`/api/v1/roles/${OWN.roles}/users?x=${url24(FOREIGN)}`, { data: [OWN.users] })]);
    for (const f of KNOWN_UUID_FIELDS) rows.push([`22 under ${f}`, () => g.put(`/api/v1/roles/${OWN.roles}`, { data: { [f]: url22(FOREIGN) } })]);
    const wrong: string[] = [];
    for (const [name, call] of rows) {
        const got = await refusal(call());
        if (got.kind !== 'request' || !/a non-canonical uuid form in the body or query/.test(got.reason)) wrong.push(`${name}: ${got.kind} ${got.reason.slice(0, 80)}`);
    }
    expect(wrong).toEqual([]);
    expect(A.mutations(), 'nothing refused reached the core').toEqual([]);
    // Controls: enum values and names of 22 characters (non-uuid keys), an empty / own trigger list, `==` values of other lengths.
    await g.put(`/api/v1/roles/${OWN.roles}`, { data: { reason: 'CESSATION_OF_OPERATION', name: 'abcdefghijklmnopqrstuv', note: 'abc==' } });
    await g.post('/api/v1/discoveries', { data: { name: `${RUN}-d`, triggers: [] } });
    await g.post('/api/v1/discoveries', { data: { name: `${RUN}-d2`, triggers: [OWN.triggers] } });
    await g.put(`/api/v2/complianceProfiles/${CP}`, { data: { internalRules: [], providerRules: [{ connectorUuid: probe, groups: [] }] } });
    await g.patch(`/api/v1/roles/${OWN.roles}/users?reason=CESSATION_OF_OPERATION`, { data: [OWN.users] });
    expect(A.mutations()).toHaveLength(5);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ nit: table-driven BULK_ROUTES and PLATFORM_DENY

/** `METHOD path list type` — the whole BULK_ROUTES table (63 routes); deleting or retyping an entry fails below. */
const EXPECTED_BULK = `
PATCH /v1/acmeAccounts/disable array acmeAccounts | PATCH /v1/acmeAccounts/enable array acmeAccounts | PUT /v1/acmeAccounts/revoke array acmeAccounts
DELETE /v1/acmeProfiles/delete array acmeProfiles | DELETE /v1/acmeProfiles/delete/force array acmeProfiles
PATCH /v1/acmeProfiles/disable array acmeProfiles | PATCH /v1/acmeProfiles/enable array acmeProfiles
DELETE /v1/attributes/custom array customAttributes | PATCH /v1/attributes/custom/disable array customAttributes
PATCH /v1/attributes/custom/enable array customAttributes | DELETE /v1/authorities array authorities | DELETE /v1/authorities/force array authorities
PATCH /v1/certificates certificateUuids certificates | PATCH /v1/certificates/archive array certificates
PATCH /v1/certificates/unarchive array certificates | POST /v1/certificates/delete uuids certificates
DELETE /v1/cmpProfiles/delete array cmpProfiles | DELETE /v1/cmpProfiles/delete/force array cmpProfiles
PATCH /v1/cmpProfiles/disable array cmpProfiles | PATCH /v1/cmpProfiles/enable array cmpProfiles
DELETE /v1/complianceProfiles array complianceProfiles | DELETE /v1/complianceProfiles/force array complianceProfiles
DELETE /v2/complianceProfiles array complianceProfiles | DELETE /v2/complianceProfiles/force array complianceProfiles
DELETE /v1/connectors array connectors | DELETE /v1/connectors/force array connectors | DELETE /v2/connectors array connectors
POST /v2/connectors/forceDelete array connectors | DELETE /v1/credentials array credentials | DELETE /v1/discoveries array discoveries
DELETE /v1/groups array groups | DELETE /v1/keys array keys | PATCH /v1/keys/destroy array keys | PATCH /v1/keys/disable array keys
PATCH /v1/keys/enable array keys | PATCH /v1/keys/compromise uuids keys | PUT /v1/keys/usages uuids keys
DELETE /v1/keys/items array keyItems | PATCH /v1/keys/items/destroy array keyItems | PATCH /v1/keys/items/disable array keyItems | PATCH /v1/keys/items/enable array keyItems
PATCH /v1/keys/items/compromise uuids keyItems | PUT /v1/keys/items/usages uuids keyItems | DELETE /v1/notifications array -
DELETE /v1/raProfiles array raProfiles | PATCH /v1/raProfiles/disable array raProfiles | PATCH /v1/raProfiles/enable array raProfiles
DELETE /v1/scepProfiles/delete array scepProfiles | DELETE /v1/scepProfiles/delete/force array scepProfiles
PATCH /v1/scepProfiles/disable array scepProfiles | PATCH /v1/scepProfiles/enable array scepProfiles
DELETE /v1/signingProfiles array - | PATCH /v1/signingProfiles/disable array - | PATCH /v1/signingProfiles/enable array -
DELETE /v1/signingRecords array - | DELETE /v1/tokenProfiles array tokenProfiles | PATCH /v1/tokenProfiles/disable array tokenProfiles
PATCH /v1/tokenProfiles/enable array tokenProfiles | DELETE /v1/tokens/delete array tokens | PUT /v1/tokens/usages uuids tokenProfiles
DELETE /v1/tspProfiles array - | PATCH /v1/tspProfiles/disable array - | PATCH /v1/tspProfiles/enable array -
`.split(/[|\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const [method, path, list, type] = s.split(' ');
    return { method, path, list, type: type === '-' ? undefined : type };
});

// BULK_ROUTES, row by row: each route is listed with its list and ledger type; an own uuid of that type is sent, another type
// or an untyped route refused
test('safety list: BULK_ROUTES with list and ledger type; wrong type or untyped route refused', async () => {
    expect(EXPECTED_BULK).toHaveLength(63);
    expect(BULK_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(EXPECTED_BULK.map((r) => `${r.method} ${r.path}`).sort());
    const g = looseApi(guard());
    const wrong: string[] = [];
    for (const e of EXPECTED_BULK) {
        const r = bulkRoute(e.method, e.path);
        if (!r || r.list !== e.list || r.type !== e.type) {
            wrong.push(`${e.method} ${e.path}: ${r ? `list ${r.list} type ${r.type}` : 'missing'}`);
            continue;
        }
        const body = (u: string) => (e.list === 'array' ? [u] : { [e.list]: [u] });
        const send = (u: string) => g.fetch(`/api${e.path}`, { method: e.method, data: body(u) });
        A.reset();
        if (e.type) {
            const ok = await refusal(send(OWN[e.type]));
            const arrived = A.mutations().map((a) => `${a.method} ${a.url} ${a.body}`);
            if (ok.kind !== 'sent' || arrived.join() !== `${e.method} /api${e.path} ${JSON.stringify(body(OWN[e.type]))}`) wrong.push(`${e.method} ${e.path} own ${e.type}: ${ok.kind} ${ok.reason.slice(0, 80)}`);
            const other = await refusal(send(OWN.roles));
            if (other.kind !== 'ownership' || !other.reason.includes(`records it as roles, but the request acts on ${e.type}`)) wrong.push(`${e.method} ${e.path} roles: ${other.kind}`);
        } else {
            const own = await refusal(send(OWN.raProfiles));
            if (own.kind !== 'request' || !/no ledger type/.test(own.reason)) wrong.push(`${e.method} ${e.path} untyped: ${own.kind} ${own.reason.slice(0, 80)}`);
            const probe = await refusal(send(g.probeUuid()));
            if (probe.kind !== 'sent') wrong.push(`${e.method} ${e.path} probe: ${probe.kind} ${probe.reason.slice(0, 80)}`);
        }
    }
    expect(wrong).toEqual([]);
    // A route off the table is no bulk route.
    expect((await refusal(g.delete('/api/v1/roles', { data: [OWN.roles] }))).reason).toMatch(/neither an allow-listed create \(POST_CREATE\) nor an allow-listed bulk route/);
    expect(B.arrived).toEqual([]);
});

/** One example per PLATFORM_DENY entry, in table order, with the reason the entry gives. */
const EXPECTED_DENY: Array<[string, string, unknown, string]> = [
    ['PUT', '/v1/settings/platform', {}, 'platform settings'],
    ['PATCH', `/v1/scheduler/jobs/${U(1)}/enable`, undefined, 'scheduled jobs of the platform'],
    ['PUT', '/v1/auth/profile', {}, 'the profile of the logged-in (pre-existing) user'],
    ['POST', '/v1/workflows/events', { triggerUuids: [] }, 'a platform-level event trigger association (no canonical objectUuid: it fires for every object)'],
    ['DELETE', `/v1/trustedCertificates/${U(1)}`, undefined, 'the platform\'s trusted certificates'],
    ['PUT', `/v1/proxies/${U(1)}`, {}, 'connector proxies'],
    ['PUT', `/v1/timeQualityConfigurations/${U(1)}`, {}, 'time-quality configurations'],
    ['PUT', `/v1/attributes/metadata/${U(1)}`, {}, 'global metadata definitions'],
    ['POST', '/v1/cboms/upload', {}, 'the CBOM repository (upload, delete, sync)'],
    ['PUT', `/v1/connectors/${U(1)}/approve`, undefined, 'connector approve / reconnect / connect'],
    ['POST', '/v1/connector/register', {}, 'connector registration'],
    ['PUT', '/v1/branding', {}, 'platform branding'],
    ['POST', '/v1/local/admins', {}, 'local administrator management'],
    ['POST', '/v1/auditLogs/purge', {}, 'the platform audit log (purge)'],
    ['PUT', '/v1/oids/1.2.3', {}, 'the platform OID registry'],
    ['POST', '/v1/discoveries/schedule', {}, 'a scheduled (platform-level) discovery job'],
    ['POST', '/v1/operations/Some-RA/certificate/revoke', {}, 'the legacy name-keyed client API (/v1/operations/{raProfileName}/…)'],
];

// PLATFORM_DENY, entry by entry: each example is denied by its own entry, and the guard refuses it with that reason
test('safety list: each PLATFORM_DENY example is denied by its own entry and refused with that reason', async () => {
    expect(PLATFORM_DENY.map((d) => d.why)).toEqual(EXPECTED_DENY.map(([, , , why]) => why));
    const g = looseApi(guard());
    const wrong: string[] = [];
    for (const [i, [method, path, body, why]] of EXPECTED_DENY.entries()) {
        if (!PLATFORM_DENY[i].path.test(path)) wrong.push(`entry ${i} does not match ${path}`);
        if (platformDenied(path, body) !== why) wrong.push(`${path}: ${platformDenied(path, body)}`);
        const got = await refusal(g.fetch(`/api${path}`, { method, data: body }));
        if (got.kind !== 'request' || !got.reason.startsWith(`${why} is platform-level`)) wrong.push(`${method} ${path}: ${got.kind} ${got.reason.slice(0, 80)}`);
    }
    expect(wrong).toEqual([]);
    expect(A.arrived).toEqual([]);
});

// ------------------------------------------------------------------ typed body fields

/** Every uuid-bearing request DTO field name of `interfaces` 2b7962c7 (45 fields): each must be classified. */
const UUID_BEARING_FIELDS = [
    'attributeDefinitionUuids', 'eabSecretUuids',
    'actionsUuids', 'altKeyUuid', 'altTokenProfileUuid', 'attributeUuid', 'authorityInstanceUuid', 'caCertificateUuid', 'certificateUuid',
    'certificateUuids', 'conditionsUuids', 'connectorUuid', 'customAttributeUuid', 'defaultSigningProfileUuid', 'executionsUuids', 'groupUuid',
    'groupUuids', 'groups', 'interfaceUuid', 'internalRules', 'keyUuid', 'mappedUserUuid', 'mappingAttributeUuid', 'notificationInstanceUuid',
    'notificationProfileUuid', 'objectUuid', 'ownerUuid', 'parentUuid', 'proxyUuid', 'raProfileUuid', 'raProfileUuids', 'recipientUuids', 'roleUuid',
    'ruleUuid', 'rulesUuids', 'signingCertificateUuid', 'sourceCertificateUuid', 'sourceVaultProfileUuid', 'tokenProfileUuid', 'triggerUuids',
    'triggers', 'userUuid', 'uuid', 'uuids', 'vaultProfileUuid',
];

// typed body fields: every uuid-bearing request DTO field is typed (BODY_FIELD_TYPES), sibling-typed or listed as unmapped — exactly one
test('safety list: every uuid-bearing request DTO field is typed in BODY_FIELD_TYPES or unmapped', () => {
    const typed = Object.keys(BODY_FIELD_TYPES);
    const sibling = Object.keys(SIBLING_TYPED_FIELDS);
    const unmapped = Object.keys(UNMAPPED_UUID_FIELDS);
    expect(UUID_BEARING_FIELDS).toHaveLength(45);
    expect([...typed, ...sibling, ...unmapped].sort()).toEqual([...UUID_BEARING_FIELDS].sort());
    expect(new Set([...typed, ...sibling, ...unmapped]).size, 'no name in two classes').toBe(typed.length + sibling.length + unmapped.length);
    expect(sibling).toEqual(['objectUuid']);
    for (const f of unmapped) expect(UNMAPPED_UUID_FIELDS[f].length, `${f} has a reason`).toBeGreaterThan(20);
    expect(UNMAPPED_UUID_FIELDS.uuid).toMatch(/objects\[\]\.uuid/);
    const LEDGER_TYPES = new Set(TYPES);
    for (const [f, t] of Object.entries(BODY_FIELD_TYPES)) if (t !== null) expect(LEDGER_TYPES.has(t), f).toBe(true);
    expect(Object.entries(BODY_FIELD_TYPES).filter(([, t]) => t === null).map(([f]) => f).sort())
        .toEqual(['defaultSigningProfileUuid', 'groups', 'internalRules', 'parentUuid', 'proxyUuid', 'ruleUuid']);
    expect(BODY_FIELD_TYPES.groupUuids).toBe('groups');
});

// typed body fields: an own uuid recorded as `approvals` under groupUuids is refused (ownership); recorded as `groups` it is sent
test('typed body fields: an own uuid recorded as approvals under groupUuids is refused', async () => {
    const asApproval = looseApi(guardApiWithSeams(raw, { lines: linesAsApproval, runId: RUN, tier: null, env: { BASE_URL } }));
    const asGroup = looseApi(guardApiWithSeams(raw, { lines: linesAsGroup, runId: RUN, tier: null, env: { BASE_URL } }));
    const CERT = OWN.certificates;
    for (const call of [
        () => asApproval.put(`/api/v1/certificates/${CERT}`, { data: { groupUuids: [X] } }),
        () => asApproval.patch('/api/v1/certificates', { data: { certificateUuids: [CERT], groupUuids: [X] } }),
        () => asApproval.put(`/api/v1/certificates/${CERT}`, { data: JSON.stringify({ groupUuids: [X] }) }),
    ]) {
        const got = await refusal(call());
        expect([got.kind, got.reason]).toEqual(['ownership',
            'the ledger records it as approvals, but the body field groupUuids names groups (an ownership claim counts only for the resource the request acts on)']);
    }
    expect(A.mutations(), 'nothing refused reached the core').toEqual([]);
    expect(A.arrived.map((a) => `${a.method} ${a.url}`), 'at most the live read of the own certificate named before X in the bulk body')
        .toEqual([`GET /api/v1/certificates/${CERT}`]);
    A.reset();
    await asGroup.put(`/api/v1/certificates/${CERT}`, { data: { groupUuids: [X] } });
    await asGroup.patch('/api/v1/certificates', { data: { certificateUuids: [CERT], groupUuids: [X] } });
    expect(A.mutations().map((a) => `${a.method} ${a.url} ${a.body}`)).toEqual([
        `PUT /api/v1/certificates/${CERT} ${JSON.stringify({ groupUuids: [X] })}`,
        `PATCH /api/v1/certificates ${JSON.stringify({ certificateUuids: [CERT], groupUuids: [X] })}`,
    ]);
    expect(B.arrived).toEqual([]);
});

// typed body fields: typed fields everywhere in the body; no-ledger-type fields take probes; the reference waiver and unmapped
// fields are unchanged
test('typed body fields apply everywhere in the body; no-ledger-type fields take probes; waiver unchanged', async () => {
    const g = looseApi(guard());
    const p = g.probeUuid();
    const CP = OWN.complianceProfiles;
    const refused: Array<[string, () => Promise<unknown>, RefusalKind, RegExp]> = [
        ['ownerUuid: a role', () => g.put(`/api/v1/certificates/${OWN.certificates}`, { data: { ownerUuid: OWN.roles } }), 'ownership', /records it as roles, but the body field ownerUuid names users/],
        ['nested connectorUuid: a role', () => g.put(`/api/v2/complianceProfiles/${CP}`, { data: { providerRules: [{ connectorUuid: OWN.roles }] } }), 'ownership', /body field connectorUuid names connectors/],
        ['triggers: a rule', () => g.post('/api/v1/discoveries', { data: { name: `${RUN}-d`, triggers: [OWN.rules] } }), 'ownership', /body field triggers names triggers/],
        ['rulesUuids on a create: a condition', () => g.post('/api/v1/workflows/triggers', { data: { name: `${RUN}-t`, rulesUuids: [OWN.conditions] } }), 'ownership', /body field rulesUuids names rules/],
        ['raProfileUuid on a DELETE (no waiver): an approval', () => g.delete(`/api/v1/acmeProfiles/${OWN.acmeProfiles}`, { data: { raProfileUuid: OWN.approvals } }), 'ownership', /body field raProfileUuid names raProfiles/],
        ['proxyUuid: an own role', () => g.put(`/api/v1/connectors/${OWN.connectors}`, { data: { proxyUuid: OWN.roles } }), 'request', /body field proxyUuid names a resource the suite has no ledger type for/],
        ['compliance groups: an own group', () => g.put(`/api/v2/complianceProfiles/${CP}`, { data: { providerRules: [{ connectorUuid: OWN.connectors, groups: [OWN.groups] }] } }), 'request', /body field groups names a resource the suite has no ledger type for/],
        ['groupUuids naming the target user', () => g.put(`/api/v1/users/${OWN.users}`, { data: { groupUuids: [OWN.users] } }), 'request', /one uuid named as two different resources/],
        ['unmapped uuid: a foreign uuid', () => g.put(`/api/v1/roles/${OWN.roles}`, { data: { uuid: FOREIGN } }), 'ownership', /no ledger "created" line/],
    ];
    const wrong: string[] = [];
    for (const [name, call, kind, reason] of refused) {
        const got = await refusal(call());
        if (got.kind !== kind || !reason.test(got.reason)) wrong.push(`${name}: ${got.kind} ${got.reason.slice(0, 100)}`);
    }
    expect(wrong).toEqual([]);
    expect(A.mutations(), 'nothing refused reached the core').toEqual([]);
    // Sent: matching types, probes in no-ledger-type fields, the REFERENCE_FIELDS waiver, unmapped fields with any own type.
    const sent: Array<[string, string, unknown]> = [
        ['PUT', `/api/v1/certificates/${OWN.certificates}`, { ownerUuid: OWN.users, groupUuids: [OWN.groups] }],
        ['PUT', `/api/v2/complianceProfiles/${CP}`, { providerRules: [{ connectorUuid: OWN.connectors, groups: [p] }], internalRules: [p] }],
        ['POST', '/api/v1/discoveries', { name: `${RUN}-d`, triggers: [OWN.triggers], connectorUuid: FOREIGN }],
        ['PUT', `/api/v1/connectors/${OWN.connectors}`, { proxyUuid: p }],
        ['PUT', `/api/v1/acmeProfiles/${OWN.acmeProfiles}`, { raProfileUuid: FOREIGN }],
        ['PUT', `/api/v1/roles/${OWN.roles}`, { uuid: OWN.keys, recipientUuids: [OWN.groups, OWN.roles], interfaceUuid: OWN.tokens, groupUuid: OWN.approvals }],
    ];
    for (const [method, url, data] of sent) expect((await refusal(g.fetch(url, { method, data }))).kind, `${method} ${url}`).toBe('sent');
    expect(A.mutations().map((a) => `${a.method} ${a.url} ${a.body}`)).toEqual(sent.map(([m, u, d]) => `${m} ${u} ${JSON.stringify(d)}`));
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ typed lists, raw bodies and literal tables

const asLines = (l: LedgerLine[]) => looseApi(guardApiWithSeams(raw, { lines: l, runId: RUN, tier: null, env: { BASE_URL } }));
/** Another own object's uuid of a type other than `t`. */
const wrongFor = (t: string) => (t === 'roles' ? OWN.users : OWN.roles);
const wrongName = (t: string) => (t === 'roles' ? 'users' : 'roles');

test('typed lists: the uuid list bodies of PATCH /roles/{id}/users and /users/{id}/roles are typed', async () => {
    const asApproval = asLines(linesAsApproval);
    for (const [url, type] of [[`/api/v1/roles/${OWN.roles}/users`, 'users'], [`/api/v1/users/${OWN.users}/roles`, 'roles']] as const) {
        const got = await refusal(asApproval.patch(url, { data: [X] }));
        expect([got.kind, got.reason], url).toEqual(['ownership',
            `the ledger records it as approvals, but the list body of ${url.replace(/[0-9a-f-]{36}/, '{id}').replace('/api', '')} names ${type} (an ownership claim counts only for the resource the request acts on)`]);
    }
    expect(A.mutations()).toEqual([]);
    // The same X recorded as a real user / role: sent.
    await asLines(linesAsUser).patch(`/api/v1/roles/${OWN.roles}/users`, { data: [X] });
    await asLines(linesAsRole).patch(`/api/v1/users/${OWN.users}/roles`, { data: [X] });
    expect(A.mutations().map((a) => `${a.method} ${a.url} ${a.body}`)).toEqual([
        `PATCH /api/v1/roles/${OWN.roles}/users ${JSON.stringify([X])}`, `PATCH /api/v1/users/${OWN.users}/roles ${JSON.stringify([X])}`,
    ]);
    // A top-level uuid list on a route that is not in LIST_BODY_TYPES (target or create): refused; probes and empty lists are not.
    A.reset();
    const g = looseApi(guard());
    for (const call of [() => g.put(`/api/v1/roles/${OWN.roles}`, { data: [OWN.users] }), () => g.post('/api/v1/roles', { data: [OWN.users] }),
        () => g.patch(`/api/v1/certificates/${OWN.certificates}`, { data: [OWN.groups] })]) {
        const got = await refusal(call());
        expect([got.kind, got.reason]).toEqual(['request',
            'a top-level uuid list body on a route without a typed list (guard/routes.ts LIST_BODY_TYPES): the guard cannot tell which resource it names']);
    }
    await g.put(`/api/v1/roles/${OWN.roles}`, { data: [g.probeUuid()] });
    await g.patch(`/api/v1/users/${OWN.users}/roles`, { data: [] });
    expect(A.mutations()).toHaveLength(2);
    expect(B.arrived).toEqual([]);
});

/** `METHOD example-path type` — the whole LIST_BODY_TYPES table; deleting or retyping an entry fails below. */
const EXPECTED_LISTS: Array<[string, string, string | null, string]> = [
    ['PATCH', '/v1/roles/{id}/users', 'users', `/v1/roles/${OWN.roles}/users`],
    ['PATCH', '/v1/users/{id}/roles', 'roles', `/v1/users/${OWN.users}/roles`],
    ['DELETE', '/v1/keys/{id}', 'keyItems', `/v1/keys/${OWN.keys}`],
    ['PATCH', '/v1/keys/{id}/destroy', 'keyItems', `/v1/keys/${OWN.keys}/destroy`],
    ['PATCH', '/v1/keys/{id}/disable', 'keyItems', `/v1/keys/${OWN.keys}/disable`],
    ['PATCH', '/v1/keys/{id}/enable', 'keyItems', `/v1/keys/${OWN.keys}/enable`],
    ['DELETE', '/v1/tokens/{id}/keys/{id}', 'keyItems', `/v1/tokens/${TOKEN}/keys/${OWN.keys}`],
    ['PATCH', '/v1/tokens/{id}/keys/{id}/destroy', 'keyItems', `/v1/tokens/${TOKEN}/keys/${OWN.keys}/destroy`],
    ['PATCH', '/v1/tokens/{id}/keys/{id}/disable', 'keyItems', `/v1/tokens/${TOKEN}/keys/${OWN.keys}/disable`],
    ['PATCH', '/v1/tokens/{id}/keys/{id}/enable', 'keyItems', `/v1/tokens/${TOKEN}/keys/${OWN.keys}/enable`],
];

// typed lists: LIST_BODY_TYPES row by row — the right type sent, a wrong type refused; untyped lists take probes only
test('safety list: LIST_BODY_TYPES row by row, right type sent, wrong type refused', async () => {
    expect(LIST_BODY_TYPES.map((r) => [r.method, r.path, r.type])).toEqual(EXPECTED_LISTS.map(([m, p, t]) => [m, p, t]));
    const g = looseApi(guard());
    const wrong: string[] = [];
    for (const [method, path, type, example] of EXPECTED_LISTS) {
        if (listBodyRoute(method, example)?.type !== type) wrong.push(`${method} ${example}: not matched`);
        const send = (u: string) => refusal(g.fetch(`/api${example}`, { method, data: [u] }));
        if (type) {
            const ok = await send(OWN[type]);
            if (ok.kind !== 'sent') wrong.push(`${method} ${path} own ${type}: ${ok.kind} ${ok.reason.slice(0, 80)}`);
            // An own approval (id-named: no live read could catch it) — not the target's type, so no two-types refusal first.
            const bad = await send(OWN.approvals);
            if (bad.kind !== 'ownership' || !bad.reason.includes(`records it as approvals, but the list body of ${path} names ${type}`)) wrong.push(`${method} ${path} wrong: ${bad.kind}`);
        } else {
            const own = await send(OWN.raProfiles);
            if (own.kind !== 'request' || !own.reason.includes('no ledger type for (guard/routes.ts LIST_BODY_TYPES): probes only')) wrong.push(`${method} ${path} own: ${own.kind} ${own.reason.slice(0, 80)}`);
            if ((await send(g.probeUuid())).kind !== 'sent') wrong.push(`${method} ${path} probe not sent`);
        }
    }
    expect(wrong).toEqual([]);
    expect(B.arrived).toEqual([]);
});

test('raw bodies: a uuid in a body the server does not read as JSON may not be backed by an id-named line', async () => {
    const body = `{"name":"${RUN}-g","ownerUuid":"${X}","groupUuids":["${X}"]}`;
    const calls = (g: any) => [ // eslint-disable-line @typescript-eslint/no-explicit-any
        () => g.post('/api/v1/groups', { data: Buffer.from(`${body} junk`) }),
        () => g.post('/api/v1/groups', { data: Buffer.from(`${body}{}`) }),
        () => g.put(`/api/v1/roles/${OWN.roles}`, { data: `${body} junk`, headers: { 'content-type': 'text/plain' } }),
    ];
    for (const call of calls(asLines(linesAsApproval))) {
        const got = await refusal(call());
        expect([got.kind, got.reason]).toEqual(['ownership',
            'named in a body the server does not read as JSON, backed by an id-named ledger line (approvals: no live check, so the resource it names cannot be proven)']);
    }
    expect(A.mutations()).toEqual([]);
    // X as a live-checked own group: unchanged (free text names any LIVE-checked own object).
    for (const call of calls(asLines(linesAsGroup))) expect((await refusal(call())).kind).toBe('sent');
    expect(A.mutations()).toHaveLength(3);
    // The same body as JSON is typed (ownerUuid → users, groupUuids → groups): one uuid as two resources.
    expect((await refusal(asLines(linesAsGroup).post('/api/v1/groups', { data: JSON.parse(body) }))).reason).toBe('one uuid named as two different resources in one request');
    expect(B.arrived).toEqual([]);
});

// sibling-typed fields: objectUuid is typed by its sibling `resource` code; an unknown, missing or untyped code takes probes only
test('sibling-typed fields: objectUuid is typed by its sibling resource code; others take probes only', async () => {
    const g = looseApi(guard());
    const ev = (resource: unknown, objectUuid: string) => g.post('/api/v1/workflows/events',
        { data: { event: 'x', ...(resource === undefined ? {} : { resource }), objectUuid, triggerUuids: [OWN.triggers] } });
    expect((await refusal(ev('raProfiles', OWN.raProfiles))).kind).toBe('sent');
    expect((await refusal(ev('jobs', OWN.scheduledJobs))).kind).toBe('sent');
    const bad = await refusal(ev('raProfiles', OWN.roles));
    expect([bad.kind, bad.reason]).toEqual(['ownership', 'the ledger records it as roles, but the body field objectUuid names raProfiles (an ownership claim counts only for the resource the request acts on)']);
    for (const code of ['RAPROFILES', 'comments', 'keyItems', undefined, 12]) {
        const got = await refusal(ev(code, OWN.raProfiles));
        expect(got.kind, String(code)).toBe('request');
        expect(got.reason, String(code)).toMatch(/^the body field objectUuid names a resource the suite has no ledger type for/);
    }
    expect((await refusal(ev('comments', g.probeUuid()))).kind).toBe('sent');
    expect(A.mutations()).toHaveLength(3);
});

/** BODY_FIELD_TYPES as a literal: a deleted or retyped entry fails the rows below. */
const EXPECTED_BODY_FIELDS: Record<string, string | null> = {
    actionsUuids: 'actions', altKeyUuid: 'keys', altTokenProfileUuid: 'tokenProfiles', authorityInstanceUuid: 'authorities', caCertificateUuid: 'certificates',
    certificateUuid: 'certificates', certificateUuids: 'certificates', conditionsUuids: 'conditions', connectorUuid: 'connectors', customAttributeUuid: 'customAttributes',
    eabSecretUuids: 'secrets', executionsUuids: 'executions', groupUuids: 'groups', keyUuid: 'keys', mappedUserUuid: 'users',
    notificationInstanceUuid: 'notificationInstances', notificationProfileUuid: 'notificationProfiles', ownerUuid: 'users', raProfileUuid: 'raProfiles', raProfileUuids: 'raProfiles',
    roleUuid: 'roles', rulesUuids: 'rules', signingCertificateUuid: 'certificates', sourceCertificateUuid: 'certificates', sourceVaultProfileUuid: 'vaultProfiles',
    tokenProfileUuid: 'tokenProfiles', triggerUuids: 'triggers', triggers: 'triggers', userUuid: 'users', vaultProfileUuid: 'vaultProfiles',
    defaultSigningProfileUuid: null, groups: null, internalRules: null, ruleUuid: null, parentUuid: null,
    proxyUuid: null,
};
/** RESOURCE_TYPES as a literal. */
const EXPECTED_RESOURCES: Record<string, string> = {
    acmeAccounts: 'acmeAccounts', acmeProfiles: 'acmeProfiles', actions: 'actions', approvalProfiles: 'approvalProfiles', approvals: 'approvals', authorities: 'authorities',
    certificates: 'certificates', cmpProfiles: 'cmpProfiles', complianceProfiles: 'complianceProfiles', conditions: 'conditions', connectors: 'connectors', credentials: 'credentials',
    customAttributes: 'customAttributes', discoveries: 'discoveries', entities: 'entities', executions: 'executions', groups: 'groups', jobs: 'scheduledJobs',
    keys: 'keys', locations: 'locations', notificationInstances: 'notificationInstances', notificationProfiles: 'notificationProfiles', raProfiles: 'raProfiles',
    roles: 'roles', rules: 'rules', scepProfiles: 'scepProfiles', secrets: 'secrets', tokenProfiles: 'tokenProfiles', tokens: 'tokens',
    triggers: 'triggers', users: 'users', vaultProfiles: 'vaultProfiles', vaults: 'vaultInstances',
};

// literal tables: BODY_FIELD_TYPES value by value — the right type sent, a wrong type refused, a no-ledger-type field probes only
test('safety list: BODY_FIELD_TYPES value by value, right type sent, wrong type refused', async () => {
    const g = looseApi(guard());
    const CERT = OWN.certificates;
    const wrong: string[] = [];
    // Nested under `items` so the REFERENCE_FIELDS waiver (top-level strings) never applies.
    const send = (f: string, v: string) => refusal(g.put(`/api/v1/certificates/${CERT}`, { data: { items: [{ [f]: v }] } }));
    expect({ ...BODY_FIELD_TYPES }).toEqual(EXPECTED_BODY_FIELDS);
    for (const [f, t] of Object.entries(EXPECTED_BODY_FIELDS)) {
        if (t) {
            const ok = await send(f, OWN[t]);
            if (ok.kind !== 'sent') wrong.push(`${f} own ${t}: ${ok.kind} ${ok.reason.slice(0, 80)}`);
            const bad = await send(f, wrongFor(t));
            if (bad.kind !== 'ownership' || !bad.reason.includes(`records it as ${wrongName(t)}, but the body field ${f} names ${t}`)) wrong.push(`${f} wrong: ${bad.kind} ${bad.reason.slice(0, 80)}`);
        } else {
            const own = await send(f, OWN.roles);
            if (own.kind !== 'request' || !own.reason.includes(`the body field ${f} names a resource the suite has no ledger type for`)) wrong.push(`${f} own: ${own.kind}`);
            if ((await send(f, g.probeUuid())).kind !== 'sent') wrong.push(`${f} probe not sent`);
        }
    }
    expect(wrong).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// literal tables: RESOURCE_TYPES entry by entry on the associations, comments, compliance and custom-attribute-objects routes
test('safety list: RESOURCE_TYPES entry by entry on association, comment, compliance and attribute routes', async () => {
    const g = looseApi(guard());
    const routes: Array<(c: string, x: string) => Promise<unknown>> = [
        (c, x) => g.patch(`/api/v1/approvalProfiles/${OWN.approvalProfiles}/associations/${c}/${x}`),
        (c, x) => g.post(`/api/v1/comments/${c}/${x}`, { data: { content: 'x' } }),
        (c, x) => g.post(`/api/v2/compliance/${c}/${x}`),
        (c, x) => g.patch(`/api/v1/attributes/custom/resources/${c}/objects/${x}/${OWN.customAttributes}`, { data: [] }),
    ];
    const wrong: string[] = [];
    expect({ ...RESOURCE_TYPES }).toEqual(EXPECTED_RESOURCES);
    for (const [code, t] of Object.entries(EXPECTED_RESOURCES)) {
        for (const [i, r] of routes.entries()) {
            const ok = await refusal(r(code, OWN[t]));
            const bad = await refusal(r(code, wrongFor(t)));
            if (t === 'approvals') {
                // An approval may only be decided; every other route that names one is refused first.
                for (const [arm, got] of [['own', ok], ['wrong', bad]] as const) {
                    if (got.kind !== 'request' || !got.reason.includes('an approval may only be decided')) wrong.push(`${code} route ${i} ${arm}: ${got.kind} ${got.reason.slice(0, 80)}`);
                }
                continue;
            }
            if (ok.kind !== 'sent') wrong.push(`${code} route ${i} own ${t}: ${ok.kind} ${ok.reason.slice(0, 80)}`);
            if (bad.kind !== 'ownership' || !bad.reason.includes(`records it as ${wrongName(t)}, but the request acts on ${t}`)) wrong.push(`${code} route ${i} wrong: ${bad.kind} ${bad.reason.slice(0, 80)}`);
        }
    }
    expect(wrong).toEqual([]);
    expect(B.arrived).toEqual([]);
});

/** The whole POST_CREATE table; each entry gets an example (foreign scope parents) that must be a create and be sent. */
const EXPECTED_CREATES = [
    '/v1/roles', '/v1/groups', '/v1/users', '/v1/credentials', '/v1/authorities', '/v1/authorities/{id}/raProfiles',
    '/v1/acmeProfiles', '/v1/scepProfiles', '/v1/cmpProfiles', '/v1/tokens', '/v1/tokens/{id}/tokenProfiles',
    '/v1/tokens/{id}/tokenProfiles/{id}/keys/[A-Za-z]+', '/v1/discoveries', '/v1/attributes/custom',
    '/v1/notificationInstances', '/v1/notificationProfiles',
    '/v1/workflows/(triggers|rules|conditions|actions|executions)', '/v1/entities', '/v1/entities/{id}/locations',
    '/v1/vaults', '/v1/vaults/{id}/vaultProfiles', '/v1/vaults/{id}/vaultProfiles/{id}/secrets', '/v1/complianceProfiles',
    '/v1/approvalProfiles', '/v1/connectors', '/v1/certificates/upload', '/v1/certificates/upload/async',
    '/v2/operations/authorities/{id}/raProfiles/{id}/certificates', '/v1/workflows/events',
    // Inspections, certificate import, certificate register, POST /v2/connectors as a create (tests/unit/guardedApiAllowedRequests.spec.ts
    // has their limits).
    '/v1/inspections', '/v1/certificates/import', '/v2/operations/authorities/{id}/raProfiles/{id}/certificates/register', '/v2/connectors', '/v2/complianceProfiles',
];

// literal tables: POST_CREATE entry by entry — every example is a create and is sent under foreign scope parents
test('safety list: POST_CREATE entry by entry, every example is a create sent under foreign scope parents', async () => {
    expect([...POST_CREATE]).toEqual(EXPECTED_CREATES);
    const g = looseApi(guard());
    const wrong: string[] = [];
    for (const entry of EXPECTED_CREATES) {
        const examples = entry.includes('(triggers|') ? ['triggers', 'rules', 'conditions', 'actions', 'executions'].map((w) => entry.replace(/\(.*\)/, w))
            : [entry.replace(/\{id\}/g, FOREIGN).replace('[A-Za-z]+', 'keyPair')];
        for (const path of examples) {
            if (postRouteKind(path) !== 'create') wrong.push(`${path}: postRouteKind ${postRouteKind(path)}`);
            const data = path === '/v1/workflows/events' ? { event: 'x', resource: 'certificates', objectUuid: OWN.certificates, triggerUuids: [] }
                : path === '/v1/certificates/import' ? { file: 'AAAA', entries: [{ entryReference: 'ab'.repeat(32) }] }
                    : { name: `${RUN}-c` };
            const got = await refusal(g.post(`/api${path}`, { data }));
            if (got.kind !== 'sent') wrong.push(`${path}: ${got.kind} ${got.reason.slice(0, 80)}`);
        }
    }
    expect(wrong).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ typed list values and the read POST table

// typed lists: a typed list body takes strings only — nested lists, objects, numbers and null are refused on both routes
test('typed lists: a typed list body takes strings only; nested lists, objects and null are refused', async () => {
    const g = looseApi(guard());
    const wrong: string[] = [];
    for (const [url, own] of [[`/api/v1/roles/${OWN.roles}/users`, OWN.users], [`/api/v1/users/${OWN.users}/roles`, OWN.roles]] as const) {
        for (const data of [[[own]], [{ uuid: own }], [1], [null], [own, 1], [true]]) {
            const got = await refusal(g.patch(url, { data }));
            if (got.kind !== 'request' || !/holds an element that is not a string \(its body is List<String>\)/.test(got.reason)) {
                wrong.push(`${url} ${JSON.stringify(data)}: ${got.kind} ${got.reason.slice(0, 80)}`);
            }
        }
        expect(A.mutations(), url).toEqual([]);
        for (const data of [[own], []]) expect((await refusal(g.patch(url, { data }))).kind, `${url} ${JSON.stringify(data)}`).toBe('sent');
        A.reset();
    }
    expect(wrong).toEqual([]);
    // A key-item list route (null type) refuses a non-string element the same way; probes stay sendable.
    expect((await refusal(g.patch(`/api/v1/keys/${OWN.keys}/disable`, { data: [[g.probeUuid()]] }))).kind).toBe('request');
    expect((await refusal(g.patch(`/api/v1/keys/${OWN.keys}/disable`, { data: [g.probeUuid()] }))).kind).toBe('sent');
    expect(B.arrived).toEqual([]);
});

/** The whole POST_READ table as a literal: deleting or changing an entry fails the row below. */
const EXPECTED_READS: Array<[string, string[]]> = [
    ['/v1/certificates', ['/v1/certificates']],
    ['/v1/keys', ['/v1/keys']],
    ['/v1/discoveries/list', ['/v1/discoveries/list']],
    ['/v1/entities/list', ['/v1/entities/list']],
    ['/v1/locations', ['/v1/locations']],
    ['/v1/secrets', ['/v1/secrets']],
    ['/v1/vaults/list', ['/v1/vaults/list']],
    ['/v1/vaultProfiles/list', ['/v1/vaultProfiles/list']],
    ['/v1/auditLogs', ['/v1/auditLogs']],
    ['/v1/oids/list', ['/v1/oids/list']],
    ['/v1/users/identify', ['/v1/users/identify']],
    ['/v1/certificates/content', ['/v1/certificates/content']],
    ['/v1/workflows/events/{seg}/history', ['/v1/workflows/events/certificate_status_changed/history']],
    ['/v1/workflows/events/{seg}/{seg}/{id}/history', [`/v1/workflows/events/certificate_status_changed/certificates/${FOREIGN}/history`]],
    ['/v1/({seg}/)*attributes(/{seg})?/validate', ['/v1/attributes/validate', '/v1/connectors/auth/attributes/basic/validate',
        `/v1/authorities/${FOREIGN}/attributes/raProfile/validate`, `/v1/entities/${FOREIGN}/attributes/location/validate`]],
    ['/v1/connectors/{id}/{seg}/{seg}/validate', [`/v1/connectors/${FOREIGN}/authorityProvider/ejbca/validate`]],
];

// literal tables: POST_READ entry by entry — every example is a read POST, sent with a body naming a foreign uuid (reads are not judged)
test('safety list: POST_READ entry by entry, each example is a read POST sent with a foreign uuid', async () => {
    expect([...POST_READ]).toEqual(EXPECTED_READS.map(([e]) => e));
    const g = looseApi(guard());
    const wrong: string[] = [];
    for (const [entry, examples] of EXPECTED_READS) {
        for (const path of examples) {
            if (postRouteKind(path) !== 'read') wrong.push(`${entry} ${path}: postRouteKind ${postRouteKind(path)}`);
            const got = await refusal(g.post(`/api${path}`, { data: { filters: [], uuid: FOREIGN } }));
            if (got.kind !== 'sent') wrong.push(`${entry} ${path}: ${got.kind} ${got.reason.slice(0, 80)}`);
        }
    }
    expect(wrong).toEqual([]);
    expect(A.mutations()).toHaveLength(EXPECTED_READS.reduce((n, [, ex]) => n + ex.length, 0));
    expect(B.arrived).toEqual([]);
});
