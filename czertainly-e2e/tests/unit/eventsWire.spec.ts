/**
 * The events and discovery helpers on the wire: requests go through a real APIRequestContext to a stateful loopback fake core
 * (the pattern of configWire.spec.ts), and each test asserts what ARRIVED — own-object checks before anything is sent, ledger
 * lines before the request (associations) or right after it (creates), platform-level associations and schedules refused
 * without `localStack`, notification deletes recorded only when accepted, discovery creates / controls / onboarded records.
 */
import { APIRequestContext, expect, test } from '@playwright/test';
import { controlDiscovery, createOwnDiscovery, DiscoveryConnector, probeDiscovery, recordOnboarded } from '../../utils/regression/discovery/discoveryApi';
import { scheduleDiscovery } from '../../utils/regression/discovery/discoveryJobs';
import { GuardedApi } from '../../utils/regression/guard/types';
import { createOwnInternalProfile, deleteOwnProfile } from '../../utils/regression/events/notificationProfiles';
import { OwnObjectViolation } from '../../utils/regression/ledger/ownership';
import { OwnRef, readLedger, recordCreated } from '../../utils/regression/ledger/ledger';
import { runName, runId } from '../../utils/regression/ledger/runState';
import { setOwnCustomAttribute } from '../../utils/regression/events/workflowFixtures';
import { associateTriggers, clearAssociation, getAssociations, platformAssociate, probeAssociation } from '../../utils/regression/events/eventAssociations';
import { getPlatformTriggerGate } from '../../utils/regression/events/eventHistory';
import { EVENT } from '../../utils/regression/events/eventVocabulary';
import { createOwnChain } from '../../utils/regression/events/workflowObjects';
import { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';
import { FakeCore as BaseCore } from './helpers/fakeCore';
import { registerFakeCore, rawAsGuarded } from './helpers/guardRig';

type Json = Record<string, any>;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FOREIGN_GROUP = U(901);
const FOREIGN_TRIGGER = U(902);
const FOREIGN_DISCOVERY = U(903);
const EXISTING_CERT = U(911);
const NEW_CERT = U(912);
const NEW_KEY = U(913);
const SPEC = 'eventsWire';

const V2_DEFS = [
    { uuid: 'e-hosts', name: 'data_hosts', contentType: 'string' },
    { uuid: 'e-ports', name: 'data_ports', contentType: 'string' },
    { uuid: 'e-par', name: 'data_parallelExecutions', contentType: 'integer' },
];
const CONNECTOR: DiscoveryConnector = { uuid: U(5), name: 'ip-v2', generation: 'v2', interfaceUuid: U(6) } as DiscoveryConnector;

class EventsCore extends BaseCore {
    readonly assoc = new Map<string, Record<string, string[]>>();
    /** `true` per association POST that arrived while the ledger already held its `eventAssociations` line. */
    readonly recordedBeforeSend: boolean[] = [];
    assocStatus = 204;
    profileDeleteStatus = 204;
    settings: Json = { eventsMapping: {} };
    settingsStatus = 200;
    startTime = '2026-10-14T10:00:00.000+00:00';
    discovered: Json[] = [];
    certificates = new Map<string, Json>();

    protected respond(a: Arrived): Answer | undefined {
        const path = a.url.split('?')[0];
        const body: Json = a.body ? JSON.parse(a.body) : {};
        if (a.method === 'POST') {
            if (path === '/api/v1/workflows/events') {
                this.recordedBeforeSend.push(readLedger().some((l) => l.type === 'eventAssociations'));
                if (this.assocStatus >= 200 && this.assocStatus < 300) {
                    const key = `${body.resource}/${body.objectUuid}`;
                    this.assoc.set(key, { ...(this.assoc.get(key) ?? {}), [body.event]: body.triggerUuids });
                }
                return { status: this.assocStatus, ...(this.assocStatus >= 400 ? { body: ['refused by the fake core'] } : {}) };
            }
            if (path === '/api/v1/discoveries/schedule') return { status: 201, body: { uuid: this.next() } };
            const created = /^\/api\/v1\/(workflows\/(?:conditions|rules|executions|actions|triggers)|notificationProfiles|discoveries)$/.exec(path);
            if (created) {
                const uuid = this.next();
                this.store.set(`${path}/${uuid}`, { uuid, name: body.name, ...(created[1] === 'discoveries' ? { startTime: this.startTime, status: 'inProgress' } : {}) });
                return { status: 201, body: { uuid, name: body.name } };
            }
            return { status: 404 };
        }
        if (a.method === 'GET') {
            if (path === '/api/v1/settings/events') return this.settingsStatus === 200 ? { status: 200, body: this.settings } : { status: this.settingsStatus };
            const as = /^\/api\/v1\/workflows\/events\/([a-zA-Z]+)\/([0-9a-f-]{36})$/.exec(path);
            if (as) return { status: 200, body: this.assoc.get(`${as[1]}/${as[2]}`) ?? {} };
            if (path === `/api/v1/discoveries/${CONNECTOR.uuid}/attributes`) return { status: 200, body: V2_DEFS };
            const certs = /^\/api\/v1\/discoveries\/([0-9a-f-]{36})\/certificates$/.exec(path);
            if (certs) return { status: 200, body: { certificates: this.discovered, totalPages: 1 } };
            const cert = /^\/api\/v1\/certificates\/([0-9a-f-]{36})$/.exec(path);
            if (cert && this.certificates.has(cert[1])) return { status: 200, body: this.certificates.get(cert[1]) };
            return this.store.has(path) ? { status: 200, body: this.store.get(path) } : { status: 404 };
        }
        if (a.method === 'PATCH' && /^\/api\/v1\/discoveries\/[0-9a-f-]{36}\/(stop|resume|cancel)$/.test(path)) return { status: 204 };
        if (a.method === 'PATCH' && /^\/api\/v1\/attributes\/custom\/resources\/certificates\/objects\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(path)) return { status: 200, body: [] };
        if (a.method === 'DELETE') {
            if (/^\/api\/v1\/notificationProfiles\//.test(path)) {
                if (this.profileDeleteStatus === 204) this.store.delete(path);
                return { status: this.profileDeleteStatus, ...(this.profileDeleteStatus >= 400 ? { body: ['Cannot delete profile'] } : {}) };
            }
            if (/^\/api\/v1\/discoveries\//.test(path)) return { status: 204 };
        }
        return { status: 404 };
    }
}

let server: LoopbackServer;
let core: EventsCore;
let raw: APIRequestContext;
let api: GuardedApi;

registerFakeCore(() => core, (rig) => ({ server, raw, api } = rig), {});
test.beforeEach(() => {
    core = new EventsCore();
});

const wire = () => server.mutations().map((a) => `${a.method} ${a.url}`);
const ledgerTypes = () => readLedger().filter((l) => l.event === 'created').map((l) => l.type);

async function refusal(call: Promise<unknown>): Promise<string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? e.kind : `error: ${String(e).slice(0, 200)}`;
    }
}

/** The guard's refusal of a call with its message (a mutant that is refused for ANOTHER reason is caught by the text). */
async function refusalMessage(call: Promise<unknown>): Promise<string> {
    try {
        await call;
        return 'sent';
    } catch (e) {
        return e instanceof OwnObjectViolation ? `${e.kind}: ${e.message}` : `error: ${String(e).slice(0, 200)}`;
    }
}

/** Writes the ledger line of an own group the run "created" and seeds the live object the guard reads (no request is sent). */
function ledgerOwnGroup(): OwnRef {
    const ref = recordCreated('groups', { uuid: U(701), name: runName('group') }, { spec: SPEC });
    core.seed(`/api/v1/groups/${ref.uuid}`, { uuid: ref.uuid, name: ref.name });
    return ref;
}
const stranger = (uuid: string): OwnRef => ({ uuid, name: 'not-this-run', kind: 'own' });

// ------------------------------------------------------------------ workflow chain and associations

test('createOwnChain POSTs condition, rule, execution, action and trigger, each recorded in the ledger; nothing is associated', async () => {
    const chain = await createOwnChain(api, SPEC, 'wire', { items: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'EQUALS', value: 'x' }], executionItems: [] });
    expect(wire()).toEqual([
        'POST /api/v1/workflows/conditions', 'POST /api/v1/workflows/rules', 'POST /api/v1/workflows/executions', 'POST /api/v1/workflows/actions', 'POST /api/v1/workflows/triggers',
    ]);
    expect(ledgerTypes()).toEqual(['conditions', 'rules', 'executions', 'actions', 'triggers']);
    const trigger = JSON.parse(server.arrived.find((a) => a.url === '/api/v1/workflows/triggers')!.body);
    expect(trigger).toMatchObject({ type: 'event', event: 'certificate_action_performed', rulesUuids: [chain.rule!.uuid], actionsUuids: [chain.action!.uuid] });
    expect(chain.trigger.name.startsWith(`${runId()}-`)).toBe(true);
});

test('an ignore chain has no action and a chain without items has no rule', async () => {
    const ignore = await createOwnChain(api, SPEC, 'ign', { ignore: true, items: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'EQUALS', value: 'x' }] });
    expect(ignore.action).toBeUndefined();
    expect(ledgerTypes()).toEqual(['conditions', 'rules', 'triggers']);
    server.reset();
    const bare = await createOwnChain(api, SPEC, 'bare', { executionItems: [] });
    expect(bare.rule).toBeUndefined();
    expect(wire()).toEqual(['POST /api/v1/workflows/executions', 'POST /api/v1/workflows/actions', 'POST /api/v1/workflows/triggers']);
});

test('associateTriggers: the ledger line exists before the POST leaves; the body is the replace-all; the map reads back', async () => {
    const group = ledgerOwnGroup();
    const { trigger } = await createOwnChain(api, SPEC, 'assoc', { ignore: true });
    const sent = await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [trigger] });
    expect(sent.status).toBe(204);
    expect(core.recordedBeforeSend).toEqual([true]);
    const body = JSON.parse(server.arrived.find((a) => a.url === '/api/v1/workflows/events')!.body);
    expect(body).toEqual({ event: 'certificate_action_performed', resource: 'groups', objectUuid: group.uuid, triggerUuids: [trigger.uuid] });
    const line = readLedger().find((l) => l.type === 'eventAssociations')!;
    expect(line.note).toContain(`certificate_action_performed|groups|${group.uuid} `);
    expect(line.parents?.object).toBe(group.uuid);
    expect(await getAssociations(api, 'groups', group.uuid)).toEqual({ certificate_action_performed: [trigger.uuid] });
});

test('associating twice records one ledger line per (event, resource, object); clearing sends an empty list', async () => {
    const group = ledgerOwnGroup();
    const { trigger } = await createOwnChain(api, SPEC, 'twice', { ignore: true });
    await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [trigger] });
    await associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [trigger] });
    expect(readLedger().filter((l) => l.type === 'eventAssociations')).toHaveLength(1);
    await clearAssociation(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group });
    const bodies = server.arrived.filter((a) => a.url === '/api/v1/workflows/events').map((a) => JSON.parse(a.body));
    expect(bodies[2]).toMatchObject({ triggerUuids: [] });
    expect(await getAssociations(api, 'groups', group.uuid)).toEqual({ certificate_action_performed: [] });
});

test('a foreign group or a foreign trigger is refused before anything is sent', async () => {
    const group = ledgerOwnGroup();
    const { trigger } = await createOwnChain(api, SPEC, 'foreign', { ignore: true });
    server.reset();
    // The refusal kind is the evidence (a mutant that lets the call through, or one that fails for another reason, is caught here).
    expect(await refusal(associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: stranger(FOREIGN_GROUP), triggers: [trigger] })), 'a foreign scope object').toBe('ownership');
    expect(await refusal(associateTriggers(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggers: [stranger(FOREIGN_TRIGGER)] })), 'a foreign trigger').toBe('ownership');
    expect(server.mutations(), 'nothing left the runner').toEqual([]);
    expect(readLedger().filter((l) => l.type === 'eventAssociations'), 'no association line for a refused scope').toHaveLength(0);
});

test('probeAssociation: a probe trigger uuid passes the guard; a refusal records nothing, an accepted one records the scope', async () => {
    const group = ledgerOwnGroup();
    core.assocStatus = 422;
    const refused = await probeAssociation(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggerUuids: [api.probeUuid()] });
    expect(refused.status).toBe(422);
    expect(readLedger().filter((l) => l.type === 'eventAssociations')).toHaveLength(0);
    core.assocStatus = 204;
    const accepted = await probeAssociation(api, SPEC, { event: EVENT.actionPerformed, resource: 'groups', object: group, triggerUuids: [api.probeUuid()] });
    expect(accepted.status).toBe(204);
    expect(readLedger().filter((l) => l.type === 'eventAssociations')).toHaveLength(1);
});

test('a PLATFORM-level association is refused without localStack: only the own-trigger reads leave the runner', async () => {
    const { trigger } = await createOwnChain(api, SPEC, 'platform', { ignore: true });
    server.reset();
    const outcome = await refusalMessage(platformAssociate(api, SPEC, EVENT.uploaded, [trigger]));
    expect(outcome, 'the platform-level route is refused by the guard, not by something else').toMatch(/^request: .*platform-level/);
    expect(server.mutations()).toEqual([]);
});

test('scheduling a discovery (a platform endpoint) is refused without localStack: nothing is sent', async () => {
    server.reset();
    const outcome = await refusalMessage(scheduleDiscovery(api, SPEC, CONNECTOR, { suffix: 'sched', cron: '0 0 0 1 1 ? 2099', oneTime: true, target: { hosts: ['192.0.2.1'] } }));
    expect(outcome, 'a schedule is a platform route: refused by the guard').toMatch(/^request: .*platform-level/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ notification profiles

test('an internal-only profile is POSTed without an instance and recorded; a delete is recorded only when the platform accepted it', async () => {
    const profile = await createOwnInternalProfile(api, SPEC, 'np', { recipientType: 'owner' });
    const body = JSON.parse(server.arrived.find((a) => a.url === '/api/v1/notificationProfiles')!.body);
    expect(body).toMatchObject({ recipientType: 'owner', internalNotification: true });
    expect('notificationInstanceUuid' in body).toBe(false);
    expect(ledgerTypes()).toEqual(['notificationProfiles']);
    core.profileDeleteStatus = 422;
    expect((await deleteOwnProfile(api, profile, SPEC)).status).toBe(422);
    expect(readLedger().filter((l) => l.event === 'deleted')).toHaveLength(0);
    core.profileDeleteStatus = 204;
    expect((await deleteOwnProfile(api, profile, SPEC)).status).toBe(204);
    expect(readLedger().filter((l) => l.event === 'deleted').map((l) => l.type)).toEqual(['notificationProfiles']);
});

// ------------------------------------------------------------------ discovery

test('createOwnDiscovery (v2): the body follows the live definitions, the run is recorded with the server clock; controls pass for own / probe uuids only', async () => {
    const run = await createOwnDiscovery(api, SPEC, 'disc', { connector: CONNECTOR, target: { hosts: ['192.0.2.0/24'], ports: ['443'], parallel: 2 } });
    const body = JSON.parse(server.arrived.find((a) => a.method === 'POST' && a.url === '/api/v1/discoveries')!.body);
    expect(body).toMatchObject({ connectorUuid: CONNECTOR.uuid, interfaceUuid: CONNECTOR.interfaceUuid, resources: ['certificates'] });
    expect(body.attributes.map((x: Json) => x.name)).toEqual(['data_hosts', 'data_ports', 'data_parallelExecutions']);
    expect(body.attributes.every((x: Json) => x.version === 'v3')).toBe(true);
    const line = readLedger().find((l) => l.type === 'discoveries')!;
    expect(line.uuid).toBe(run.uuid);
    expect(typeof line.serverAt).toBe('string');

    server.reset();
    expect((await controlDiscovery(api, run.uuid, 'stop')).status).toBe(204);
    expect((await controlDiscovery(api, api.probeUuid(), 'resume')).status).toBe(204);
    expect(await refusal(controlDiscovery(api, FOREIGN_DISCOVERY, 'cancel')), 'a run of somebody else').toBe('ownership');
    expect(wire()).toHaveLength(2);
});

test('a discovery create probe with an accepted answer records the run under the own prefix', async () => {
    const name = runName('probe-disc');
    const sent = await probeDiscovery(api, SPEC, { name, connectorUuid: CONNECTOR.uuid, interfaceUuid: CONNECTOR.interfaceUuid, resources: ['certificates'], attributes: [] });
    expect(sent.status).toBe(201);
    expect(readLedger().filter((l) => l.type === 'discoveries').map((l) => l.name)).toEqual([name]);
});

test('recordOnboarded records the NEW certificates (and their keys) as derived lines with a server clock, never an EXISTING row; idempotent', async () => {
    const run = await createOwnDiscovery(api, SPEC, 'onboard', { connector: CONNECTOR, target: { hosts: ['192.0.2.1'] } });
    core.discovered = [
        { uuid: U(1), inventoryUuid: NEW_CERT, commonName: 'new.example.test', newlyDiscovered: true, processed: true },
        { uuid: U(2), inventoryUuid: EXISTING_CERT, commonName: 'old.example.test', newlyDiscovered: false, processed: true },
    ];
    // the fake only filters by the query's flag: serve the NEW row for newlyDiscovered=true
    const answer = core.answer;
    core.answer = (a) => (/\/certificates\?/.test(a.url) && /newlyDiscovered=true/.test(a.url) ? { status: 200, body: { certificates: core.discovered.filter((r) => r.newlyDiscovered), totalPages: 1 } } : answer(a));
    core.certificates.set(NEW_CERT, { uuid: NEW_CERT, key: { uuid: NEW_KEY } });
    const first = await recordOnboarded(api, SPEC, run);
    expect(first).toEqual([NEW_CERT]);
    const derived = readLedger().filter((l) => l.derived);
    expect(derived.map((l) => [l.type, l.uuid])).toEqual([['certificates', NEW_CERT], ['keys', NEW_KEY]]);
    expect(derived.every((l) => typeof l.createdAfter === 'string' && Date.parse(l.createdAfter!) < Date.parse(core.startTime))).toBe(true);
    expect(derived[0].parents).toMatchObject({ discovery: run.uuid });
    expect(derived.some((l) => l.uuid === EXISTING_CERT)).toBe(false);
    await recordOnboarded(api, SPEC, run);
    expect(readLedger().filter((l) => l.derived)).toHaveLength(2);
});

// ------------------------------------------------------------------ custom attribute value, platform trigger gate

test('setOwnCustomAttribute PATCHes the attribute endpoint with the content list; a foreign certificate or attribute is refused before anything leaves', async () => {
    const cert = recordCreated('certificates', { uuid: U(801), name: runName('cert') }, { spec: SPEC });
    const attr = recordCreated('customAttributes', { uuid: U(802), name: runName('attr') }, { spec: SPEC });
    core.seed(`/api/v1/certificates/${cert.uuid}`, { uuid: cert.uuid, commonName: cert.name });
    core.seed(`/api/v1/attributes/custom/${attr.uuid}`, { uuid: attr.uuid, name: attr.name });
    const sent = await setOwnCustomAttribute(api, cert, { ...attr, attributeName: attr.name, contentType: 'string' }, 'v1');
    expect(sent.status).toBe(200);
    const arrived = server.mutations();
    expect(arrived.map((a) => `${a.method} ${a.url}`)).toEqual([`PATCH /api/v1/attributes/custom/resources/certificates/objects/${cert.uuid}/${attr.uuid}`]);
    expect(JSON.parse(arrived[0].body), 'the content list of the value (not a certificate DTO field)').toEqual([{ data: 'v1' }]);

    server.reset();
    const foreign = { ...attr, uuid: U(803), attributeName: 'x', contentType: 'string' };
    expect(await refusal(setOwnCustomAttribute(api, cert, foreign, 'v1')), 'a foreign attribute').toBe('ownership');
    expect(await refusal(setOwnCustomAttribute(api, stranger(U(804)), { ...attr, attributeName: attr.name, contentType: 'string' }, 'v1')), 'a foreign certificate').toBe('ownership');
    expect(server.mutations()).toEqual([]);
});

test('getPlatformTriggerGate: names the occupied events, passes an empty list, and skips when the settings cannot be read', async () => {
    expect(await getPlatformTriggerGate(api, [EVENT.actionPerformed, EVENT.statusChanged])).toBeUndefined();
    core.settings = { eventsMapping: { [EVENT.actionPerformed]: [U(1)], [EVENT.uploaded]: [U(2)] } };
    const gate = await getPlatformTriggerGate(api, [EVENT.actionPerformed, EVENT.statusChanged]);
    expect(gate).toMatch(/^platform-level trigger\(s\) already listen on Certificate action performed;/);
    expect(gate, 'an event the row does not use is not named').not.toMatch(/uploaded/i);
    expect(await getPlatformTriggerGate(api, [EVENT.statusChanged]), 'the occupied event is not one of the row\'s').toBeUndefined();
    core.settings = undefined as unknown as Json;
    core.settingsStatus = 403;
    expect(await getPlatformTriggerGate(api, [EVENT.actionPerformed])).toMatch(/could not be read \(answer 403\)/);
    expect(server.mutations(), 'only reads').toEqual([]);
});

test('a raw context handed to a mutating events helper is refused (not guarded), nothing is sent', async () => {
    server.reset();
    const outcome = await refusal(createOwnChain(rawAsGuarded(raw), SPEC, 'raw', { ignore: true }));
    expect(outcome, 'a raw context is refused as not-guarded').toBe('not-guarded');
    expect(server.mutations()).toEqual([]);
});
