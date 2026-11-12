/**
 * sharedNeeds — the needs that read the tier or the runner settings, each answered met / unmet / failed read.
 *
 * WHAT: `crypto-v2`, `platform-triggers-free`, `metadata-field`, `scep-https`, `registration-settings`, `required-attributes-fillable`,
 * `bearer-token`, `openapi-document` and the extended `ca` (a healthy authority can be picked), resolved through `resolveNeed` against a
 * loopback fake core. Each need is shown with a tier that meets it (undefined), a tier that does not (the named reason) and a read that
 * fails (the resolver throws: the test fails, it does not skip). The options of the three parametrised needs change the answer. No
 * resolver sends anything but a GET.
 * WHY: a skip decided from a read the suite could not make hides a broken tier behind a green run, and a skip that comes after the first
 * create leaves objects behind; the needs are what the `needs` fixture resolves before any write.
 * HOW: a fake core answers the GET routes the test sets (404 for every other path); the run state and the environment are the test's own.
 */
import * as fs from 'fs';
import { expect, test } from '@playwright/test';
import type { TestEnv } from '../../utils/env';
import type { GuardedApi } from '../../utils/regression/guard/types';
import { updateRunState } from '../../utils/regression/ledger/runState';
import { needsApi } from '../../fixtures/regressionFixtures';
import { requireKeyChain } from '../../utils/regression/platform/keyChain';
import { EVENT } from '../../utils/regression/events/eventVocabulary';
import { resolveNeed, resolveNeeds, type NeedOptions } from '../../utils/regression/needs';
import type { Needs } from '../../utils/regression/tags';
import { FakeCore, type Json } from './helpers/fakeCore';
import { FakeCoreRig, registerFakeCore } from './helpers/guardRig';
import type { Answer, Arrived, LoopbackServer } from './helpers/loopbackServer';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENV_KEYS = ['REG_OPENAPI_FILE', 'REG_CRYPTO_CONNECTOR_V2', 'REG_CA_CONNECTORS', 'REG_ADCS_CONNECTOR', 'REG_RA_PROFILE_NAME'];

/** A fake core whose GET answers the test sets by path; every other path is a 404. */
class NeedsCore extends FakeCore {
    readonly routes = new Map<string, Answer>();

    serve(path: string, body: unknown, status = 200): void {
        this.routes.set(path, { status, body });
    }

    protected route(a: Arrived, path: string): Answer | undefined {
        return a.method === 'GET' ? this.routes.get(path) : undefined;
    }
}

let core: NeedsCore;
let server: LoopbackServer;
let api: GuardedApi;
test.beforeEach(() => {
    core = new NeedsCore();
});
registerFakeCore(() => core, (rig: FakeCoreRig) => ({ server, api } = rig), { clear: ENV_KEYS });

const env = (authMode: string = 'local'): TestEnv => ({ baseUrl: process.env.BASE_URL, authMode, username: 'admin', password: 'unused' }) as TestEnv;
const need = (name: Needs, options?: NeedOptions, authMode?: string) => resolveNeed(name, { api, env: env(authMode), options });

// ------------------------------------------------------------------ crypto-v2

const CRYPTO = '/api/v1/connectors';
function serveCryptoConnector(version: string): void {
    core.serve(CRYPTO, [{ uuid: U(1), name: 'Software-Cryptography-Provider-v2', status: 'connected' }]);
    core.serve(`/api/v2/connectors/${U(1)}`, { uuid: U(1), version });
}

test('crypto-v2 is met by a connected v2 cryptography connector, unmet without one, and fails on an unreadable list', async () => {
    serveCryptoConnector('v2');
    expect(await need('crypto-v2')).toBeUndefined();
    serveCryptoConnector('v1');
    expect(await need('crypto-v2'), 'a v1 connector is no v2 connector').toMatch(/^no connected software cryptography connector of interface v2 /);
    core.serve(CRYPTO, []);
    expect(await need('crypto-v2')).toMatch(/REG_CRYPTO_CONNECTOR_V2/);
    core.serve(CRYPTO, { message: 'down' }, 500);
    await expect(need('crypto-v2')).rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ platform-triggers-free

test('platform-triggers-free looks at the events of the call, names the occupied ones, and fails on an unreadable setting', async () => {
    core.serve('/api/v1/settings/events', { eventsMapping: {} });
    expect(await need('platform-triggers-free')).toBeUndefined();
    core.serve('/api/v1/settings/events', { eventsMapping: { [EVENT.registered]: [U(2)] } });
    expect(await need('platform-triggers-free'), 'a tag declares no events: all of them count').toMatch(/^platform-level trigger\(s\) already listen on Certificate registered/);
    expect(await need('platform-triggers-free', { events: [EVENT.registered] })).toMatch(/Certificate registered/);
    expect(await need('platform-triggers-free', { events: [EVENT.actionPerformed, EVENT.statusChanged] }), 'an occupied event the row does not watch').toBeUndefined();
    core.serve('/api/v1/settings/events', { message: 'forbidden' }, 403);
    await expect(need('platform-triggers-free', { events: [EVENT.registered] }), 'a read error is a failure, never a skip').rejects.toThrow(/→ 403.*could not be read/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ metadata-field

test('metadata-field is met by a metadata group in the certificate filter catalogue, unmet without one, and fails on an unreadable catalogue', async () => {
    const field = { fieldIdentifier: 'owner|string', fieldLabel: 'Owner', type: 'string', conditions: ['EQUALS'] };
    core.serve('/api/v1/certificates/search', [{ filterFieldSource: 'property', searchFieldData: [field] }, { filterFieldSource: 'meta', searchFieldData: [field] }]);
    expect(await need('metadata-field')).toBeUndefined();
    core.serve('/api/v1/certificates/search', [{ filterFieldSource: 'property', searchFieldData: [field] }, { filterFieldSource: 'meta', searchFieldData: [] }]);
    expect(await need('metadata-field'), 'a metadata group with no field').toMatch(/^the tier offers no metadata field for certificates/);
    core.serve('/api/v1/certificates/search', [{ filterFieldSource: 'property', searchFieldData: [field] }]);
    expect(await need('metadata-field')).toMatch(/no metadata field/);
    core.serve('/api/v1/certificates/search', { message: 'down' }, 503);
    await expect(need('metadata-field')).rejects.toThrow(/answered 503/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ scep-https

const RA = { uuid: U(4), name: 'run-ra', kind: 'own' as const, authorityUuid: U(5) };
const ACME_READ = `/api/v1/authorities/${RA.authorityUuid}/raProfiles/${RA.uuid}/protocols/acme`;

test('scep-https is decided from the protocol URL the server already reports, and met when no URL can be read before the rig writes', async () => {
    expect(await need('scep-https'), 'no run RA profile: nothing to read, the rig keeps its own check').toBeUndefined();
    updateRunState({ raProfile: RA });
    expect(await need('scep-https'), 'ACME is not activated on the run RA profile').toBeUndefined();
    expect(server.arrived, 'and nothing was read').toEqual([]);
    updateRunState({ acmeActivatedOn: RA.uuid });
    core.serve(ACME_READ, { acmeAvailable: true, directoryUrl: 'http://core.invalid/api/v1/protocols/acme/ra/directory' });
    expect(await need('scep-https')).toBeUndefined();
    core.serve(ACME_READ, { acmeAvailable: true, directoryUrl: 'https://core.invalid/api/v1/protocols/acme/ra/directory' });
    expect(await need('scep-https')).toMatch(/^the protocol URLs the server reports are https: classic sscep speaks plain HTTP only/);
    core.serve(ACME_READ, { message: 'gone' }, 404);
    expect(await need('scep-https'), 'the run RA profile is gone: no URL to read').toBeUndefined();
    core.serve(ACME_READ, { message: 'down' }, 500);
    await expect(need('scep-https'), 'any other read error fails the test').rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ registration-settings

const PLATFORM = '/api/v1/settings/platform';
const registration = (maxFailedAttempts: number, defaultIssuanceWindowDays: number): Json => ({ certificates: { registration: { maxFailedAttempts, defaultIssuanceWindowDays } } });

test('registration-settings needs a window and enough failed attempts for the row, and fails on an unreadable setting', async () => {
    core.serve(PLATFORM, registration(5, 7));
    expect(await need('registration-settings')).toBeUndefined();
    expect(await need('registration-settings', { minFailedAttempts: 3 })).toBeUndefined();
    expect(await need('registration-settings', { minFailedAttempts: 6 })).toMatch(/maxFailedAttempts 5, window 7 days\) cannot hold the registration of this row \(needs maxFailedAttempts of at least 6\)/);
    core.serve(PLATFORM, registration(0, 7));
    expect(await need('registration-settings')).toMatch(/needs maxFailedAttempts of at least 1/);
    core.serve(PLATFORM, registration(5, 0));
    expect(await need('registration-settings')).toMatch(/needs a default issuance window of at least one day/);
    core.serve(PLATFORM, {});
    expect(await need('registration-settings'), 'unset values are the platform defaults (7 days, 5 attempts)').toBeUndefined();
    core.serve(PLATFORM, { message: 'down' }, 500);
    await expect(need('registration-settings')).rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ required-attributes-fillable

const ATTRIBUTES = (resource: string): string => `/api/v1/attributes/custom/resources/${resource}`;
const required = (contentType: string): Json => ({ uuid: U(6), name: 'owner', contentType, properties: { required: true } });

test('required-attributes-fillable skips only for an attribute type the suite cannot fill, and fails on an unreadable definition list', async () => {
    core.serve(ATTRIBUTES('certificates'), [required('string')]);
    core.serve(ATTRIBUTES('raProfiles'), []);
    expect(await need('required-attributes-fillable'), 'a required string attribute is filled').toBeUndefined();
    core.serve(ATTRIBUTES('raProfiles'), [required('x509')]);
    expect(await need('required-attributes-fillable')).toMatch(/^a required custom attribute of raProfiles cannot be filled by the suite \(required custom attribute .* content type x509/);
    expect(await need('required-attributes-fillable', { resources: ['certificates'] }), 'the row names its own resources').toBeUndefined();
    expect(await need('required-attributes-fillable', { resources: ['raProfiles'] })).toMatch(/raProfiles/);
    core.serve(ATTRIBUTES('certificates'), { message: 'down' }, 500);
    await expect(need('required-attributes-fillable', { resources: ['certificates'] })).rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ bearer-token

test('bearer-token is unmet on a header-mode stack and met otherwise; it reads nothing', async () => {
    expect(await need('bearer-token', undefined, 'local')).toBeUndefined();
    expect(await need('bearer-token', undefined, 'header')).toMatch(/^no bearer token on AUTH_MODE=header/);
    expect(server.arrived).toEqual([]);
});

// ------------------------------------------------------------------ utils-service

test('utils-service is met by a configured utils service URL, unmet without one, and fails on an unreadable setting', async () => {
    const SETTINGS = '/api/v1/settings/platform';
    core.serve(SETTINGS, { utils: { utilsServiceUrl: 'http://utils.example:8080' } });
    expect(await need('utils-service')).toBeUndefined();
    core.serve(SETTINGS, { utils: {} });
    expect(await need('utils-service')).toMatch(/configure no utils service/);
    core.serve(SETTINGS, {});
    expect(await need('utils-service')).toMatch(/configure no utils service/);
    core.serve(SETTINGS, { message: 'down' }, 500);
    await expect(need('utils-service')).rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

// ------------------------------------------------------------------ openapi-document

test('openapi-document is met by a readable OpenAPI 3 file, unmet for no file or an unusable one, and fails when the file cannot be read', async ({}, testInfo) => {
    expect(await need('openapi-document'), 'REG_OPENAPI_FILE unset').toMatch(/^REG_OPENAPI_FILE is not set/);
    process.env.REG_OPENAPI_FILE = testInfo.outputPath('missing.json');
    expect(await need('openapi-document')).toMatch(/names a file that cannot be read/);
    const file = testInfo.outputPath('openapi.json');
    process.env.REG_OPENAPI_FILE = file;
    fs.writeFileSync(file, JSON.stringify({ openapi: '3.0.1', paths: { '/v1/x': {} } }));
    expect(await need('openapi-document')).toBeUndefined();
    fs.writeFileSync(file, '{ not json');
    expect(await need('openapi-document'), 'a file that is no OpenAPI document').toMatch(/^REG_OPENAPI_FILE: the file is not JSON/);
    // The path exists (stat works) but cannot be read as a file: not "not set up", an error of the run.
    process.env.REG_OPENAPI_FILE = testInfo.outputPath('');
    await expect(need('openapi-document')).rejects.toThrow(/EISDIR/);
    expect(server.arrived).toEqual([]);
});

// ------------------------------------------------------------------ ca: a healthy authority can be picked

const RUN_AUTHORITY = `/api/v1/authorities/${U(8)}`;

function serveRunCa(): void {
    updateRunState({ raProfile: { uuid: U(7), name: 'run-ra', kind: 'own', authorityUuid: U(8) } });
    core.serve(RUN_AUTHORITY, { uuid: U(8), connectorName: 'MS-ADCS-NG-Connector' });
}

test('ca is unmet when the run CA resolves but no healthy authority can be picked, met when one can, and fails on an unreadable list', async () => {
    serveRunCa();
    core.serve('/api/v1/connectors', []);
    core.serve('/api/v1/authorities', []);
    core.serve('/api/v1/raProfiles', []);
    expect(await need('ca'), 'the run CA resolves, the picker finds none').toMatch(/^deploy gate: no healthy CA with an enabled RA profile to copy/);
    core.serve('/api/v1/connectors', [{ uuid: U(9), name: 'MS-ADCS-NG-Connector', status: 'connected' }]);
    core.serve(`/api/v2/connectors/${U(9)}`, { uuid: U(9), version: 'v2' });
    core.serve(`/api/v2/connectors/${U(9)}/health`, { status: 'UP' });
    core.serve('/api/v1/authorities', [{ uuid: U(10), name: 'authority-a', connectorUuid: U(9), status: 'connected' }]);
    core.serve('/api/v1/raProfiles', [{ uuid: U(11), name: 'profile-a', authorityInstanceUuid: U(10), enabled: true }]);
    expect(await need('ca')).toBeUndefined();
    expect(await resolveNeeds(['ca', 'ejbca-ng'], { api, env: env() }), 'the CA behind the run RA profile is MS ADCS, not EJBCA').toMatch(/^needs ejbca-ng: the run RA profile is on MS-ADCS-NG-Connector/);
    core.serve('/api/v1/authorities', { message: 'down' }, 500);
    await expect(need('ca')).rejects.toThrow(/→ 500/);
    expect(server.mutations()).toEqual([]);
});

test('ca without a run CA still skips with the picker reason, and the picker runs once for it', async () => {
    core.serve('/api/v1/connectors', []);
    core.serve('/api/v1/authorities', []);
    core.serve('/api/v1/raProfiles', []);
    expect(await need('ca')).toMatch(/^deploy gate: no healthy CA/);
    expect(server.arrived.filter((a) => a.url === '/api/v1/connectors' || a.url.endsWith('/api/v1/connectors')), 'one picker read, not two').toHaveLength(1);
});

// ------------------------------------------------------------------ the needs fixture and the key chain

test('the needs fixture passes the options of the three parametrised needs and skips with the need\'s reason', async () => {
    const skipped: string[] = [];
    const needs = needsApi(async () => api, env(), (reason) => void skipped.push(reason));
    core.serve('/api/v1/settings/events', { eventsMapping: { [EVENT.registered]: [U(2)] } });
    await needs.platformTriggersFree(EVENT.actionPerformed);
    expect(skipped, 'an occupied event the row does not watch').toEqual([]);
    await needs.platformTriggersFree(EVENT.registered, EVENT.uploaded);
    await needs.platformTriggersFree();
    expect(skipped, 'the named events, then every event').toHaveLength(2);
    for (const reason of skipped) expect(reason).toMatch(/^platform-level trigger\(s\) already listen on Certificate registered/);
    core.serve(PLATFORM, registration(5, 7));
    await needs.registrationSettings();
    await needs.registrationSettings({ minFailedAttempts: 3 });
    expect(skipped).toHaveLength(2);
    await needs.registrationSettings({ minFailedAttempts: 6 });
    expect(skipped[2]).toMatch(/needs maxFailedAttempts of at least 6/);
    core.serve(ATTRIBUTES('certificates'), [required('string')]);
    core.serve(ATTRIBUTES('raProfiles'), [required('x509')]);
    await needs.requiredAttributesFillable('certificates');
    expect(skipped).toHaveLength(3);
    await needs.requiredAttributesFillable();
    expect(skipped[3], 'no resource named: certificates and RA profiles').toMatch(/^a required custom attribute of raProfiles/);
    await needs.scepHttps();
    await needs.bearerToken();
    expect(skipped, 'the other per-need methods stay no-argument and met here').toHaveLength(4);
    expect(server.mutations()).toEqual([]);
});

test('requireKeyChain is an error, not a skip, when the tier has no v2 cryptography connector', async () => {
    core.serve(CRYPTO, []);
    await expect(requireKeyChain(api, 'sharedNeeds.spec')).rejects.toThrow(/^the key chain cannot be made although the test declared its need: no connected software cryptography connector of interface v2/);
    expect(server.mutations(), 'nothing is created').toEqual([]);
});
