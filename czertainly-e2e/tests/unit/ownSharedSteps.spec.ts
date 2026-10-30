/**
 * ownSharedSteps — the ledger steps of `own` that specs use instead of the lower-level record helpers, and the
 * worker-scoped API context.
 *
 * Checks `own.probe` (an accepted create a row expected to be refused), `own.adoptNamed` (the row a refused create left
 * behind: run-prefixed names only, recorded, then proven live), `own.restrictedUser` (a left-behind user skips the test),
 * `own.derivedKey`, `own.issuedNamed`, `own.acmeAccount`, `own.runAuthority`, `withWorkerApi` and `buildRig` (no skip: a
 * tier without a CA is for the `ca` need to skip). Each is a safety step (record before assert, never adopt what is not this
 * run's); a test per step keeps a refactor from loosening one. Assertions read the ledger and the requests on the wire.
 */
import { expect, test } from '@playwright/test';
import type { TestEnv } from '../../utils/env';
import { withWorkerApi } from '../../fixtures/regressionFixtures';
import { buildRig } from '../../utils/regression/events/notificationDeliveryFixtures';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { assertGuarded } from '../../utils/regression/guard/types';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { issueOnly } from '../../utils/regression/ledger/ledger';
import { runId, runName, updateRunState } from '../../utils/regression/ledger/runState';
import { ownObjects, type OwnObjects } from '../../utils/regression/ownObjects';
import { RaProfileSourceMissing } from '../../utils/regression/ownRaProfiles';
import { FakeCore } from './helpers/fakeCore';
import { FakeCoreRig, registerFakeCore } from './helpers/guardRig';
import type { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';

const SPEC = 'ownSharedSteps.spec';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENV_KEYS = ['REG_RESTRICTED_USERNAME', 'REG_RESTRICTED_PASSWORD', 'REG_CA_CONNECTORS', 'REG_ADCS_CONNECTOR', 'REG_RA_PROFILE_NAME'];

/** GET answers by path (set by the test); a POST to the certificate search answers the certificates of `searchable`. */
class StepsCore extends FakeCore {
    readonly routes = new Map<string, Answer>();
    searchable: Array<Record<string, unknown>> = [];

    serve(path: string, body: unknown, status = 200): void {
        this.routes.set(path, { status, body });
    }

    protected route(a: Arrived, path: string): Answer | undefined {
        if (a.method === 'POST' && path === '/api/v1/certificates') return { status: 200, body: { certificates: this.searchable } };
        return a.method === 'GET' ? this.routes.get(path) : undefined;
    }
}

let core: StepsCore;
let server: LoopbackServer;
let api: GuardedApi;
let skipped: string[];
let own: OwnObjects;
test.beforeEach(() => {
    core = new StepsCore();
    skipped = [];
});
registerFakeCore(() => core, (rig: FakeCoreRig) => {
    ({ server, api } = rig);
    own = ownObjects(api, SPEC, (reason) => void skipped.push(reason));
}, { clear: ENV_KEYS });

const created = (type: string) => readLedger().filter((l) => l.type === type && l.event === 'created');
const prefixed = (what: string) => `${runId()}-${what}`;

// ------------------------------------------------------------------ own.probe

test('own.probe records an accepted API create before the row asserts, and nothing for a refusal', () => {
    const accepted = own.probe('groups', { status: 201, json: { uuid: U(1) }, serverAt: new Date('2026-01-02T03:04:05Z') }, { name: prefixed('probe-a'), note: 'accepted although refused expected', parents: { raProfile: U(2) } });
    expect(accepted).toEqual({ uuid: U(1), name: prefixed('probe-a'), kind: 'own' });
    expect(created('groups')).toMatchObject([{ uuid: U(1), name: prefixed('probe-a'), spec: SPEC, note: 'accepted although refused expected', parents: { raProfile: U(2) }, serverAt: '2026-01-02T03:04:05.000Z' }]);
    expect(own.probe('groups', { status: 422, json: { uuid: U(3) } }, { name: prefixed('probe-b') }), 'a 4xx never records, whatever the body says').toBeUndefined();
    expect(own.probe('groups', { status: 201, json: { uuid: 'not-a-uuid' } }, { name: prefixed('probe-c') }), 'a 2xx without a canonical uuid').toBeUndefined();
    expect(own.probe('groups', { status: 200, json: ['x'] }), 'a body that is not an object').toBeUndefined();
    expect(created('groups')).toHaveLength(1);
});

test('own.probe records a form answer that names an id whatever its status, takes the name from the request body, and never records twice', () => {
    expect(own.probe('roles', { status: 409, uuid: U(4), text: 'exists', body: { name: prefixed('dup') } })).toEqual({ uuid: U(4), name: prefixed('dup'), kind: 'own' });
    expect(own.probe('users', { status: 201, uuid: U(5), text: '', body: { username: prefixed('user') } })?.name, 'a user is named by its username').toBe(prefixed('user'));
    expect(own.probe('roles', { status: 409, uuid: U(4), text: 'exists', body: { name: prefixed('dup') } })?.uuid, 'the same object again').toBe(U(4));
    expect(created('roles')).toHaveLength(1);
    expect(own.probe('roles', { status: 409, text: 'exists', body: { name: prefixed('none') } }), 'a form answer with no id').toBeUndefined();
    // No name anywhere: the line is written first, under a placeholder without the run prefix (the teardown reports it, never deletes it).
    expect(own.probe('roles', { status: 201, uuid: U(6), text: '' })?.name).toBe('(no name)');
    expect(created('roles').map((l) => l.name)).toEqual([prefixed('dup'), '(no name)']);
    expect(server.arrived, 'recording sends nothing').toEqual([]);
});

// ------------------------------------------------------------------ own.adoptNamed

test('own.adoptNamed records the row a refused create left behind and proves it live', async () => {
    const name = prefixed('left-behind');
    core.serve('/api/v1/roles', [{ uuid: U(10), name }, { uuid: U(11), name: 'Everyone' }]);
    core.serve(`/api/v1/roles/${U(10)}`, { uuid: U(10), name });
    const refs = await own.adoptNamed('roles', name, { note: 'left by a refused create', parents: { raProfile: U(12) } });
    expect(refs).toEqual([{ uuid: U(10), name, kind: 'own' }]);
    expect(created('roles')).toMatchObject([{ uuid: U(10), name, spec: SPEC, note: 'left by a refused create', parents: { raProfile: U(12) } }]);
    expect(server.arrived.map((a) => `${a.method} ${a.url}`), 'the list, then the live read of the row').toEqual(['GET /api/v1/roles', `GET /api/v1/roles/${U(10)}`]);
    expect(server.mutations()).toEqual([]);
    // Again: the row is already this run's, so no second line.
    await own.adoptNamed('roles', name);
    expect(created('roles')).toHaveLength(1);
    expect(await own.adoptNamed('roles', prefixed('nothing-here'))).toEqual([]);
});

test('own.adoptNamed refuses a name that is not this run\'s before it reads anything', async () => {
    for (const foreign of ['Everyone', 'someone-elses-role', `${runId()}x`, `other-run-${runId()}-role`, '', `${runId().slice(0, -1)}-role`]) {
        await expect(own.adoptNamed('roles', foreign), foreign || '(empty)').rejects.toThrow(/does not start with this run's id/);
    }
    expect(server.arrived, 'not a single read').toEqual([]);
    expect(readLedger()).toEqual([]);
});

test('own.adoptNamed fails on an unreadable list and on a type it has no list for, and never keeps a row whose live name is foreign', async () => {
    const name = prefixed('left-behind');
    core.serve('/api/v1/groups', { message: 'down' }, 500);
    await expect(own.adoptNamed('groups', name)).rejects.toThrow(/answered 500/);
    expect(readLedger(), 'a failed read adopts nothing').toEqual([]);
    await expect(own.adoptNamed('approvals', name)).rejects.toThrow(/no list URL is known for the type approvals/);
    // The list says the name, the live object says another: the live proof refuses it (the line was written first, the object stays
    // unproven).
    core.serve('/api/v1/groups', [{ uuid: U(13), name }]);
    core.serve(`/api/v1/groups/${U(13)}`, { uuid: U(13), name: 'Everyone' });
    await expect(own.adoptNamed('groups', name)).rejects.toBeInstanceOf(OwnObjectViolation);
});

// ------------------------------------------------------------------ own.restrictedUser

test('own.restrictedUser needs a configured second identity, returns the run\'s own user, and skips for a left-behind one', async () => {
    await expect(own.restrictedUser()).rejects.toThrow(/no second identity is configured/);
    process.env.REG_RESTRICTED_USERNAME = 'qa-dedicated';
    process.env.REG_RESTRICTED_PASSWORD = 'unused-secret';
    core.serve('/api/v1/users', [{ uuid: U(20), username: 'QA-Dedicated' }]);
    await expect(own.restrictedUser(), 'the user exists and is not this run\'s').rejects.toThrow(/dedicated test user exists but is not this run's/);
    expect(skipped, 'the test is skipped with the named reason').toEqual([expect.stringMatching(/^dedicated test user exists but is not this run's/)]);
    expect(server.mutations(), 'nothing was created').toEqual([]);
    expect(readLedger()).toEqual([]);
    const known = recordCreated('users', { uuid: U(21), name: 'qa-dedicated' }, { spec: SPEC });
    expect(await own.restrictedUser(), 'the run\'s own user is returned from the ledger').toEqual(known);
    expect(skipped).toHaveLength(1);
});

// ------------------------------------------------------------------ own.derivedKey, issuedNamed, acmeAccount

test('own.derivedKey records the key the platform linked, from a uuid or a certificate answer, and fails on an unreadable certificate', async () => {
    core.serve(`/api/v1/certificates/${U(30)}`, { uuid: U(30), key: { uuid: U(31) } });
    await own.derivedKey(U(30), '2026-01-01T00:00:00Z');
    expect(readLedger().filter((l) => l.type === 'keys')).toMatchObject([{ uuid: U(31), derived: true, createdAfter: '2026-01-01T00:00:00Z', spec: SPEC, parents: { certificate: U(30) } }]);
    core.serve(`/api/v1/certificates/${U(32)}`, { uuid: U(32), key: { uuid: U(33) } });
    await own.derivedKey({ uuid: U(32), createdAfter: '2026-02-02T00:00:00Z' });
    expect(readLedger().find((l) => l.uuid === U(33))).toMatchObject({ createdAfter: '2026-02-02T00:00:00Z' });
    core.serve(`/api/v1/certificates/${U(34)}`, { uuid: U(34) });
    await own.derivedKey(U(34), '2026-01-01T00:00:00Z');
    expect(readLedger().filter((l) => l.type === 'keys'), 'a certificate without a key records nothing').toHaveLength(2);
    core.serve(`/api/v1/certificates/${U(35)}`, { message: 'down' }, 500);
    await expect(own.derivedKey(U(35), '2026-01-01T00:00:00Z')).rejects.toThrow();
});

test('own.issuedNamed adopts the run-named certificates and their keys and refuses a name without the run prefix', async () => {
    const cn = `${runId()}-proto.example.test`;
    core.searchable = [{ uuid: U(40), commonName: cn }];
    core.serve(`/api/v1/certificates/${U(40)}`, { uuid: U(40), key: { uuid: U(41) } });
    expect(await own.issuedNamed(cn, '2026-01-01T00:00:00Z', 'made by a protocol client')).toEqual([U(40)]);
    expect(created('certificates')).toMatchObject([{ uuid: U(40), name: cn, spec: SPEC, note: 'made by a protocol client' }]);
    expect(readLedger().filter((l) => l.type === 'keys').map((l) => l.uuid)).toEqual([U(41)]);
    await expect(own.issuedNamed('somebody-elses.example.test', undefined, 'n')).rejects.toThrow(/no run prefix/);
});

test('own.acmeAccount records the account of the run\'s ACME profile and fails when it is not listed', async () => {
    const profile = recordCreated('acmeProfiles', { uuid: U(50), name: prefixed('acme') }, { spec: SPEC });
    core.serve('/api/v1/acmeAccounts', [{ uuid: U(51), accountId: 'abc123', acmeProfileUuid: U(50) }, { uuid: U(52), accountId: 'abc123', acmeProfileUuid: U(53) }]);
    const ref = await own.acmeAccount('https://acme.invalid/acme/profile/x/acct/abc123', profile);
    expect(ref).toEqual({ uuid: U(51), name: runName('acme-account-abc123'), kind: 'own' });
    expect(created('acmeAccounts')).toMatchObject([{ uuid: U(51), parents: { acmeProfile: U(50) } }]);
    await expect(own.acmeAccount('https://acme.invalid/acme/profile/x/acct/unknown', profile)).rejects.toThrow(/is listed/);
});

// ------------------------------------------------------------------ own.runAuthority

test('own.runAuthority is the uuid of the authority the run made, not of an issue-only one, and undefined without one', () => {
    expect(own.runAuthority()).toBeUndefined();
    updateRunState({ authority: issueOnly({ uuid: U(60), name: 'existing-authority' }) });
    expect(own.runAuthority(), 'an existing authority is only a parent').toBeUndefined();
    updateRunState({ authority: { uuid: U(61), name: prefixed('authority'), kind: 'own' } });
    expect(own.runAuthority()).toBe(U(61));
});

// ------------------------------------------------------------------ the worker API context and the rig

test('withWorkerApi hands a guarded context to the worker fixture and disposes it afterwards', async () => {
    const env = { baseUrl: process.env.BASE_URL, authMode: 'header', username: 'admin', password: 'unused' } as TestEnv;
    let handed: GuardedApi | undefined;
    await withWorkerApi(api, env, async (workerApi) => {
        handed = workerApi;
        expect(assertGuarded(workerApi, 'worker fixture'), 'built through the guard factory').toBe(workerApi);
        expect(await (await workerApi.get('/api/v1/groups')).status(), 'it reaches the fake core').toBe(404);
    });
    expect(handed).toBeDefined();
    await expect(handed!.get('/api/v1/groups'), 'disposed when the worker ends').rejects.toThrow();
});

test('buildRig takes no skip: a tier without a CA throws the source-missing error and creates nothing', async () => {
    core.serve('/api/v1/connectors', []);
    core.serve('/api/v1/authorities', []);
    core.serve('/api/v1/raProfiles', []);
    await expect(buildRig(api, SPEC, 'rig')).rejects.toBeInstanceOf(RaProfileSourceMissing);
    expect(server.mutations()).toEqual([]);
    expect(readLedger()).toEqual([]);
    expect(buildRig.length, 'three parameters: api, spec, suffix').toBe(3);
});
