/**
 * Events / discovery area (ilm#424 Phase 7): the run-end teardown handlers of the area's ledger types, driven the way
 * runTeardown loads them (HANDLER_MODULES → ../workflowUtils, ../notificationUtils; wrapped by guardHandler) against an in-memory
 * core, the pattern of teardownHandlers.spec.ts:
 * - workflow objects (triggers / rules / conditions / executions / actions) and notification profiles / instances: the live object is
 *   read, deleted, and its absence proven by a GET; a foreign (renamed) object is refused and nothing is deleted;
 * - `eventAssociations` (id-named): an association of an OWN scope listing OWN triggers is cleared (empty replace) and proven by the
 *   association map; an empty scope is a no-op; a scope that lists a foreign trigger, a foreign scope object or a line without an
 *   object is refused and nothing is sent; a platform line is never cleared (only proven absent, read-only);
 * - the DELETE_ORDER of step 7 (guard request G-1, in the events patches README): the order the teardown plans today puts an
 *   execution BEFORE the action that uses it, which core refuses; the guard pass fixed the order and the test below pins it.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { LiveObjectMissing, OwnObjectViolation } from '../../utils/regression/ownObjects';
import { LedgerLine } from '../../utils/regression/regressionRun';
import { DELETE_ORDER, handlerFor, planTeardown, TeardownContext, TeardownHandler } from '../../utils/regression/runTeardown';

const RUN = 'qa-reg-20261014-120000-ab12';
type Json = Record<string, any>;
interface Reply {
    status: number;
    body?: unknown;
}

class FakeCore {
    store = new Map<string, Json>();
    calls: string[] = [];
    posts: Json[] = [];
    settings: Json = { eventsMapping: {} };
    /** `<resource>/<uuid>` → event → trigger uuids. */
    assoc = new Map<string, Record<string, string[]>>();
    /** The clear answers 2xx but changes nothing (a core that accepted the replace without applying it). */
    clearsNothing = false;

    set(path: string, body: Json): this {
        this.store.set(path, body);
        return this;
    }

    private handle(method: string, url: string, data: unknown): Reply {
        const path = url.split('?')[0];
        this.calls.push(`${method} ${path}`);
        if (method === 'GET' && path === '/api/v1/settings/events') return { status: 200, body: this.settings };
        const as = /^\/api\/v1\/workflows\/events\/([a-zA-Z]+)\/([^/]+)$/.exec(path);
        if (method === 'GET' && as) return this.assoc.has(`${as[1]}/${as[2]}`) ? { status: 200, body: this.assoc.get(`${as[1]}/${as[2]}`) } : { status: 404 };
        if (method === 'POST' && path === '/api/v1/workflows/events') {
            const d = data as Json;
            this.posts.push(d);
            if (!this.clearsNothing) this.assoc.set(`${d.resource}/${d.objectUuid}`, { ...(this.assoc.get(`${d.resource}/${d.objectUuid}`) ?? {}), [d.event]: d.triggerUuids });
            return { status: 204 };
        }
        if (method === 'GET') return this.store.has(path) ? { status: 200, body: this.store.get(path) } : { status: 404 };
        if (method === 'DELETE') {
            if (!this.store.has(path)) return { status: 404 };
            this.store.delete(path);
            return { status: 204 };
        }
        return { status: 404 };
    }

    api(): APIRequestContext {
        const resp = (r: Reply) => ({ status: () => r.status, ok: () => r.status >= 200 && r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body ?? '') });
        const call = (method: string) => async (url: string, opts?: { data?: unknown }) => resp(this.handle(method, url, opts?.data));
        return { get: call('GET'), post: call('POST'), patch: call('PATCH'), put: call('PUT'), delete: call('DELETE'), dispose: async () => undefined } as unknown as APIRequestContext;
    }

    mutations(): string[] {
        return this.calls.filter((c) => !c.startsWith('GET '));
    }
}

let seq = 0;
const line = (type: string, over: Partial<LedgerLine> = {}): LedgerLine => {
    seq++;
    return { at: '2026-10-14T12:00:00.000Z', runId: RUN, type, name: `${RUN}-${type}-${seq}`, uuid: `${type}-${seq}`, spec: 'T', event: 'created', ...over };
};
const assocLine = (event: string, resource: string, object: LedgerLine, over: Partial<LedgerLine> = {}): LedgerLine =>
    line('eventAssociations', { note: `${event}|${resource}|${object.uuid} object-level association`, parents: { object: object.uuid }, ...over });

const ENV_KEYS = ['REG_STATE_DIR', 'REG_RUN_ID', 'API_TEARDOWN_DRY_RUN'];
let saved: Record<string, string | undefined> = {};
test.beforeEach(({}, testInfo) => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
});
test.afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

async function run(core: FakeCore, l: LedgerLine, ledger: LedgerLine[] = [l]): Promise<{ error?: unknown }> {
    const h = handlerFor(l.type) as TeardownHandler;
    expect(h, `handler for ${l.type}`).toBeTruthy();
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger, seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
    try {
        await h.remove(ctx, l);
        return {};
    } catch (error) {
        return { error };
    }
}

// ------------------------------------------------------------------ workflow objects and notifications

const BY_URL: Array<[string, string]> = [
    ['triggers', '/api/v1/workflows/triggers'], ['rules', '/api/v1/workflows/rules'], ['conditions', '/api/v1/workflows/conditions'],
    ['executions', '/api/v1/workflows/executions'], ['actions', '/api/v1/workflows/actions'],
    ['notificationProfiles', '/api/v1/notificationProfiles'], ['notificationInstances', '/api/v1/notificationInstances'],
];

for (const [type, base] of BY_URL) {
    test(`${type}: read live, deleted, absence proven by GET; a renamed (foreign) object is refused and kept`, async () => {
        const l = line(type);
        const core = new FakeCore().set(`${base}/${l.uuid}`, { uuid: l.uuid, name: l.name });
        expect((await run(core, l)).error).toBeUndefined();
        expect(core.calls).toEqual([`GET ${base}/${l.uuid}`, `DELETE ${base}/${l.uuid}`, `GET ${base}/${l.uuid}`]);

        const foreign = new FakeCore().set(`${base}/${l.uuid}`, { uuid: l.uuid, name: 'Somebody Else' });
        const { error } = await run(foreign, l);
        expect(error).toBeInstanceOf(OwnObjectViolation);
        expect(foreign.mutations()).toEqual([]);
    });
}

test('a workflow object that is not there is "route or object missing", never "deleted"', async () => {
    const l = line('rules');
    const core = new FakeCore();
    expect((await run(core, l)).error).toBeInstanceOf(LiveObjectMissing);
    expect(core.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ eventAssociations

test('an own scope listing own triggers is cleared with an empty replace and proven by the association map', async () => {
    const group = line('groups');
    const trigger = line('triggers');
    const l = assocLine('certificate_action_performed', 'groups', group);
    const core = new FakeCore();
    core.assoc.set(`groups/${group.uuid}`, { certificate_action_performed: [trigger.uuid] });
    const { error } = await run(core, l, [group, trigger, l]);
    expect(error).toBeUndefined();
    expect(core.posts).toEqual([{ event: 'certificate_action_performed', resource: 'groups', objectUuid: group.uuid, triggerUuids: [] }]);
    expect(core.assoc.get(`groups/${group.uuid}`)).toEqual({ certificate_action_performed: [] });
});

test('the post-clear absence proof: a clear that answers 2xx but leaves the trigger listed fails the step (the map is the oracle, not the status)', async () => {
    const group = line('groups');
    const trigger = line('triggers');
    const l = assocLine('certificate_action_performed', 'groups', group);
    const core = new FakeCore();
    core.clearsNothing = true;
    core.assoc.set(`groups/${group.uuid}`, { certificate_action_performed: [trigger.uuid] });
    const { error } = await run(core, l, [group, trigger, l]);
    expect(String(error)).toMatch(/still lists 1 trigger\(s\) after the clear \(absence not proven\)/);
    expect(core.posts, 'the clear was sent').toHaveLength(1);
});

test('an already empty scope is a no-op: nothing is sent', async () => {
    const group = line('groups');
    const l = assocLine('certificate_action_performed', 'groups', group);
    const core = new FakeCore();
    core.assoc.set(`groups/${group.uuid}`, {});
    expect((await run(core, l, [group, l])).error).toBeUndefined();
    expect(core.mutations()).toEqual([]);
});

test('a scope that lists a trigger this run did not create is refused and left as it is', async () => {
    const group = line('groups');
    const l = assocLine('certificate_action_performed', 'groups', group);
    const core = new FakeCore();
    core.assoc.set(`groups/${group.uuid}`, { certificate_action_performed: ['not-ours-1'] });
    const { error } = await run(core, l, [group, l]);
    expect(String(error)).toMatch(/lists trigger not-ours-1, which this run did not create/);
    expect(core.mutations()).toEqual([]);
});

test('a scope object that is not a live object of this run is refused (the line names a foreign object)', async () => {
    const stranger = line('groups', { runId: 'qa-reg-20200101-000000-zzzz' });
    const l = assocLine('certificate_action_performed', 'groups', stranger);
    const core = new FakeCore();
    core.assoc.set(`groups/${stranger.uuid}`, { certificate_action_performed: ['t-1'] });
    const { error } = await run(core, l, [l]);
    expect(String(error)).toMatch(/is not a live object of this run/);
    expect(core.mutations()).toEqual([]);
});

test('a line without an object (or whose object differs from its note) is refused, nothing is read or sent', async () => {
    const group = line('groups');
    const noParent = assocLine('certificate_action_performed', 'groups', group, { parents: undefined });
    const core = new FakeCore();
    expect(String((await run(core, noParent, [group, noParent])).error)).toMatch(/names no \(event, resource, object\)/);
    const mismatch = assocLine('certificate_action_performed', 'groups', group, { parents: { object: 'someone-else' } });
    expect(String((await run(core, mismatch, [group, mismatch])).error)).toMatch(/names no \(event, resource, object\)/);
    const garbled = line('eventAssociations', { note: 'free text' });
    expect(String((await run(core, garbled, [garbled])).error)).toMatch(/names no \(event, resource, object\)/);
    expect(core.calls).toEqual([]);
});

test('a platform line is never cleared: absence is proven read-only; a still-bound own trigger fails the step, a foreign one is not ours', async () => {
    const trigger = line('triggers');
    const l = line('eventAssociations', { note: 'certificate_uploaded|platform|- platform-level association (local only)' });
    const free = new FakeCore();
    free.settings = { eventsMapping: { certificate_uploaded: ['someone-elses-trigger'] } };
    expect((await run(free, l, [trigger, l])).error).toBeUndefined();
    expect(free.calls).toEqual(['GET /api/v1/settings/events']);

    const bound = new FakeCore();
    bound.settings = { eventsMapping: { certificate_uploaded: [trigger.uuid] } };
    const { error } = await run(bound, l, [trigger, l]);
    expect(String(error)).toMatch(/still bound to certificate_uploaded platform-wide/);
    expect(bound.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ order of the teardown

test('the planned order puts associations before triggers, triggers before rules, notification profiles before instances', () => {
    const lines = [
        line('notificationInstances'), line('rules'), line('triggers'), line('notificationProfiles'), line('conditions'),
        assocLine('certificate_action_performed', 'groups', line('groups')),
    ];
    const plan = planTeardown(lines, RUN, handlerFor).map((p) => p.line?.type ?? (p as Json).type);
    const at = (t: string) => plan.indexOf(t);
    expect(at('eventAssociations')).toBeLessThan(at('triggers'));
    expect(at('triggers')).toBeLessThan(at('rules'));
    expect(at('rules')).toBeLessThan(at('conditions'));
    expect(at('notificationProfiles')).toBeLessThan(at('notificationInstances'));
});

// Guard request G-1 (GD-04, merged 2026-10-15): the guard pass's DELETE_ORDER deletes triggers -> rules -> conditions -> actions ->
// executions, then notification profiles -> instances. The step numbers belong to the guard pass (runTeardown.spec pins them), so
// this test finds the steps by type.
test('guard request G-1 (guard pass): DELETE_ORDER deletes actions before the executions they use, then notification profiles before instances', () => {
    const stepOf = (t: string) => DELETE_ORDER.find((s) => s.types.includes(t))!;
    const chain = DELETE_ORDER.find((s) => s.types.includes('actions'))!;
    expect(chain.types).toEqual(['triggers', 'rules', 'conditions', 'actions', 'executions']);
    expect(stepOf('notificationProfiles').types).toEqual(['notificationProfiles', 'notificationInstances']);
    expect(stepOf('notificationProfiles').step).toBeGreaterThan(chain.step);
});
