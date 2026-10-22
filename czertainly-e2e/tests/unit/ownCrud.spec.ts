/**
 * ownCrud on the wire: a real Playwright APIRequestContext through the guard to a loopback fake core, with assertions on the
 * ledger LINES. `createOwn` records before it returns and records nothing for a refusal; `recordIfAccepted` and
 * `probeCollectionCreate` record an accepted create (a foreign name included) and nothing on a 4xx; `deleteOwn` removes an
 * own live object and writes the `deleted` line only on 200 / 204 (or an accepted extra status) after the read-back, hands a
 * refusal back, and refuses a foreign object or a raw context before anything is sent.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { GuardedApi } from '../../utils/regression/guard/types';
import { createOwn, deleteOwn, OWN_DELETE_PATHS, probeCollectionCreate, recordIfAccepted } from '../../utils/regression/ownCrud';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { OwnRef, readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { runName, ownName } from '../../utils/regression/ledger/runState';
import { fakeAnswer } from './helpers/fakeAnswer';
import { FakeCore } from './helpers/fakeCore';
import { FakeCoreRig, registerFakeCore, rawAsGuarded } from './helpers/guardRig';
import type { Arrived, Answer, LoopbackServer } from './helpers/loopbackServer';

const SPEC = 'ownCrud.spec';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GROUPS = '/api/v1/groups';

/** Detail URLs in the store; a DELETE answers `deleteStatus` and removes the object on a 2xx; a POST answers `createAnswer`. */
class OwnCrudCore extends FakeCore {
    deleteStatus = 204;
    createAnswer: Answer = { status: 201, body: { uuid: U(77) } };

    protected route(a: Arrived, path: string): Answer | undefined {
        if (a.method === 'DELETE') {
            if (this.deleteStatus < 300) this.store.delete(path);
            return this.deleteStatus === 204 ? { status: 204 } : { status: this.deleteStatus, body: ['Object is still used by a rule'] };
        }
        if (a.method === 'POST') return this.createAnswer;
        return undefined;
    }
}

let core: OwnCrudCore;
let server: LoopbackServer;
let raw: APIRequestContext;
let api: GuardedApi;
test.beforeEach(() => {
    core = new OwnCrudCore();
});
registerFakeCore(() => core, (rig: FakeCoreRig) => ({ server, raw, api } = rig));

function ownCondition(n: number): OwnRef {
    const ref = recordCreated('conditions', { uuid: U(n), name: runName(`cond-${n}`) }, { spec: SPEC });
    core.store.set(`${OWN_DELETE_PATHS.conditions}/${ref.uuid}`, { uuid: ref.uuid, name: ref.name });
    return ref;
}
const wire = () => server.mutations().map((a) => `${a.method} ${a.url}`);
const deletedLines = () => readLedger().filter((l) => l.event === 'deleted').map((l) => `${l.type} ${l.uuid}`);

test('an own live object: DELETE through the guard, the answer handed back, then the deleted ledger line', async () => {
    const ref = ownCondition(1);
    const out = await deleteOwn(api, 'conditions', ref, SPEC);
    expect({ status: out.status, json: out.json, text: out.text }).toEqual({ status: 204, json: undefined, text: '' });
    expect(wire()).toEqual([`DELETE /api/v1/workflows/conditions/${ref.uuid}`]);
    expect(deletedLines()).toEqual([`conditions ${ref.uuid}`]);
});

test('a refused delete is a result: status and parsed body returned, nothing recorded', async () => {
    const ref = ownCondition(2);
    core.deleteStatus = 422;
    const out = await deleteOwn(api, 'conditions', ref, SPEC);
    expect(out.status).toBe(422);
    expect(out.json).toEqual(['Object is still used by a rule']);
    expect(deletedLines()).toEqual([]);
});

test('a foreign object and a raw context are refused before anything is sent', async () => {
    const foreign: OwnRef = { uuid: U(9), name: 'not-this-run', kind: 'own' };
    core.store.set(`${OWN_DELETE_PATHS.conditions}/${foreign.uuid}`, { uuid: foreign.uuid, name: 'not-this-run' });
    await expect(deleteOwn(api, 'conditions', foreign, SPEC)).rejects.toBeInstanceOf(OwnObjectViolation);
    const ref = ownCondition(3);
    await expect(deleteOwn(rawAsGuarded(raw), 'conditions', ref, SPEC)).rejects.toThrow(/deleteOwn conditions/);
    expect(wire()).toEqual([]);
    expect(deletedLines()).toEqual([]);
});

test('an accepted delete runs the read-back BEFORE the deleted line; a failing read-back leaves the ledger as it was', async () => {
    const ref = ownCondition(4);
    const seenAtReadBack: string[] = [];
    await deleteOwn(api, 'conditions', ref, SPEC, { readBack: async () => void seenAtReadBack.push(String(deletedLines().length)) });
    expect(seenAtReadBack).toEqual(['0']);
    expect(deletedLines()).toEqual([`conditions ${ref.uuid}`]);

    const other = ownCondition(5);
    await expect(deleteOwn(api, 'conditions', other, SPEC, { readBack: async () => Promise.reject(new Error('still listed')) })).rejects.toThrow(/still listed/);
    expect(deletedLines()).toEqual([`conditions ${ref.uuid}`]);
});

test('alsoAccept: an extra status counts as accepted, any other refusal does not', async () => {
    const ref = ownCondition(6);
    core.deleteStatus = 404;
    expect((await deleteOwn(api, 'conditions', ref, SPEC)).status).toBe(404);
    expect(deletedLines()).toEqual([]);
    expect((await deleteOwn(api, 'conditions', ref, SPEC, { alsoAccept: [404] })).status).toBe(404);
    expect(deletedLines()).toEqual([`conditions ${ref.uuid}`]);
});

const createdLines = () => readLedger().filter((l) => l.event === 'created').map((l) => `${l.type} ${l.uuid} ${l.name}`);
const groupDescriptor = (name: string) => ({ type: 'groups', path: GROUPS, name, body: { description: 'x' }, note: 'unit' });

test('createOwn records the created object from the answer before it returns, with the run-prefixed name sent in the body', async () => {
    const name = ownName('crud');
    const out = await createOwn(api, SPEC, groupDescriptor(name));
    expect(out.uuid).toBe(U(77));
    expect(createdLines()).toEqual([`groups ${U(77)} ${name}`]);
    expect(JSON.parse(server.mutations()[0].body)).toEqual({ description: 'x', name });
});

test('createOwn: a non-2xx answer, a 2xx without a uuid and a malformed uuid record nothing and throw', async () => {
    for (const answer of [{ status: 422, body: { uuid: U(78), message: 'refused' } }, { status: 201, body: {} }, { status: 201, body: { uuid: 'not-a-uuid' } }]) {
        core.createAnswer = answer;
        await expect(createOwn(api, SPEC, groupDescriptor(ownName('crud')))).rejects.toThrow(/POST \/api\/v1\/groups/);
    }
    expect(createdLines()).toEqual([]);
});

test('createOwn refuses a raw context before anything is sent', async () => {
    await expect(createOwn(rawAsGuarded(raw), SPEC, groupDescriptor(ownName('crud')))).rejects.toThrow(/createOwn groups/);
    expect(server.arrived).toEqual([]);
    expect(createdLines()).toEqual([]);
});

test('recordIfAccepted records a 2xx with a uuid (a foreign name and a missing name included) and nothing on a 4xx or a missing uuid', () => {
    const ok = (uuid: string) => fakeAnswer(201, JSON.stringify({ uuid }));
    expect(recordIfAccepted('groups', ok(U(81)), runName('probe'), SPEC, 'accepted')?.uuid).toBe(U(81));
    expect(recordIfAccepted('groups', ok(U(82)), 'a-name-without-the-run-prefix', SPEC, 'accepted')?.uuid).toBe(U(82));
    expect(recordIfAccepted('groups', ok(U(83)), 42, SPEC, 'accepted')?.uuid).toBe(U(83));
    expect(createdLines()).toEqual([`groups ${U(81)} ${runName('probe')}`, `groups ${U(82)} a-name-without-the-run-prefix`, `groups ${U(83)} (no name)`]);
    const before = createdLines().length;
    expect(recordIfAccepted('groups', fakeAnswer(422, JSON.stringify({ uuid: U(84) })), 'x', SPEC, 'refused')).toBeUndefined();
    expect(recordIfAccepted('groups', fakeAnswer(201, '{}'), 'x', SPEC, 'no uuid')).toBeUndefined();
    expect(createdLines()).toHaveLength(before);
});

test('probeCollectionCreate hands any status back and records only an accepted create, noting it was unexpected', async () => {
    core.createAnswer = { status: 422, body: { uuid: U(85), message: 'refused' } };
    expect((await probeCollectionCreate(api, SPEC, { type: 'groups', path: GROUPS, body: { name: 5 }, note: 'probe' })).status).toBe(422);
    expect(createdLines()).toEqual([]);
    core.createAnswer = { status: 201, body: { uuid: U(86) } };
    const answer = await probeCollectionCreate(api, SPEC, { type: 'groups', path: GROUPS, body: { name: 'accepted-by-mistake' }, note: 'probe' });
    expect(answer.status).toBe(201);
    expect(createdLines()).toEqual([`groups ${U(86)} accepted-by-mistake`]);
    expect(readLedger().find((l) => l.uuid === U(86))?.note).toBe('probe (accepted although a refusal was expected)');
});

test('deleteOwn writes the deleted line on a 200 answer too', async () => {
    const ref = ownCondition(7);
    core.deleteStatus = 200;
    expect((await deleteOwn(api, 'conditions', ref, SPEC)).status).toBe(200);
    expect(deletedLines()).toEqual([`conditions ${ref.uuid}`]);
});

test('probeCollectionCreate refuses a raw context before anything is sent and records nothing for a 2xx without a uuid', async () => {
    await expect(probeCollectionCreate(rawAsGuarded(raw), SPEC, { type: 'groups', path: GROUPS, body: { name: 'x' }, note: 'probe' })).rejects.toThrow(/probe groups create/);
    expect(server.arrived).toEqual([]);
    core.createAnswer = { status: 201, body: { message: 'created without an id' } };
    const answer = await probeCollectionCreate(api, SPEC, { type: 'groups', path: GROUPS, body: { name: 'no-uuid' }, note: 'probe' });
    expect(answer.status).toBe(201);
    expect(createdLines()).toEqual([]);
});
