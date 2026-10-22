/**
 * The guard on approval decisions and the caller named as approver in an own approval profile, on the wire (a real
 * Playwright context, a loopback fake core, a second origin that must see nothing): own approvals are sent, foreign
 * ones and every other shape refused. Also the oidEntries teardown handler.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { guardApiWithSeams } from '../../utils/regression/guard/createGuard';
import { LiveObjectMissing, OwnObjectViolation, RefusalKind } from '../../utils/regression/ledger/ownership';
import { LedgerLine, ledgerFile, ledgerKeyProblem, oidEntryLedgerUuid, parseLedger } from '../../utils/regression/ledger/ledger';
import { handlerOf, TeardownContext } from '../../utils/regression/teardown/runTeardown';
import { localProofFile } from '../../utils/regression/tier/localProof';
import { tierIdentity } from '../../utils/regression/tier/kind';
import { Arrived, LoopbackServer } from './helpers/loopbackServer';
import { registerGuardRig, withProcessEnv, looseApi } from './helpers/guardRig';

const RUN = 'qa-reg-20261016-120000-p1d0';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The caller: hex letters, so a lower / upper case slip shows (an all-digit uuid reads the same in both). */
const SELF = '0a0b0c0d-0e0f-4000-8000-00000000abcd';
const OTHER_USER = U(2);
const OWN_CERT = U(10);
const OWN_AP = U(11);
const DERIVED_CERT = U(12);
const FOREIGN_CERT = U(20);
const FOREIGN_AP = U(21);
const OWN_ROLE = U(40);
const APR = {
    own: U(100), foreignAp: U(101), foreignCert: U(102), noAp: U(103), derivedCert: U(104),
    liveOtherCert: U(105), liveOtherAp: U(106), liveNotCert: U(107), live404: U(108), foreign: U(109),
    apIsCert: U(110), certRenamed: U(111),
};
const RENAMED_CERT = U(13);

const mk = (type: string, uuid: string, name = `${RUN}-${type}`, parents?: LedgerLine['parents'], over: Partial<LedgerLine> = {}): LedgerLine =>
    ({ at: 'a', runId: RUN, type, name, uuid, spec: 'T', event: 'created', ...(parents ? { parents } : {}), ...over });
const both = { certificate: OWN_CERT, approvalProfile: OWN_AP };
const lines: LedgerLine[] = [
    mk('certificates', OWN_CERT, `${RUN}.example.test`), mk('approvalProfiles', OWN_AP),
    mk('certificates', DERIVED_CERT, 'derived', undefined, { derived: true, createdAfter: '2026-10-16T00:00:00.000Z' }),
    mk('roles', OWN_ROLE),
    mk('approvals', APR.own, `${RUN}-approval`, both),
    mk('approvals', APR.foreignAp, `${RUN}-approval`, { certificate: OWN_CERT, approvalProfile: FOREIGN_AP }),
    mk('approvals', APR.foreignCert, `${RUN}-approval`, { certificate: FOREIGN_CERT, approvalProfile: OWN_AP }),
    mk('approvals', APR.noAp, `${RUN}-approval`, { certificate: OWN_CERT }),
    mk('approvals', APR.derivedCert, `${RUN}-approval`, { certificate: DERIVED_CERT, approvalProfile: OWN_AP }),
    mk('approvals', APR.liveOtherCert, `${RUN}-approval`, both), mk('approvals', APR.liveOtherAp, `${RUN}-approval`, both),
    mk('approvals', APR.liveNotCert, `${RUN}-approval`, both), mk('approvals', APR.live404, `${RUN}-approval`, both),
    // The approval-profile parent names an own CERTIFICATE line; the certificate parent is own in the ledger but renamed live.
    mk('approvals', APR.apIsCert, `${RUN}-approval`, { certificate: OWN_CERT, approvalProfile: OWN_CERT }),
    mk('certificates', RENAMED_CERT, `${RUN}.renamed.test`), mk('approvals', APR.certRenamed, `${RUN}-approval`, { certificate: RENAMED_CERT, approvalProfile: OWN_AP }),
];

const detail = (objectUuid: string, approvalProfileUuid: string, resource = 'certificates') => ({ resource, objectUuid, approvalProfileUuid, status: 'PENDING' });
const live: Record<string, unknown> = {
    [`/api/v1/certificates/${OWN_CERT}`]: { commonName: `${RUN}.example.test` },
    [`/api/v1/certificates/${DERIVED_CERT}`]: { commonName: 'derived' },
    [`/api/v1/certificates/${FOREIGN_CERT}`]: { commonName: 'production.example.com' },
    [`/api/v1/approvalProfiles/${OWN_AP}`]: { name: `${RUN}-approvalProfiles` },
    [`/api/v1/approvalProfiles/${FOREIGN_AP}`]: { name: 'Production approvals' },
    [`/api/v1/roles/${OWN_ROLE}`]: { name: `${RUN}-roles` },
    [`/api/v1/approvals/${APR.own}`]: detail(OWN_CERT, OWN_AP),
    [`/api/v1/approvals/${APR.foreignAp}`]: detail(OWN_CERT, FOREIGN_AP),
    [`/api/v1/approvals/${APR.foreignCert}`]: detail(FOREIGN_CERT, OWN_AP),
    [`/api/v1/approvals/${APR.noAp}`]: detail(OWN_CERT, OWN_AP),
    [`/api/v1/approvals/${APR.derivedCert}`]: detail(DERIVED_CERT, OWN_AP),
    [`/api/v1/approvals/${APR.liveOtherCert}`]: detail(FOREIGN_CERT, OWN_AP),
    [`/api/v1/approvals/${APR.liveOtherAp}`]: detail(OWN_CERT, FOREIGN_AP),
    [`/api/v1/approvals/${APR.liveNotCert}`]: detail(OWN_CERT, OWN_AP, 'raProfiles'),
    [`/api/v1/approvals/${APR.foreign}`]: detail(OWN_CERT, OWN_AP),
    [`/api/v1/approvals/${APR.apIsCert}`]: detail(OWN_CERT, OWN_CERT),
    [`/api/v1/certificates/${RENAMED_CERT}`]: { commonName: 'production.example.com' },
    [`/api/v1/approvals/${APR.certRenamed}`]: detail(RENAMED_CERT, OWN_AP),
};

/** The auth profile's answer, mutable per test. */
let profile: { status: number; body?: unknown } = { status: 200, body: { uuid: SELF, username: 'qa-admin' } };
/** OID entries by OID (teardown rows). */
const oids = new Map<string, { oid: string; displayName: string }>();
let keepOnDelete = false;

const coreAnswer = (a: Arrived) => {
    const [p] = a.url.split('?');
    if (a.method === 'GET') {
        if (p === '/api/v1/auth/profile') return profile;
        const oid = /^\/api\/v1\/oids\/([0-9.]+)$/.exec(p);
        if (oid) return oids.has(oid[1]) ? { status: 200, body: oids.get(oid[1]) } : { status: 404, body: {} };
        return live[p] ? { status: 200, body: live[p] } : { status: 404, body: {} };
    }
    if (a.method === 'DELETE') {
        const oid = /^\/api\/v1\/oids\/([0-9.]+)$/.exec(p);
        if (oid) {
            if (!keepOnDelete) oids.delete(oid[1]);
            return { status: 204 };
        }
    }
    return { status: 204 };
};

let A: LoopbackServer;
let B: LoopbackServer;
let raw: APIRequestContext;
let BASE_URL: string;

registerGuardRig(
    {
        answer: coreAnswer,
        beforeEachTest: () => {
            profile = { status: 200, body: { uuid: SELF, username: 'qa-admin' } };
            oids.clear();
            keepOnDelete = false;
        },
    },
    (rig) => {
        A = rig.A;
        B = rig.B;
        raw = rig.raw;
        BASE_URL = rig.BASE_URL;
    },
);

// `any`: the rows pass the guard's own `identityOverride` option, which Playwright's request types do not declare.
const guard = (extra: LedgerLine[] = []) => looseApi(guardApiWithSeams(raw, { lines: [...lines, ...extra], runId: RUN, tier: null, env: { BASE_URL } }));

async function refusal(call: Promise<unknown>): Promise<{ kind: RefusalKind | 'sent' | string; reason: string }> {
    try {
        await call;
        return { kind: 'sent', reason: '' };
    } catch (e) {
        return e instanceof OwnObjectViolation ? { kind: e.kind, reason: e.reason } : { kind: `error: ${String(e).slice(0, 160)}`, reason: String(e) };
    }
}
const mutations = () => A.mutations().map((a) => `${a.method} ${a.url}${a.body ? ` ${a.body}` : ''}`);
const gets = (url: string) => A.arrived.filter((a) => a.method === 'GET' && a.url === url).length;

// ------------------------------------------------------------------ approval decisions

// approval decision: an own approval of an own certificate and an own approval profile is decided on the override and the recipient path
test('approval decision: an own approval of an own certificate and profile is decided on the override path', async () => {
    const g = guard();
    await g.patch(`/api/v1/approvals/${APR.own}/approve`);
    await g.patch(`/api/v1/approvals/${APR.own}/reject`, { data: {} });
    await g.patch(`/api/v1/approvals/${APR.own}/approveRecipient`, { data: { comment: 'ok' } });
    await g.patch(`/api/v1/approvals/${APR.own}/rejectRecipient`, { data: { comment: null } });
    await g.patch(`/api/v1/approvals/${APR.own}/rejectRecipient`);
    expect(mutations()).toEqual([
        `PATCH /api/v1/approvals/${APR.own}/approve`,
        `PATCH /api/v1/approvals/${APR.own}/reject {}`,
        `PATCH /api/v1/approvals/${APR.own}/approveRecipient {"comment":"ok"}`,
        `PATCH /api/v1/approvals/${APR.own}/rejectRecipient {"comment":null}`,
        `PATCH /api/v1/approvals/${APR.own}/rejectRecipient`,
    ]);
    // Each decision read the certificate, the approval profile and the approval live first.
    expect(gets(`/api/v1/approvals/${APR.own}`)).toBe(5);
    expect(gets(`/api/v1/certificates/${OWN_CERT}`)).toBe(5);
    expect(gets(`/api/v1/approvalProfiles/${OWN_AP}`)).toBe(5);
    // A probe uuid keeps its 404 allowance (it names nothing).
    expect((await refusal(g.patch(`/api/v1/approvals/${g.probeUuid()}/approve`))).kind).toBe('sent');
    expect(B.arrived).toEqual([]);
});

// approval decision: a foreign approval, foreign or missing parents and a live detail that disagrees are refused for ownership;
// nothing is sent
test('approval decision: foreign approval, foreign parents or a disagreeing detail are refused unsent', async () => {
    const g = guard();
    const rows: Array<[string, string, RegExp]> = [
        ['no ledger line', APR.foreign, /no ledger "created" line of run/],
        ['a foreign approval profile parent', APR.foreignAp, /no ledger "created" line of run/],
        ['a foreign certificate parent', APR.foreignCert, /no ledger "created" line of run/],
        ['no approval profile parent', APR.noAp, /names no own approval profile/],
        ['a derived certificate parent', APR.derivedCert, /certificates parent is not an own certificates line/],
        ['live: another certificate', APR.liveOtherCert, /belongs to another certificate than its ledger parent/],
        ['live: another approval profile', APR.liveOtherAp, /belongs to another approval profile than its ledger parent/],
        ['live: not a certificate\'s approval', APR.liveNotCert, /is not a certificate's \(resource\)/],
        ['live: 404', APR.live404, /live detail answered 404/],
        ['an approval profile parent recorded as a certificate', APR.apIsCert, /approvalProfiles parent is not an own approvalProfiles line/],
        ['a certificate parent renamed live', APR.certRenamed, /its live name does not start with/],
    ];
    const wrong: string[] = [];
    for (const [name, uuid, reason] of rows) {
        for (const decision of ['approve', 'rejectRecipient']) {
            const got = await refusal(g.patch(`/api/v1/approvals/${uuid}/${decision}`));
            if (got.kind !== 'ownership' || !reason.test(got.reason)) wrong.push(`${name} ${decision}: ${got.kind} ${got.reason.slice(0, 100)}`);
        }
    }
    expect(wrong).toEqual([]);
    expect(A.mutations()).toEqual([]);
    expect(B.arrived).toEqual([]);
});

// approval decision: every other route, method, identity and body on an approval is refused as a request, before any live read
test('approval decision: every other route, method, identity and body is refused before any read', async () => {
    const g = guard();
    const own = APR.own;
    const rows: Array<[string, () => Promise<unknown>, RegExp]> = [
        ['a comment on the approval', () => g.post(`/api/v1/comments/approvals/${own}`, { data: { content: 'x' } }), /an approval may only be decided/],
        ['DELETE the approval', () => g.delete(`/api/v1/approvals/${own}`), /an approval may only be decided/],
        ['PUT on a decision route', () => g.put(`/api/v1/approvals/${own}/approve`), /an approval may only be decided/],
        ['POST on a decision route', () => g.post(`/api/v1/approvals/${own}/approve`), /an approval may only be decided/],
        ['another sub-route', () => g.patch(`/api/v1/approvals/${own}/cancel`), /an approval may only be decided/],
        ['another API word as sub-route', () => g.patch(`/api/v1/approvals/${own}/retry`), /an approval may only be decided/],
        ['another identity', () => g.patch(`/api/v1/approvals/${own}/approve`, { headers: { authorization: 'Bearer OTHER' }, identityOverride: true }), /goes out as the run's own user/],
        ['identityOverride alone', () => g.patch(`/api/v1/approvals/${own}/approve`, { identityOverride: true }), /goes out as the run's own user/],
        ['a body on the override path', () => g.patch(`/api/v1/approvals/${own}/approve`, { data: { comment: 'x' } }), /takes no body/],
        ['a list body on the override path', () => g.patch(`/api/v1/approvals/${own}/reject`, { data: [] }), /takes no body/],
        ['an unknown field on the recipient path', () => g.patch(`/api/v1/approvals/${own}/approveRecipient`, { data: { comment: 'x', userUuid: SELF } }), /a field UserApprovalDto does not have/],
        ['a non-string comment', () => g.patch(`/api/v1/approvals/${own}/approveRecipient`, { data: { comment: 7 } }), /must be a string/],
        ['a list on the recipient path', () => g.patch(`/api/v1/approvals/${own}/approveRecipient`, { data: ['x'] }), /takes a UserApprovalDto object/],
    ];
    const wrong: string[] = [];
    for (const [name, call, reason] of rows) {
        const got = await refusal(call());
        if (got.kind !== 'request' || !reason.test(got.reason)) wrong.push(`${name}: ${got.kind} ${got.reason.slice(0, 100)}`);
    }
    expect(wrong).toEqual([]);
    expect(A.arrived, 'no live read, no write').toEqual([]);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ the caller as approver

const apBody = (step: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ name: `${RUN}-ap-self`, enabled: true, expiry: 24, approvalSteps: [{ order: 1, requiredApprovals: 1, ...step }], ...extra });

// caller as approver: an own approval profile step may name the caller (create and update of an own profile); the profile is read once
test('caller as approver: an own approval profile step may name the caller on create and update, read once', async () => {
    const g = guard();
    await g.post('/api/v1/approvalProfiles', { data: apBody({ userUuid: SELF }) });
    await g.post('/api/v1/approvalProfiles', { data: apBody({ userUuid: SELF.toUpperCase() }) });
    await g.put(`/api/v1/approvalProfiles/${OWN_AP}`, { data: apBody({ userUuid: SELF }) });
    // Two steps: the caller and an own role.
    await g.post('/api/v1/approvalProfiles', { data: { ...apBody({ userUuid: SELF }), approvalSteps: [{ order: 1, requiredApprovals: 1, userUuid: SELF }, { order: 2, requiredApprovals: 1, roleUuid: OWN_ROLE }] } });
    expect(A.mutations().map((a) => `${a.method} ${a.url}`)).toEqual([
        'POST /api/v1/approvalProfiles', 'POST /api/v1/approvalProfiles', `PUT /api/v1/approvalProfiles/${OWN_AP}`, 'POST /api/v1/approvalProfiles',
    ]);
    expect(JSON.parse(A.mutations()[0].body).approvalSteps[0].userUuid, 'the body goes out unchanged').toBe(SELF);
    expect(gets('/api/v1/auth/profile'), 'the caller is read once per guarded context').toBe(1);
    expect(B.arrived).toEqual([]);
});

// caller as approver: another user, the caller anywhere else, another identity, an unreadable profile, a string body or a
// foreign profile stay refused
test('caller as approver: another user, other places, identity or profile problems stay refused', async () => {
    const wrong: string[] = [];
    const rows: Array<[string, () => Promise<unknown>, RefusalKind]> = [
        ['another user', () => guard().post('/api/v1/approvalProfiles', { data: apBody({ userUuid: OTHER_USER }) }), 'ownership'],
        ['the caller AND another user (only the caller\'s step is waived)', () => guard().post('/api/v1/approvalProfiles', { data: { ...apBody({ userUuid: SELF }), approvalSteps: [{ order: 1, requiredApprovals: 1, userUuid: SELF }, { order: 2, requiredApprovals: 1, userUuid: OTHER_USER }] } }), 'ownership'],
        ['the caller in the description too', () => guard().post('/api/v1/approvalProfiles', { data: apBody({ userUuid: SELF }, { description: `approver ${SELF}` }) }), 'ownership'],
        ['the caller as a role', () => guard().post('/api/v1/approvalProfiles', { data: apBody({ roleUuid: SELF }) }), 'ownership'],
        ['the caller as a group', () => guard().post('/api/v1/approvalProfiles', { data: apBody({ groupUuid: SELF }) }), 'ownership'],
        ['the caller at the top level', () => guard().post('/api/v1/approvalProfiles', { data: { ...apBody({ roleUuid: OWN_ROLE }), userUuid: SELF } }), 'ownership'],
        ['the caller nested deeper', () => guard().post('/api/v1/approvalProfiles', { data: apBody({ roleUuid: OWN_ROLE, extra: { userUuid: SELF } }) }), 'ownership'],
        ['another identity', () => guard().post('/api/v1/approvalProfiles', { data: apBody({ userUuid: SELF }), headers: { authorization: 'Bearer OTHER' }, identityOverride: true }), 'ownership'],
        ['a string body', () => guard().post('/api/v1/approvalProfiles', { data: JSON.stringify(apBody({ userUuid: SELF })) }), 'ownership'],
        ['a foreign profile', () => guard().put(`/api/v1/approvalProfiles/${FOREIGN_AP}`, { data: apBody({ userUuid: SELF }) }), 'ownership'],
        ['another route', () => guard().put(`/api/v1/roles/${OWN_ROLE}`, { data: { name: `${RUN}-r`, approvalSteps: [{ userUuid: SELF }] } }), 'ownership'],
    ];
    for (const [name, call, kind] of rows) {
        const got = await refusal(call());
        if (got.kind !== kind) wrong.push(`${name}: ${got.kind} ${got.reason.slice(0, 100)}`);
    }
    profile = { status: 500, body: {} };
    const unreadable = await refusal(guard().post('/api/v1/approvalProfiles', { data: apBody({ userUuid: SELF }) }));
    if (unreadable.kind !== 'ownership') wrong.push(`profile 500: ${unreadable.kind}`);
    profile = { status: 200, body: { username: 'no uuid' } };
    const noUuid = await refusal(guard().post('/api/v1/approvalProfiles', { data: apBody({ userUuid: SELF }) }));
    if (noUuid.kind !== 'ownership') wrong.push(`profile without uuid: ${noUuid.kind}`);
    expect(wrong).toEqual([]);
    expect(A.mutations()).toEqual([]);
    // A probe as the step user is still sent (no profile read needed).
    A.reset();
    const g = guard();
    await g.post('/api/v1/approvalProfiles', { data: apBody({ userUuid: g.probeUuid() }) });
    expect(A.mutations()).toHaveLength(1);
    expect(gets('/api/v1/auth/profile')).toBe(0);
    expect(B.arrived).toEqual([]);
});

// ------------------------------------------------------------------ teardown handler oidEntries

const OID = '1.3.6.1.4.1.99999.1.7';

/** Runs a teardown handler as runTeardown does (wrapHandlerWithGuard wrapper), with the process ledger the guard reads. */
async function teardown(type: string, l: LedgerLine, env: Record<string, string> = {}, testDir: string): Promise<{ result?: unknown; error?: unknown }> {
    const state = path.join(testDir, 'state');
    return withProcessEnv({ REG_STATE_DIR: state, REG_RUN_ID: RUN, BASE_URL, ...env }, async () => {
        const tier = tierIdentity(process.env)!;
        const line = { ...l, tier };
        fs.mkdirSync(state, { recursive: true });
        fs.writeFileSync(ledgerFile(), `${JSON.stringify(line)}\n`);
        if (env.TIER_KIND === 'local') fs.writeFileSync(localProofFile(process.env), JSON.stringify({ runId: RUN, tier, at: new Date().toISOString() }));
        const ctx: TeardownContext = { api: raw, runId: RUN, ledger: parseLedger(fs.readFileSync(ledgerFile(), 'utf8')), seen: new Set(), tier, warn: () => undefined, pollMs: 1 };
        try {
            return { result: await handlerOf(type)!.remove(ctx, line) };
        } catch (e) {
            return { error: e };
        }
    });
}

// teardown oidEntries: only on a proven local stack, with a live run-prefixed displayName and a matching key; absence proven by GET
test('teardown oidEntries: proven local stack only, run-prefixed entry; absence proven by GET', async ({}, testInfo) => {
    const own = mk('oidEntries', oidEntryLedgerUuid(OID), `${RUN}-oid`, undefined, { key: OID });
    oids.set(OID, { oid: OID, displayName: `${RUN}-oid` });
    // A shared tier: refused before any request, even with a local-backend proof file of this run on disk.
    const shared = await teardown('oidEntries', own, {}, testInfo.outputPath('a'));
    expect(shared.error).toBeInstanceOf(OwnObjectViolation);
    const sharedWithProof = await withProcessEnv({ REG_STATE_DIR: testInfo.outputPath('a2'), REG_RUN_ID: RUN, BASE_URL }, async () => {
        fs.mkdirSync(testInfo.outputPath('a2'), { recursive: true });
        fs.writeFileSync(localProofFile(process.env), JSON.stringify({ runId: RUN, tier: tierIdentity(process.env), at: new Date().toISOString() }));
        const ctx: TeardownContext = { api: raw, runId: RUN, ledger: [own], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
        return refusal(handlerOf('oidEntries')!.remove(ctx, own));
    });
    expect(sharedWithProof.kind).toBe('request');
    expect(A.arrived).toEqual([]);
    // TIER_KIND=local without the run's proof: refused.
    const noProof = await withProcessEnv({ TIER_KIND: 'local' }, async () => {
        const state = testInfo.outputPath('b');
        return withProcessEnv({ REG_STATE_DIR: state, REG_RUN_ID: RUN, BASE_URL }, async () => {
            fs.mkdirSync(state, { recursive: true });
            const ctx: TeardownContext = { api: raw, runId: RUN, ledger: [own], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
            return refusal(handlerOf('oidEntries')!.remove(ctx, own));
        });
    });
    expect(noProof.kind).toBe('request');
    expect(A.arrived).toEqual([]);
    // A proven local stack, but the entry is not there (and was not seen in this step): route or object missing.
    oids.clear();
    expect((await teardown('oidEntries', own, { TIER_KIND: 'local' }, testInfo.outputPath('b2'))).error).toBeInstanceOf(LiveObjectMissing);
    oids.set(OID, { oid: OID, displayName: `${RUN}-oid` });
    A.reset();
    // A proven local stack: deleted through the guard (localStack), absence proven.
    expect((await teardown('oidEntries', own, { TIER_KIND: 'local' }, testInfo.outputPath('c'))).error).toBeUndefined();
    expect(mutations()).toEqual([`DELETE /api/v1/oids/${OID}`]);
    expect(oids.size).toBe(0);
    A.reset();
    // A foreign live displayName, or an entry that answers another OID: refused, nothing deleted.
    oids.set(OID, { oid: OID, displayName: 'Corporate policy OID' });
    expect((await teardown('oidEntries', own, { TIER_KIND: 'local' }, testInfo.outputPath('d'))).error).toBeInstanceOf(OwnObjectViolation);
    oids.set(OID, { oid: '1.3.6.1.4.1.99999.1.9', displayName: `${RUN}-oid` });
    expect((await teardown('oidEntries', own, { TIER_KIND: 'local' }, testInfo.outputPath('d2'))).error).toBeInstanceOf(OwnObjectViolation);
    expect(A.mutations()).toEqual([]);
    // A key that does not match the line's uuid never reaches the handler's request (the ledger shape refuses it).
    expect(ledgerKeyProblem('oidEntries', oidEntryLedgerUuid(OID), '1.3.6.1.4.1.99999.1.8')).toMatch(/not the one derived from its OID/);
    expect(ledgerKeyProblem('oidEntries', oidEntryLedgerUuid(OID), '1.3.6.1/../x')).toMatch(/not an OID/);
    expect(ledgerKeyProblem('oidEntries', oidEntryLedgerUuid(OID), undefined)).toMatch(/must carry its OID/);
    expect(ledgerKeyProblem('oidEntries', oidEntryLedgerUuid(OID), undefined, 'deleted')).toBeUndefined();
    expect(ledgerKeyProblem('roles', U(1), OID)).toMatch(/only an oidEntries line carries a key/);
    const mismatched = { ...own, key: '1.3.6.1.4.1.99999.1.8' };
    oids.set('1.3.6.1.4.1.99999.1.8', { oid: '1.3.6.1.4.1.99999.1.8', displayName: `${RUN}-oid` });
    const bad = await withProcessEnv({ TIER_KIND: 'local', REG_STATE_DIR: testInfo.outputPath('e'), REG_RUN_ID: RUN, BASE_URL }, async () => {
        fs.mkdirSync(testInfo.outputPath('e'), { recursive: true });
        fs.writeFileSync(localProofFile(process.env), JSON.stringify({ runId: RUN, tier: tierIdentity(process.env), at: new Date().toISOString() }));
        const ctx: TeardownContext = { api: raw, runId: RUN, ledger: [mismatched], seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
        return refusal(handlerOf('oidEntries')!.remove(ctx, mismatched));
    });
    expect(bad.kind).toBe('request');
    expect(A.mutations()).toEqual([]);
    // A delete that leaves the entry: absence not proven.
    oids.set(OID, { oid: OID, displayName: `${RUN}-oid` });
    keepOnDelete = true;
    expect(String((await teardown('oidEntries', own, { TIER_KIND: 'local' }, testInfo.outputPath('f'))).error)).toMatch(/absence not proven/);
    expect(B.arrived).toEqual([]);
});

test('the ledger: an oidEntries line carries its OID and the derived uuid, or the parser drops it', () => {
    const at = '2026-10-16T12:00:00.000Z';
    const good = { at, runId: RUN, type: 'oidEntries', name: `${RUN}-oid`, uuid: oidEntryLedgerUuid(OID), spec: 'T', key: OID, event: 'created' };
    expect(parseLedger(JSON.stringify(good))).toHaveLength(1);
    expect(parseLedger(JSON.stringify({ ...good, key: undefined }))).toEqual([]);
    expect(parseLedger(JSON.stringify({ ...good, uuid: U(5) }))).toEqual([]);
    expect(parseLedger(JSON.stringify({ ...good, key: undefined, event: 'deleted' })), 'a deleted line needs no key').toHaveLength(1);
    expect(parseLedger(JSON.stringify({ ...good, type: 'roles', uuid: U(5) })), 'a key on another type').toEqual([]);
    expect(oidEntryLedgerUuid(OID)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(oidEntryLedgerUuid(OID)).not.toBe(oidEntryLedgerUuid('1.3.6.1.4.1.99999.1.8'));
});
