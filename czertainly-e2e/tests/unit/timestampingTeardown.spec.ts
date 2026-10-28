/**
 * The teardown handlers of the timestamping block (utils/timestamping/teardown.ts) as runTeardown loads them (behind the
 * guard), against a stateful fake core that applies core's refusals: call sequence, dry run, the deletion rule (read with
 * 200 first, 404 rules, absence proven by GET), the signing-record round limit, the secrets behind TSP Basic credentials,
 * and the descriptor (utils/timestamping/resourceTypes.ts) against the integrated DELETE_ORDER (the four types joined step 3).
 * The framework tables carry the four types (runTeardown.ts, ownership.ts); the test checks they agree with the
 * descriptor, which also proves the descriptor maps onto the registry shape.
 */
import * as fs from 'fs';
import { APIRequestContext, test, expect } from '@playwright/test';
import { DryRunRefusal } from '../../utils/regression/run/flags';
import { LIVE_READS, LiveObjectMissing, LiveRead } from '../../utils/regression/ledger/ownership';
import { LedgerLine } from '../../utils/regression/ledger/ledger';
import { DELETE_ORDER, HANDLER_MODULES, handlerOf, REFERENCED_BY, resetHandlerModulesForTests, TeardownContext, TeardownHandler } from '../../utils/regression/teardown/runTeardown';
import {
    TIMESTAMPING_DELETE_STEP_TYPES, TIMESTAMPING_NOT_REFERENCED, TIMESTAMPING_REFERENCED_BY, TIMESTAMPING_REGISTRY_ENTRIES, TIMESTAMPING_RELEASES,
    TIMESTAMPING_RESOURCE_TYPES,
} from '../../utils/timestamping/resourceTypes';
import { DELETE_ATTEMPTS, SECRET_WAIT_ATTEMPTS, SIGNING_RECORD_ROUNDS, teardownHandlers } from '../../utils/timestamping/teardown';

const RUN = 'qa-reg-20261022-120000-ab12';
type Json = Record<string, any>;
interface Reply { status: number; body?: unknown }

// ------------------------------------------------------------------ the stateful fake core

interface SigningProfileRow { name: string; tsp?: string; records: string[]; timestampSourceOf?: string }
interface TspProfileRow { name: string; defaultSigning?: string; vaultProfile?: string; secrets: string[] }
interface SecretRow { name: string; state: string }

interface CoreOptions {
    /** Records per list page (core's maximum is 1000; a small page exercises the rounds). */
    perPage?: number;
    /** The bulk delete answers success but keeps the records (the loop the round limit ends). */
    keepRecords?: boolean;
    /** The bulk delete answers one message per record it did not delete. */
    bulkMessages?: boolean;
    /** The first profile DELETE finds this many records that the deferred persistence staged after the last page. */
    lateRecords?: number;
    /** A DELETE answers 204 and keeps the object (absence proof). */
    ghostDelete?: string[];
    /** Reads of a Basic-credential secret that still answer 200 after its TSP profile is gone (core's queue). */
    secretLag?: number;
    /** The queue never removes the secret; DELETE /secrets/{uuid} removes it only when `secretDeletable`. */
    secretStuck?: boolean;
    secretDeletable?: boolean;
    /** Core queues the explicit delete too: the secret stays readable for this many reads after it, then answers 404. */
    deleteLag?: number;
    /**
     * The path-scoped listing returns a record whose `signingProfile.uuid` is not the requested profile
     * (the regression the ownership check must refuse before any bulk DELETE).
     */
    foreignSigningRecord?: { uuid: string; signingProfileUuid: string };
}

/** A stateful core: signing profiles, TSP profiles, time-quality configurations, signing records and vault secrets. */
class TimestampingCore {
    signing = new Map<string, SigningProfileRow>();
    tsp = new Map<string, TspProfileRow>();
    tqc = new Map<string, { name: string; usedBy: string[] }>();
    secrets = new Map<string, SecretRow>();
    /** Basic credentials: the TSP profile, the username and the vault secret behind it. */
    credentials = new Map<string, { tsp: string; username: string; secret: string }>();
    calls: string[] = [];
    /** Every request with its query string (`calls` drops it). */
    urls: string[] = [];
    private pendingDeletes = new Map<string, number>();
    private pendingSecretReads = new Map<string, number>();
    private firstProfileDelete = true;
    private recordSeq = 0;
    constructor(private opts: CoreOptions = {}) {}

    private reply(method: string, url: string, data: unknown): Reply {
        const path = url.split('?')[0];
        this.calls.push(`${method} ${path}`);
        this.urls.push(`${method} ${url}`);
        let m: RegExpExecArray | null;
        if ((m = /^\/api\/v1\/signingProfiles\/([^/]+)\/protocols\/tsp\/deactivate$/.exec(path)) && method === 'PATCH') {
            const p = this.signing.get(m[1]);
            if (!p) return { status: 404 };
            p.tsp = undefined;
            return { status: 200 };
        }
        if ((m = /^\/api\/v1\/signingProfiles\/([^/]+)\/protocols\/tsp$/.exec(path)) && method === 'GET') {
            const p = this.signing.get(m[1]);
            if (!p) return { status: 404 };
            const t = p.tsp ? this.tsp.get(p.tsp) : undefined;
            return { status: 200, body: t ? { available: true, uuid: p.tsp, name: t.name } : { available: false } };
        }
        if ((m = /^\/api\/v1\/signingProfiles\/([^/]+)\/signingRecords$/.exec(path)) && method === 'POST') {
            const profileUuid = m[1];
            const p = this.signing.get(profileUuid);
            if (!p) return { status: 404 };
            const page = this.opts.foreignSigningRecord
                ? [{ uuid: this.opts.foreignSigningRecord.uuid, signingProfile: { uuid: this.opts.foreignSigningRecord.signingProfileUuid, name: 'foreign' } }]
                : p.records.slice(0, this.opts.perPage ?? 1000).map((uuid) => ({ uuid, signingProfile: { uuid: profileUuid, name: p.name } }));
            return { status: 200, body: { items: page, totalItems: page.length } };
        }
        if (path === '/api/v1/signingRecords' && method === 'DELETE') {
            const uuids = data as string[];
            if (this.opts.bulkMessages) return { status: 200, body: uuids.map((u) => ({ uuid: u, name: '', message: 'Failed to delete signing record' })) };
            if (!this.opts.keepRecords) for (const p of this.signing.values()) p.records = p.records.filter((r) => !uuids.includes(r));
            return { status: 200, body: [] };
        }
        if ((m = /^\/api\/v1\/tspProfiles\/([^/]+)\/basicCredentials\/([^/]+)$/.exec(path))) {
            const c = this.credentials.get(m[2]);
            const found = c && c.tsp === m[1] && this.tsp.has(m[1]);
            if (method === 'GET') return found ? { status: 200, body: { uuid: m[2], username: c!.username, mappedUser: { uuid: 'u-1', name: 'mapped' } } } : { status: 404 };
            if (method === 'DELETE') {
                if (!found) return { status: 404 };
                if (!(this.opts.ghostDelete ?? []).includes(m[2])) {
                    this.credentials.delete(m[2]);
                    this.pendingSecretReads.set(c!.secret, this.opts.secretLag ?? 0);
                }
                return { status: 204 };
            }
        }
        if ((m = /^\/api\/v1\/signingProfiles\/([^/]+)$/.exec(path))) {
            const p = this.signing.get(m[1]);
            if (method === 'GET') return p ? { status: 200, body: { uuid: m[1], name: p.name } } : { status: 404 };
            if (method === 'DELETE') {
                if (!p) return { status: 404 };
                if (this.firstProfileDelete && this.opts.lateRecords) {
                    this.firstProfileDelete = false;
                    for (let i = 0; i < this.opts.lateRecords; i++) p.records.push(`late-${this.recordSeq++}`);
                }
                if (this.opts.lateRecords && this.opts.lateRecords < 0) p.records.push(`late-${this.recordSeq++}`);
                const holder = [...this.tsp.entries()].find(([, t]) => t.defaultSigning === m![1]);
                if (holder) return { status: 422, body: { message: `Cannot delete Signing Profile: used as default signing profile by TSP Profiles (1): ${holder[1].name}` } };
                if (p.timestampSourceOf) return { status: 422, body: { message: `Cannot delete Signing Profile '${p.name}': it is named as the timestamp source by Signing Profile(s): ${p.timestampSourceOf}` } };
                if (p.records.length) return { status: 422, body: { message: `Cannot delete Signing Profile '${p.name}': it has signing records. Delete the signing records first.` } };
                if (!(this.opts.ghostDelete ?? []).includes(m[1])) this.signing.delete(m[1]);
                return { status: 204 };
            }
        }
        if ((m = /^\/api\/v1\/tspProfiles\/([^/]+)$/.exec(path))) {
            const t = this.tsp.get(m[1]);
            if (method === 'GET') return t ? { status: 200, body: { uuid: m[1], name: t.name, ...(t.vaultProfile ? { vaultProfile: { uuid: t.vaultProfile } } : {}) } } : { status: 404 };
            if (method === 'DELETE') {
                if (!t) return { status: 404 };
                const active = [...this.signing.values()].filter((s) => s.tsp === m![1]);
                if (active.length) return { status: 422, body: { message: `Cannot delete TSP Profile: associated with Signing Profiles (${active.length}): ${active.map((s) => s.name).join(',')}` } };
                if (!(this.opts.ghostDelete ?? []).includes(m[1])) {
                    this.tsp.delete(m[1]);
                    for (const [cu, c] of [...this.credentials]) if (c.tsp === m[1]) this.credentials.delete(cu); // the rows go with the profile
                    for (const s of t.secrets) this.pendingSecretReads.set(s, this.opts.secretLag ?? 0);
                }
                return { status: 204 };
            }
        }
        if (path === '/api/v1/secrets' && method === 'POST') {
            const f = ((data as Json)?.filters?.[0] ?? {}) as Json;
            const rows = [...this.secrets.entries()].filter(([, s]) => s.name.startsWith(String(f.value ?? '')));
            return { status: 200, body: { items: rows.map(([uuid, s]) => ({ uuid, name: s.name })) } };
        }
        if ((m = /^\/api\/v1\/secrets\/([^/]+)$/.exec(path))) {
            const s = this.secrets.get(m[1]);
            if (method === 'GET') {
                if (!s) return { status: 404 };
                const lag = this.pendingDeletes.get(m[1]);
                if (lag !== undefined) {
                    if (lag <= 0) {
                        this.secrets.delete(m[1]);
                        return { status: 404 };
                    }
                    this.pendingDeletes.set(m[1], lag - 1);
                    return { status: 200, body: { uuid: m[1], name: s.name, state: s.state } };
                }
                const pending = this.pendingSecretReads.get(m[1]);
                if (pending !== undefined && pending <= 0 && !this.opts.secretStuck) {
                    this.secrets.delete(m[1]);
                    return { status: 404 };
                }
                if (pending !== undefined && pending > 0) this.pendingSecretReads.set(m[1], pending - 1);
                return { status: 200, body: { uuid: m[1], name: s.name, state: s.state } };
            }
            if (method === 'DELETE') {
                if (!s) return { status: 404 };
                if (this.opts.secretDeletable) {
                    if (this.opts.deleteLag) this.pendingDeletes.set(m[1], this.opts.deleteLag);
                    else this.secrets.delete(m[1]);
                }
                return { status: 204 };
            }
        }
        if ((m = /^\/api\/v1\/timeQualityConfigurations\/([^/]+)$/.exec(path))) {
            const q = this.tqc.get(m[1]);
            if (method === 'GET') return q ? { status: 200, body: { uuid: m[1], name: q.name } } : { status: 404 };
            if (method === 'DELETE') {
                if (!q) return { status: 404 };
                const users = q.usedBy.filter((u) => this.signing.has(u)).map((u) => this.signing.get(u)!);
                if (users.length) return { status: 422, body: { message: `Cannot delete Time Quality Configuration: associated with Signing Profiles (${users.length}): ${users.map((u) => u.name).join(', ')}` } };
                if (!(this.opts.ghostDelete ?? []).includes(m[1])) this.tqc.delete(m[1]);
                return { status: 204 };
            }
        }
        return { status: 404 };
    }

    api(): APIRequestContext {
        const resp = (r: Reply) => ({
            status: () => r.status,
            ok: () => r.status >= 200 && r.status < 300,
            json: async () => r.body,
            text: async () => JSON.stringify(r.body ?? ''),
        });
        const call = (method: string) => async (url: string, opts?: { data?: unknown }) => resp(this.reply(method, url, opts?.data));
        return { get: call('GET'), post: call('POST'), patch: call('PATCH'), put: call('PUT'), delete: call('DELETE'), dispose: async () => undefined } as unknown as APIRequestContext;
    }

    /** Mutations only (PATCH / DELETE), listings (POST) excluded. */
    writes(): string[] {
        return this.calls.filter((c) => c.startsWith('PATCH ') || c.startsWith('DELETE '));
    }
}

// ------------------------------------------------------------------ rig

const SIGNING = '11111111-1111-4111-8111-111111111111';
const TSP = '22222222-2222-4222-8222-222222222222';
const TQC = '33333333-3333-4333-8333-333333333333';
const SECRET_A = '44444444-4444-4444-8444-444444444441';
const SECRET_B = '44444444-4444-4444-8444-444444444442';
const FOREIGN_SECRET = '55555555-5555-4555-8555-555555555555';
const CRED = '88888888-8888-4888-8888-888888888881';
const CRED_SECRET = '99999999-9999-4999-8999-999999999991';
const SIBLING_CRED = '88888888-8888-4888-8888-888888888882';
const SIBLING_SECRET = '99999999-9999-4999-8999-999999999992';

const lines = (): LedgerLine[] => [
    { at: '2026-10-22T12:00:00.000Z', runId: RUN, type: 'timeQualityConfigurations', name: `${RUN}-tqc`, uuid: TQC, spec: 'timestamping-setup', event: 'created' },
    { at: '2026-10-22T12:00:01.000Z', runId: RUN, type: 'signingProfiles', name: `${RUN}-sp`, uuid: SIGNING, spec: 'timestamping-setup', event: 'created', parents: { tspProfile: TSP, timeQualityConfiguration: TQC } },
    { at: '2026-10-22T12:00:02.000Z', runId: RUN, type: 'tspProfiles', name: `${RUN}-tsp`, uuid: TSP, spec: 'timestamping-setup', event: 'created', parents: { signingProfile: SIGNING } },
];
const credentialLine = (): LedgerLine => ({ at: '2026-10-22T12:00:04.000Z', runId: RUN, type: 'tspBasicCredentials', name: `${RUN}-cred`, uuid: CRED, spec: '40-tsp-errors', event: 'created', parents: { tspProfile: TSP } });
const lineOf = (ledger: LedgerLine[], type: string): LedgerLine => ledger.find((l) => l.type === type)!;

/** A core with the full set: signing profile activated on its TSP profile (also its default), a vault profile with two credentials. */
function fullCore(opts: CoreOptions = {}, records = 3): TimestampingCore {
    const core = new TimestampingCore(opts);
    core.tqc.set(TQC, { name: `${RUN}-tqc`, usedBy: [SIGNING] });
    core.signing.set(SIGNING, { name: `${RUN}-sp`, tsp: TSP, records: Array.from({ length: records }, (_v, i) => `rec-${i}`) });
    core.tsp.set(TSP, { name: `${RUN}-tsp`, defaultSigning: SIGNING, vaultProfile: 'vp-1', secrets: [SECRET_A, SECRET_B] });
    core.secrets.set(SECRET_A, { name: `tsp-basic-${TSP}-alice-1a2b3c4d`, state: 'active' });
    core.secrets.set(SECRET_B, { name: `tsp-basic-${TSP}-bob-5e6f7a8b`, state: 'active' });
    core.secrets.set(FOREIGN_SECRET, { name: 'someone-elses-secret', state: 'active' });
    return core;
}

/** fullCore plus one credential the specs added (its secret, and a sibling credential whose username starts the same way). */
function credentialCore(opts: CoreOptions = {}): TimestampingCore {
    const core = fullCore(opts);
    core.credentials.set(CRED, { tsp: TSP, username: `${RUN}-cred`, secret: CRED_SECRET });
    core.secrets.set(CRED_SECRET, { name: `tsp-basic-${TSP}-${RUN}-cred-0a1b2c3d`, state: 'active' });
    core.tsp.get(TSP)!.secrets.push(CRED_SECRET);
    core.credentials.set(SIBLING_CRED, { tsp: TSP, username: `${RUN}-cred-2`, secret: SIBLING_SECRET });
    core.secrets.set(SIBLING_SECRET, { name: `tsp-basic-${TSP}-${RUN}-cred-2-9f8e7d6c`, state: 'active' });
    core.tsp.get(TSP)!.secrets.push(SIBLING_SECRET);
    return core;
}

const handler = (type: string): TeardownHandler => {
    const h = handlerOf(type);
    expect(h, `handler for ${type}`).toBeTruthy();
    return h as TeardownHandler;
};

async function run(core: TimestampingCore, type: string, ledger: LedgerLine[] = lines(), seen: Set<string> = new Set()): Promise<{ warnings: string[]; error?: any }> {
    const warnings: string[] = [];
    const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger, seen, tier: null, warn: (m) => void warnings.push(m), pollMs: 1 };
    try {
        await handler(type).remove(ctx, lineOf(ledger, type));
        return { warnings };
    } catch (error) {
        return { warnings, error };
    }
}

// ledger/ownership.ts LIVE_READS carries the descriptor's reads since the integration: assert they agree instead of
// installing them (an install / delete here would remove the real entries for the specs that run after this file).
test.beforeAll(() => {
    resetHandlerModulesForTests();
});
test.afterAll(() => {
    resetHandlerModulesForTests();
});

test('LIVE_READS reads every timestamping type at the descriptor\'s detail URL and name field', async () => {
    const line = { parents: { tspProfile: '11111111-1111-4111-8111-111111111111' } } as unknown as Parameters<LiveRead['url']>[2];
    for (const d of TIMESTAMPING_RESOURCE_TYPES) {
        const read = LIVE_READS[d.type];
        expect(read, d.type).toBeDefined();
        const uuid = '22222222-2222-4222-8222-222222222222';
        expect(await read.url(undefined as never, uuid, line), d.type).toBe(d.liveRead.detailUrl(uuid, line.parents));
        expect(read.name({ [d.liveRead.nameField]: 'qa-reg-x' } as never), d.type).toBe('qa-reg-x');
    }
});

const ENV_KEYS = ['CLEANUP_LEDGER_FILE', 'REG_STATE_DIR', 'REG_RUN_ID', 'API_TEARDOWN_DRY_RUN'];
let saved: Record<string, string | undefined> = {};
test.beforeEach(({}, testInfo) => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.REG_STATE_DIR = testInfo.outputPath('state');
    process.env.CLEANUP_LEDGER_FILE = testInfo.outputPath('cleanup.jsonl');
});
test.afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/** The cleanup-failure records the handler wrote (utils/cleanupLedger.ts) in this test. */
const cleanupFailures = (): Array<{ resource: string; uuid?: string; message: string; blockedBy?: string }> => {
    const file = process.env.CLEANUP_LEDGER_FILE!;
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const indexOfCall = (core: TimestampingCore, call: string, from = 0): number => core.calls.indexOf(call, from);

// ------------------------------------------------------------------ tspProfiles

// the order of the developers' teardown: deactivate on the signing profile, then delete the TSP profile; absence by GET
test('a TSP profile is deactivated on its signing profile, deleted, and its absence is proven by GET', async () => {
    const core = fullCore();
    const { error } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    const deactivate = indexOfCall(core, `PATCH /api/v1/signingProfiles/${SIGNING}/protocols/tsp/deactivate`);
    const del = indexOfCall(core, `DELETE /api/v1/tspProfiles/${TSP}`);
    expect(deactivate, 'deactivate sent').toBeGreaterThan(-1);
    expect(del, 'delete sent').toBeGreaterThan(deactivate);
    expect(indexOfCall(core, `GET /api/v1/tspProfiles/${TSP}`, del), 'absence read after the delete').toBeGreaterThan(del);
    // the deactivation is proven by a read of the activation
    expect(indexOfCall(core, `GET /api/v1/signingProfiles/${SIGNING}/protocols/tsp`, deactivate)).toBeGreaterThan(deactivate);
    expect(core.writes()).toEqual([`PATCH /api/v1/signingProfiles/${SIGNING}/protocols/tsp/deactivate`, `DELETE /api/v1/tspProfiles/${TSP}`]);
    expect(core.tsp.has(TSP)).toBe(false);
    expect(core.signing.has(SIGNING), 'the signing profile is not this handler\'s').toBe(true);
});

test('the TSP profile\'s own live read comes first; an activation on a signing profile is read live before it is changed', async () => {
    const core = fullCore();
    await run(core, 'tspProfiles');
    expect(core.calls[0]).toBe(`GET /api/v1/tspProfiles/${TSP}`);
    const live = indexOfCall(core, `GET /api/v1/signingProfiles/${SIGNING}`);
    expect(live, 'signing profile read live').toBeGreaterThan(-1);
    expect(live).toBeLessThan(indexOfCall(core, `PATCH /api/v1/signingProfiles/${SIGNING}/protocols/tsp/deactivate`));
});

test('a signing profile not activated on the TSP profile is left alone (no deactivate)', async () => {
    const core = fullCore();
    core.signing.get(SIGNING)!.tsp = undefined;
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    expect(core.writes()).toEqual([`DELETE /api/v1/tspProfiles/${TSP}`]);
});

test('a signing profile of the run that is not in the line\'s parents but activated on the TSP profile is deactivated too', async () => {
    const core = fullCore();
    const other = '66666666-6666-4666-8666-666666666666';
    core.signing.set(other, { name: `${RUN}-sp2`, tsp: TSP, records: [] });
    const ledger = [...lines(), { at: '2026-10-22T12:00:03.000Z', runId: RUN, type: 'signingProfiles', name: `${RUN}-sp2`, uuid: other, spec: 'spec', event: 'created' } as LedgerLine];
    const { error } = await run(core, 'tspProfiles', ledger);
    expect(error).toBeUndefined();
    expect(core.writes()).toContain(`PATCH /api/v1/signingProfiles/${other}/protocols/tsp/deactivate`);
    expect(core.tsp.has(TSP)).toBe(false);
});

test('a foreign signing profile activated on the TSP profile is never touched; core\'s refusal fails the delete', async () => {
    const core = fullCore();
    core.signing.get(SIGNING)!.tsp = undefined;
    core.tsp.get(TSP)!.defaultSigning = undefined;
    core.signing.set('77777777-7777-4777-8777-777777777777', { name: 'foreign-profile', tsp: TSP, records: [] });
    const { error } = await run(core, 'tspProfiles');
    expect(String(error)).toMatch(/Failed to delete TSP profile .*422.*associated with Signing Profiles/);
    expect(core.writes().some((w) => w.startsWith('PATCH'))).toBe(false);
});

// the vault secrets behind the Basic credentials: core's queue removes them after the profile is gone
test('the vault secrets of the Basic credentials are listed before the delete and awaited afterwards', async () => {
    const core = fullCore({ secretLag: 3 });
    const { error } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    const list = core.calls.findIndex((c) => c === 'POST /api/v1/secrets');
    const del = indexOfCall(core, `DELETE /api/v1/tspProfiles/${TSP}`);
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(del);
    expect(core.secrets.has(SECRET_A) || core.secrets.has(SECRET_B), 'both credential secrets gone').toBe(false);
    expect(core.secrets.has(FOREIGN_SECRET), 'a foreign secret is never read or touched').toBe(true);
    expect(core.calls.some((c) => c.includes(FOREIGN_SECRET))).toBe(false);
    expect(core.writes().filter((w) => w.includes('/secrets/')), 'no explicit secret delete when the queue did its job').toEqual([]);
});

test('a secret core\'s queue left is deleted explicitly once (only with this TSP profile\'s name prefix)', async () => {
    const core = fullCore({ secretStuck: true, secretDeletable: true });
    const { error, warnings } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    expect(core.writes().filter((w) => w.includes('/secrets/'))).toEqual([`DELETE /api/v1/secrets/${SECRET_A}`, `DELETE /api/v1/secrets/${SECRET_B}`]);
    expect(warnings.join('\n')).toMatch(/core's queue left the vault secret/);
    expect(core.secrets.has(FOREIGN_SECRET)).toBe(true);
});

test('the explicit secret delete asks core to delete in the vaults too', async () => {
    const core = fullCore({ secretStuck: true, secretDeletable: true });
    const { error } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    expect(core.urls.filter((u) => u.startsWith('DELETE /api/v1/secrets/'))).toEqual([
        `DELETE /api/v1/secrets/${SECRET_A}?deleteInVaults=true`,
        `DELETE /api/v1/secrets/${SECRET_B}?deleteInVaults=true`,
    ]);
});

test('a secret that disappears a few polls after the explicit delete is awaited with the handler\'s own poll: no leftover report', async () => {
    const core = fullCore({ secretStuck: true, secretDeletable: true, deleteLag: 8 });
    const { error, warnings } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    expect(core.secrets.has(SECRET_A) || core.secrets.has(SECRET_B)).toBe(false);
    expect(warnings.filter((w) => /stays in the vault profile/.test(w))).toEqual([]);
    expect(cleanupFailures()).toEqual([]);
});

test('a secret that stays after the profile delete does not fail the handler: a warning and a cleanup-failure record for the secret', async () => {
    const core = fullCore({ secretStuck: true, secretDeletable: false });
    const { error, warnings } = await run(core, 'tspProfiles');
    expect(error, 'the profile is gone, so the handler succeeds').toBeUndefined();
    expect(core.tsp.has(TSP)).toBe(false);
    expect(warnings.filter((w) => /stays in the vault profile/.test(w))).toHaveLength(2);
    const failures = cleanupFailures();
    expect(failures.map((f) => [f.resource, f.uuid])).toEqual([['secrets', SECRET_A], ['secrets', SECRET_B]]);
    expect(failures[0].blockedBy).toBe(`secrets ${SECRET_A}`);
    expect(failures[0].message).toMatch(/vault profile cannot be deleted/);
});

test('a secret whose live name lost the exact name shape is reported, not deleted, and does not fail the handler', async () => {
    const core = fullCore({ secretStuck: true, secretDeletable: true });
    // the list names it by the prefix, the detail read says otherwise (a reused uuid)
    const real = core.api();
    const api = {
        ...real,
        get: async (url: string, o?: unknown) => {
            const r = await (real.get as any)(url, o);
            if (url === `/api/v1/secrets/${SECRET_A}` && r.status() === 200) return { ...r, json: async () => ({ uuid: SECRET_A, name: 'renamed', state: 'active' }) };
            return r;
        },
    } as unknown as APIRequestContext;
    const ledger = lines();
    const warnings: string[] = [];
    const ctx: TeardownContext = { api, runId: RUN, ledger, seen: new Set(), tier: null, warn: (m) => void warnings.push(m), pollMs: 1 };
    await handler('tspProfiles').remove(ctx, lineOf(ledger, 'tspProfiles'));
    expect(core.writes().some((w) => w === `DELETE /api/v1/secrets/${SECRET_A}`)).toBe(false);
    expect(cleanupFailures().map((f) => f.uuid)).toEqual([SECRET_A]);
    expect(warnings.join('\n')).toMatch(/not touching it/);
});

test('a secret under the own profile without the 8-hex suffix is not deleted, only reported', async () => {
    const core = fullCore({ secretStuck: true, secretDeletable: true });
    const odd = '66666666-6666-4666-8666-666666666666';
    core.secrets.set(odd, { name: `tsp-basic-${TSP}-foo`, state: 'active' });
    core.tsp.get(TSP)!.secrets.push(odd);
    const { error } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    expect(core.writes().some((w) => w.includes(odd))).toBe(false);
    expect(core.secrets.has(odd)).toBe(true);
});

test('a GET that rejects and a 200 with a non-JSON body are reported per secret; the handler still succeeds', async () => {
    const core = fullCore({ secretStuck: true, secretDeletable: true });
    const real = core.api();
    let readsOfA = 0;
    const api = {
        ...real,
        get: async (url: string, o?: unknown) => {
            if (url === `/api/v1/secrets/${SECRET_A}`) {
                if (++readsOfA > 2) throw new Error('socket hang up');
            }
            const r = await (real.get as any)(url, o);
            if (url === `/api/v1/secrets/${SECRET_B}` && r.status() === 200) return { ...r, json: async () => { throw new Error('Unexpected token <'); } };
            return r;
        },
    } as unknown as APIRequestContext;
    const ledger = lines();
    const ctx: TeardownContext = { api, runId: RUN, ledger, seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
    await handler('tspProfiles').remove(ctx, lineOf(ledger, 'tspProfiles'));
    expect(core.tsp.has(TSP)).toBe(false);
    expect(cleanupFailures().map((f) => f.uuid).sort()).toEqual([SECRET_A, SECRET_B]);
});

test('a lag beyond SECRET_WAIT_ATTEMPTS ends the wait after exactly that many reads and reports the secret', async () => {
    const core = fullCore({ secretStuck: true, secretDeletable: true, deleteLag: SECRET_WAIT_ATTEMPTS + 10 });
    const { error } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    expect(cleanupFailures().map((f) => f.uuid)).toEqual([SECRET_A, SECRET_B]);
    const readsAfterDelete = core.calls.slice(core.calls.indexOf(`DELETE /api/v1/secrets/${SECRET_A}`)).filter((c, i, a) => c === `GET /api/v1/secrets/${SECRET_A}` && i < a.indexOf(`DELETE /api/v1/secrets/${SECRET_B}`)).length;
    expect(readsAfterDelete).toBe(SECRET_WAIT_ATTEMPTS);
});

test('a TSP profile without a vault profile sends no secret listing', async () => {
    const core = fullCore();
    core.tsp.get(TSP)!.vaultProfile = undefined;
    core.tsp.get(TSP)!.secrets = [];
    const { error } = await run(core, 'tspProfiles');
    expect(error).toBeUndefined();
    expect(core.calls.includes('POST /api/v1/secrets')).toBe(false);
});

// ------------------------------------------------------------------ signingProfiles

test('a signing profile: deactivate, empty its signing records page by page, delete, absence by GET', async () => {
    const core = fullCore({ perPage: 2 }, 5);
    core.tsp.get(TSP)!.defaultSigning = undefined; // the TSP profile's handler is not part of this test
    const { error } = await run(core, 'signingProfiles');
    expect(error).toBeUndefined();
    expect(core.signing.has(SIGNING)).toBe(false);
    const writes = core.writes();
    expect(writes[0]).toBe(`PATCH /api/v1/signingProfiles/${SIGNING}/protocols/tsp/deactivate`);
    expect(writes.filter((w) => w === 'DELETE /api/v1/signingRecords')).toHaveLength(3); // 2 + 2 + 1
    expect(writes[writes.length - 1]).toBe(`DELETE /api/v1/signingProfiles/${SIGNING}`);
    const del = indexOfCall(core, `DELETE /api/v1/signingProfiles/${SIGNING}`);
    expect(indexOfCall(core, `GET /api/v1/signingProfiles/${SIGNING}`, del), 'absence read after the delete').toBeGreaterThan(del);
    // the last listing before the delete was empty: the proof that nothing is left
    const lastList = core.calls.slice(0, del).lastIndexOf(`POST /api/v1/signingProfiles/${SIGNING}/signingRecords`);
    expect(lastList).toBeGreaterThan(-1);
});

test('a signing profile that is not activated gets no deactivate call; one without records sends no bulk delete', async () => {
    const core = fullCore({}, 0);
    core.signing.get(SIGNING)!.tsp = undefined;
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'signingProfiles');
    expect(error).toBeUndefined();
    expect(core.writes()).toEqual([`DELETE /api/v1/signingProfiles/${SIGNING}`]);
});

// the round limit: core reports every delete done but keeps the records (lib/teardown.sh teardown_signing_records)
test('records that core keeps end the loop at the round limit, fail the handler and never send the profile delete', async () => {
    const core = fullCore({ keepRecords: true }, 4);
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'signingProfiles');
    expect(String(error)).toMatch(new RegExp(`signing records remain after ${SIGNING_RECORD_ROUNDS} rounds`));
    expect(core.calls.filter((c) => c === `POST /api/v1/signingProfiles/${SIGNING}/signingRecords`)).toHaveLength(SIGNING_RECORD_ROUNDS);
    expect(core.writes().some((w) => w === `DELETE /api/v1/signingProfiles/${SIGNING}`)).toBe(false);
    expect(core.signing.has(SIGNING)).toBe(true);
});

test('a bulk delete that answers messages is a failure naming the count, not a silent skip', async () => {
    const core = fullCore({ bulkMessages: true }, 2);
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'signingProfiles');
    expect(String(error)).toMatch(/core kept 2 of 2 signing record\(s\)/);
    expect(core.writes().some((w) => w === `DELETE /api/v1/signingProfiles/${SIGNING}`)).toBe(false);
});

test('a listing that returns a record owned by another signing profile fails closed and never bulk-deletes', async () => {
    const foreignProfile = 'signing-foreign';
    const foreignRecord = 'record-foreign';
    const core = fullCore({ foreignSigningRecord: { uuid: foreignRecord, signingProfileUuid: foreignProfile } }, 1);
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'signingProfiles');
    expect(String(error)).toMatch(new RegExp(`listing returned record ${foreignRecord} owned by ${foreignProfile}`));
    expect(core.writes().some((w) => w === 'DELETE /api/v1/signingRecords')).toBe(false);
    expect(core.writes().some((w) => w === `DELETE /api/v1/signingProfiles/${SIGNING}`)).toBe(false);
    expect(core.signing.has(SIGNING)).toBe(true);
});

test('a record staged after the last page makes core refuse once; the handler empties the profile again and succeeds', async () => {
    const core = fullCore({ lateRecords: 2 }, 1);
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'signingProfiles');
    expect(error).toBeUndefined();
    expect(core.signing.has(SIGNING)).toBe(false);
    expect(core.writes().filter((w) => w === `DELETE /api/v1/signingProfiles/${SIGNING}`)).toHaveLength(2);
});

test('records that keep appearing stop after DELETE_ATTEMPTS tries with core\'s refusal in the message', async () => {
    const core = fullCore({ lateRecords: -1 }, 0);
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'signingProfiles');
    expect(String(error)).toMatch(/Failed to delete signing profile .*422.*signing records/);
    expect(core.writes().filter((w) => w === `DELETE /api/v1/signingProfiles/${SIGNING}`)).toHaveLength(DELETE_ATTEMPTS);
});

test('a signing profile that is a TSP profile\'s default is reported blocked by that TSP profile (wrong order)', async () => {
    const core = fullCore({}, 0);
    core.signing.get(SIGNING)!.tsp = undefined; // activation gone, but the TSP profile still names it as default
    const { error } = await run(core, 'signingProfiles');
    expect(error.blockedBy).toMatch(/TSP profile naming it as its default signing profile/);
    expect(core.signing.has(SIGNING)).toBe(true);
});

test('a signing profile named as a timestamp source is reported blocked by the signing profile that names it', async () => {
    const core = fullCore({}, 0);
    core.signing.get(SIGNING)!.tsp = undefined;
    core.tsp.get(TSP)!.defaultSigning = undefined;
    core.signing.get(SIGNING)!.timestampSourceOf = 'content-signing-canary';
    const { error } = await run(core, 'signingProfiles');
    expect(error.blockedBy).toMatch(/signing profile naming it as its timestamp source/);
});

test('a listing that answers 5xx fails the handler (a record core did not show is not "no records")', async () => {
    const core = fullCore();
    const real = core.api();
    const api = { ...real, post: async () => ({ status: () => 500, ok: () => false, json: async () => ({}), text: async () => 'boom' }) } as unknown as APIRequestContext;
    const ledger = lines();
    const ctx: TeardownContext = { api, runId: RUN, ledger, seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
    await expect(handler('signingProfiles').remove(ctx, lineOf(ledger, 'signingProfiles'))).rejects.toThrow(/listing its signing records answered 500/);
});

// ------------------------------------------------------------------ timeQualityConfigurations

test('a time-quality configuration is read live, deleted, and its absence proven by GET', async () => {
    const core = fullCore();
    core.signing.clear();
    const { error } = await run(core, 'timeQualityConfigurations');
    expect(error).toBeUndefined();
    expect(core.calls).toEqual([
        `GET /api/v1/timeQualityConfigurations/${TQC}`, `DELETE /api/v1/timeQualityConfigurations/${TQC}`, `GET /api/v1/timeQualityConfigurations/${TQC}`,
    ]);
});

test('a time-quality configuration a signing profile still references is reported blocked by the signing profile', async () => {
    const core = fullCore();
    const { error } = await run(core, 'timeQualityConfigurations');
    expect(error.blockedBy).toMatch(/signing profile referencing it/);
    expect(core.tqc.has(TQC)).toBe(true);
});

// ------------------------------------------------------------------ the deletion rule (shared by the four types)

for (const type of ['tspBasicCredentials', 'tspProfiles', 'signingProfiles', 'timeQualityConfigurations']) {
    test(`${type}: 404 without a prior 200 in the step is "route or object missing", nothing is sent`, async () => {
        const core = new TimestampingCore();
        const { error } = await run(core, type, [...lines(), credentialLine()]);
        expect(error).toBeInstanceOf(LiveObjectMissing);
        expect(String(error)).toMatch(/route or object missing/);
        expect(core.writes()).toEqual([]);
    });

    test(`${type}: a delete answered 204 while the object is still readable fails (absence not proven)`, async () => {
        const uuid = type === 'tspBasicCredentials' ? CRED : type === 'tspProfiles' ? TSP : type === 'signingProfiles' ? SIGNING : TQC;
        const core = credentialCore({ ghostDelete: [uuid] });
        core.signing.get(SIGNING)!.tsp = undefined;
        core.signing.get(SIGNING)!.records = [];
        core.tsp.get(TSP)!.defaultSigning = undefined;
        core.tqc.get(TQC)!.usedBy = [];
        const { error } = await run(core, type, [...lines(), credentialLine()]);
        expect(String(error)).toMatch(/absence not proven/);
    });

    test(`${type}: dry run sends nothing (the wrapped handler refuses before any request)`, async () => {
        process.env.API_TEARDOWN_DRY_RUN = '1';
        const core = credentialCore();
        const ledger = [...lines(), credentialLine()];
        const { wrapHandlerWithGuard } = await import('../../utils/regression/teardown/runTeardown');
        const ctx: TeardownContext = { api: core.api(), runId: RUN, ledger, seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
        await expect(wrapHandlerWithGuard(type, teardownHandlers[type]).remove(ctx, lineOf(ledger, type))).rejects.toBeInstanceOf(DryRunRefusal);
        // even the raw handler, called outside the registry, sends nothing
        await expect(teardownHandlers[type].remove({ ...ctx, seen: new Set([lineOf(ledger, type).uuid]) }, lineOf(ledger, type))).rejects.toBeInstanceOf(DryRunRefusal);
        expect(core.calls).toEqual([]);
    });
}

// a DELETE answering 404 after the 200 read counts as gone in between; the GET still proves it
test('a DELETE answering 404 after a 200 read counts as gone in between; the GET still proves it', async () => {
    const core = fullCore({}, 0);
    core.tqc.get(TQC)!.usedBy = [];
    const real = core.api();
    const api = {
        ...real,
        delete: async (url: string, o?: unknown) => {
            await (real.delete as any)(url, o); // the object goes away, the answer says 404
            return { status: () => 404, ok: () => false, json: async () => ({}), text: async () => '' };
        },
    } as unknown as APIRequestContext;
    const ledger = lines();
    const ctx: TeardownContext = { api, runId: RUN, ledger, seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 };
    await handler('timeQualityConfigurations').remove(ctx, lineOf(ledger, 'timeQualityConfigurations'));
    expect(core.tqc.has(TQC)).toBe(false);
});

// a foreign object (live name without the run prefix) is refused by the guard before a handler touches it
test('a foreign object (live name without the run prefix) is refused, nothing is sent', async () => {
    const core = fullCore();
    core.tsp.get(TSP)!.name = 'not-ours';
    const { error } = await run(core, 'tspProfiles');
    expect(String(error)).toMatch(/refusing to touch|live name/);
    expect(core.writes()).toEqual([]);
});

// on a shared tier a ledger line may point at an object somebody else owns (a wrong uuid, a renamed object): the live name decides, for each type
test('a pre-existing signing profile or time-quality configuration (live name without the run prefix) is refused too: nothing is sent', async () => {
    const signing = fullCore();
    signing.signing.get(SIGNING)!.name = 'production-signing';
    const a = await run(signing, 'signingProfiles');
    expect(String(a.error)).toMatch(/refusing to touch|live name/);
    expect(signing.writes()).toEqual([]);
    const tqc = fullCore();
    tqc.tqc.get(TQC)!.name = 'qualified-time-source';
    tqc.tqc.get(TQC)!.usedBy = [];
    const b = await run(tqc, 'timeQualityConfigurations');
    expect(String(b.error)).toMatch(/refusing to touch|live name/);
    expect(tqc.writes()).toEqual([]);
    expect(tqc.tqc.has(TQC), 'the pre-existing configuration is still there').toBe(true);
});

// idempotent: a second run for an object that is gone ends in "route or object missing" with no request but reads
test('a second call for an object that is already gone sends no mutation', async () => {
    const core = fullCore();
    expect((await run(core, 'tspProfiles')).error).toBeUndefined();
    const before = core.writes().length;
    const again = await run(core, 'tspProfiles');
    expect(again.error).toBeInstanceOf(LiveObjectMissing);
    expect(core.writes()).toHaveLength(before);
});

// ------------------------------------------------------------------ tspBasicCredentials

test('a Basic credential is read live under its TSP profile, deleted through the scoped route, absence by GET, its own secret awaited', async () => {
    const core = credentialCore({ secretLag: 2 });
    const { error } = await run(core, 'tspBasicCredentials', [...lines(), credentialLine()]);
    expect(error).toBeUndefined();
    expect(core.calls[0]).toBe(`GET /api/v1/tspProfiles/${TSP}/basicCredentials/${CRED}`);
    const del = indexOfCall(core, `DELETE /api/v1/tspProfiles/${TSP}/basicCredentials/${CRED}`);
    expect(del).toBeGreaterThan(0);
    expect(indexOfCall(core, `GET /api/v1/tspProfiles/${TSP}/basicCredentials/${CRED}`, del)).toBeGreaterThan(del);
    expect(core.writes()).toEqual([`DELETE /api/v1/tspProfiles/${TSP}/basicCredentials/${CRED}`]);
    expect(core.credentials.has(CRED)).toBe(false);
    expect(core.secrets.has(CRED_SECRET), 'its secret is gone').toBe(false);
    // the sibling credential (username starting the same way) and its secret are never read or touched
    expect(core.credentials.has(SIBLING_CRED)).toBe(true);
    expect(core.secrets.has(SIBLING_SECRET)).toBe(true);
    expect(core.calls.some((c) => c.includes(SIBLING_SECRET) || c.includes(SIBLING_CRED))).toBe(false);
    expect(core.tsp.has(TSP)).toBe(true);
});

test('a credential secret that stays is reported (warning + cleanup-failure record), the deleted credential is not failed', async () => {
    const core = credentialCore({ secretStuck: true, secretDeletable: false });
    const { error, warnings } = await run(core, 'tspBasicCredentials', [...lines(), credentialLine()]);
    expect(error).toBeUndefined();
    expect(warnings.some((w) => /stays in the vault profile/.test(w))).toBe(true);
    expect(cleanupFailures().map((f) => [f.resource, f.uuid, f.blockedBy])).toEqual([['secrets', CRED_SECRET, `secrets ${CRED_SECRET}`]]);
});

test('a credential whose TSP profile is already gone is done by its profile (goneWith), not a failure; without the profile\'s deleted line it is "missing"', async () => {
    const core = credentialCore();
    const ledger = [...lines(), credentialLine()];
    // the TSP profile's own handler deletes the profile and, with it, the credential rows
    expect((await run(core, 'tspProfiles', ledger)).error).toBeUndefined();
    expect(core.credentials.has(CRED)).toBe(false);
    const { wrapHandlerWithGuard } = await import('../../utils/regression/teardown/runTeardown');
    const mk = (l: LedgerLine[]): TeardownContext => ({ api: core.api(), runId: RUN, ledger: l, seen: new Set(), tier: null, warn: () => undefined, pollMs: 1 });
    const wrapped = wrapHandlerWithGuard('tspBasicCredentials', teardownHandlers.tspBasicCredentials);
    await expect(wrapped.remove(mk(ledger), credentialLine())).rejects.toBeInstanceOf(LiveObjectMissing);
    const withDeleted = [...ledger, { at: '2026-10-22T12:10:00.000Z', runId: RUN, type: 'tspProfiles', name: `${RUN}-tsp`, uuid: TSP, spec: 'runTeardown', event: 'deleted' } as LedgerLine];
    const writesBefore = core.writes().length;
    await wrapped.remove(mk(withDeleted), credentialLine());
    expect(core.writes()).toHaveLength(writesBefore);
});

test('the TSP profile\'s handler waits for the secrets of credentials the specs added (and their rows go with it)', async () => {
    const core = credentialCore({ secretLag: 2 });
    const { error } = await run(core, 'tspProfiles', [...lines(), credentialLine()]);
    expect(error).toBeUndefined();
    expect(core.secrets.has(CRED_SECRET) || core.secrets.has(SIBLING_SECRET)).toBe(false);
    expect(core.credentials.size).toBe(0);
});

test('a credential without a live name that carries the run prefix is refused', async () => {
    const core = credentialCore();
    core.credentials.get(CRED)!.username = 'someone-else';
    const { error } = await run(core, 'tspBasicCredentials', [...lines(), credentialLine()]);
    expect(String(error)).toMatch(/refusing to touch|live name/);
    expect(core.writes()).toEqual([]);
});

// ------------------------------------------------------------------ signing profiles recorded without parents

const bareSigningLine = (): LedgerLine => ({ at: '2026-10-22T12:00:05.000Z', runId: RUN, type: 'signingProfiles', name: `${RUN}-sp`, uuid: SIGNING, spec: '60-content-signing-canary', event: 'created' });

test('a signing profile recorded without parents, linked to a TSP profile, is deactivated from the live activation and deleted', async () => {
    const core = fullCore({}, 2);
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'signingProfiles', [bareSigningLine()]);
    expect(error).toBeUndefined();
    expect(core.writes()[0]).toBe(`PATCH /api/v1/signingProfiles/${SIGNING}/protocols/tsp/deactivate`);
    expect(core.signing.has(SIGNING)).toBe(false);
    expect(core.tsp.has(TSP), 'the TSP profile is not touched').toBe(true);
});

test('a signing profile recorded without parents and not linked to any TSP profile is emptied and deleted, no deactivate', async () => {
    const core = fullCore({}, 3);
    core.signing.get(SIGNING)!.tsp = undefined;
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const { error } = await run(core, 'signingProfiles', [bareSigningLine()]);
    expect(error).toBeUndefined();
    expect(core.writes().some((w) => w.startsWith('PATCH'))).toBe(false);
    expect(core.signing.has(SIGNING)).toBe(false);
});

test('a TSP profile\'s handler also finds an activated signing profile that has no parents in the ledger', async () => {
    const core = fullCore();
    core.tsp.get(TSP)!.defaultSigning = undefined;
    const tspLine: LedgerLine = { ...lines()[2], parents: undefined };
    const { error } = await run(core, 'tspProfiles', [bareSigningLine(), tspLine]);
    expect(error).toBeUndefined();
    expect(core.writes()).toContain(`PATCH /api/v1/signingProfiles/${SIGNING}/protocols/tsp/deactivate`);
    expect(core.tsp.has(TSP)).toBe(false);
});

// ------------------------------------------------------------------ the whole chain in the integrated DELETE_ORDER

const rankIn = (table: Array<{ step: number; types: string[] }>, type: string): [number, number] => {
    const step = table.find((s) => s.types.includes(type));
    return step ? [step.step, step.types.indexOf(type)] : [99, 0];
};
const before = (table: Array<{ step: number; types: string[] }>, first: string, second: string): boolean => {
    const [s1, r1] = rankIn(table, first);
    const [s2, r2] = rankIn(table, second);
    return s1 < s2 || (s1 === s2 && r1 < r2);
};

test('the chain TSP profile → signing profile → time-quality configuration, in DELETE_ORDER, removes everything', async () => {
    const core = fullCore({ perPage: 2, secretLag: 2 }, 5);
    const ledger = lines();
    const order = DELETE_ORDER;
    const sorted = [...ledger].sort((a, b) => rankIn(order, a.type)[0] - rankIn(order, b.type)[0] || rankIn(order, a.type)[1] - rankIn(order, b.type)[1]);
    expect(sorted.map((l) => l.type)).toEqual(['tspProfiles', 'signingProfiles', 'timeQualityConfigurations']);
    for (const l of sorted) {
        const { error } = await run(core, l.type, ledger);
        expect(error, `${l.type}: ${String(error)}`).toBeUndefined();
    }
    expect([core.tsp.size, core.signing.size, core.tqc.size]).toEqual([0, 0, 0]);
    expect(core.secrets.has(SECRET_A) || core.secrets.has(SECRET_B)).toBe(false);
});

test('the chain with a spec-added Basic credential (credential first) removes the credential, its secret and everything after it', async () => {
    const core = credentialCore({ perPage: 2, secretLag: 1 });
    const ledger = [...lines(), credentialLine()];
    const order = DELETE_ORDER;
    const sorted = [...ledger].sort((a, b) => rankIn(order, a.type)[0] - rankIn(order, b.type)[0] || rankIn(order, a.type)[1] - rankIn(order, b.type)[1]);
    expect(sorted.map((l) => l.type)).toEqual(['tspBasicCredentials', 'tspProfiles', 'signingProfiles', 'timeQualityConfigurations']);
    for (const l of sorted) {
        const { error } = await run(core, l.type, ledger);
        expect(error, `${l.type}: ${String(error)}`).toBeUndefined();
    }
    expect([core.tsp.size, core.signing.size, core.tqc.size, core.credentials.size]).toEqual([0, 0, 0, 0]);
    expect([...core.secrets.keys()]).toEqual([FOREIGN_SECRET]);
});

test('in the wrong order (signing profile first) core refuses and the handler names what blocks it; nothing foreign is touched', async () => {
    const core = fullCore({}, 1);
    const ledger = lines();
    const first = await run(core, 'signingProfiles', ledger);
    expect(first.error.blockedBy).toMatch(/TSP profile naming it as its default/);
    const second = await run(core, 'timeQualityConfigurations', ledger);
    expect(second.error.blockedBy).toMatch(/signing profile referencing it/);
    expect(core.tsp.has(TSP) && core.signing.has(SIGNING) && core.tqc.has(TQC)).toBe(true);
});

// ------------------------------------------------------------------ the descriptor against the proposed placement

test('every descriptor type has a handler in the module it names, and the handler\'s live read is the descriptor\'s detail URL', async () => {
    expect(TIMESTAMPING_RESOURCE_TYPES.map((d) => d.type).sort()).toEqual(Object.keys(teardownHandlers).sort());
    for (const d of TIMESTAMPING_RESOURCE_TYPES) {
        expect(HANDLER_MODULES[d.type], `${d.type}: the registry names the timestamping handler module`).toBe('timestamping');
        expect(handlerOf(d.type), `${d.type} loads`).toBeTruthy();
        expect(d.handlerModule).toBe('../timestamping/teardown');
        const core = fullCore();
        const ledger = [...lines(), credentialLine()];
        core.credentials.set(CRED, { tsp: TSP, username: `${RUN}-cred`, secret: CRED_SECRET });
        const own = lineOf(ledger, d.type);
        await run(core, d.type, ledger);
        expect(core.calls[0], `${d.type}: the first call is the live read`).toBe(`GET ${d.liveRead.detailUrl(own.uuid, own.parents)}`);
        expect(d.liveRead.nameField).toBe(d.type === 'tspBasicCredentials' ? 'username' : 'name');
    }
});

test('every referencedBy pair is satisfied by DELETE_ORDER: the four types joined step 3, after discoveries, before certificates and keys', () => {
    expect(TIMESTAMPING_REFERENCED_BY.length).toBeGreaterThanOrEqual(10);
    const wrong = TIMESTAMPING_REFERENCED_BY.filter((p) => !before(DELETE_ORDER, p.b, p.a)).map((p) => `${p.b} must be deleted before ${p.a}`);
    expect(wrong).toEqual([]);
    const known = new Set(DELETE_ORDER.flatMap((s) => s.types));
    for (const p of TIMESTAMPING_REFERENCED_BY) expect(known.has(p.a) && known.has(p.b), `${p.a} / ${p.b} are in DELETE_ORDER`).toBe(true);
    // the steps stay consecutive (no renumbering) and each new type appears once
    expect(DELETE_ORDER.map((s) => s.step)).toEqual(DELETE_ORDER.map((_s, i) => i + 1));
    const counts = new Map<string, number>();
    for (const s of DELETE_ORDER) for (const t of s.types) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of TIMESTAMPING_DELETE_STEP_TYPES) expect(counts.get(t), `${t} appears once`).toBe(1);
    expect(DELETE_ORDER.find((s) => s.step === 3)!.types).toEqual(['discoveries', ...TIMESTAMPING_DELETE_STEP_TYPES]);
    // the block sits before certificates and keys (a signing profile pins its certificate and token profile)
    for (const t of TIMESTAMPING_DELETE_STEP_TYPES) {
        expect(before(DELETE_ORDER, t, 'certificates')).toBe(true);
        expect(before(DELETE_ORDER, t, 'keys')).toBe(true);
    }
    // within the step: credentials, TSP profile, then signing profile, then time-quality configuration
    expect(TIMESTAMPING_DELETE_STEP_TYPES).toEqual(['tspBasicCredentials', 'tspProfiles', 'signingProfiles', 'timeQualityConfigurations']);
});

test('every pair cites core (file:line) or says it is a database constraint, appears once, and is part of REFERENCED_BY', () => {
    for (const p of TIMESTAMPING_REFERENCED_BY) expect(p.core, `${p.a} ← ${p.b}`).toMatch(/\.java:\d+|db only|handler order/);
    for (const p of TIMESTAMPING_REFERENCED_BY) {
        expect(REFERENCED_BY.filter((e) => e.a === p.a && e.b === p.b).length, `${p.a} ← ${p.b} is in REFERENCED_BY once`).toBe(1);
    }
    const keys = TIMESTAMPING_REFERENCED_BY.map((p) => `${p.a}<-${p.b}`);
    expect(new Set(keys).size).toBe(keys.length);
});

test('deleteAfter / deleteBefore agree with the pairs; the activation is a release, not an ordering pair', () => {
    const pairs = TIMESTAMPING_REFERENCED_BY;
    for (const d of TIMESTAMPING_RESOURCE_TYPES) {
        const expectedAfter = pairs.filter((p) => p.a === d.type).map((p) => p.b);
        const expectedBefore = pairs.filter((p) => p.b === d.type).map((p) => p.a);
        expect([...d.deleteAfter].sort(), `${d.type} deleteAfter`).toEqual([...new Set(expectedAfter)].sort());
        expect([...d.deleteBefore].sort(), `${d.type} deleteBefore`).toEqual([...new Set(expectedBefore)].sort());
        for (const p of d.referencedBy) expect(p.b, 'a type lists the pairs it holds').toBe(d.type);
    }
    // the cycle: signingProfiles ← tspProfiles (default) is a pair; tspProfiles ← signingProfiles (activation) is released by the PATCH
    expect(pairs.some((p) => p.a === 'signingProfiles' && p.b === 'tspProfiles')).toBe(true);
    expect(pairs.some((p) => p.a === 'tspProfiles' && p.b === 'signingProfiles')).toBe(false);
    for (const r of TIMESTAMPING_RELEASES) {
        expect(pairs.some((p) => p.a === r.a && p.b === r.b)).toBe(false);
        expect(r.by).toMatch(/deactivate/);
    }
    // users / roles are not refused by core over a TSP profile: their existing handlers need no change; the only pair that
    // names users is the credential's handler order
    for (const n of TIMESTAMPING_NOT_REFERENCED) {
        for (const p of pairs.filter((q) => q.a === n.a)) expect(p.core, `${p.a} ← ${p.b} is order only`).toMatch(/^handler order|handler order only/);
    }
});

test('the registry-shaped entries agree with the descriptor: order, step 3, handler key, URL templates and name fields', () => {
    expect(TIMESTAMPING_REGISTRY_ENTRIES.map((e) => e.type)).toEqual([...TIMESTAMPING_DELETE_STEP_TYPES]);
    const uuid = '33333333-3333-4333-8333-333333333333';
    const parent = '44444444-4444-4444-8444-444444444444';
    for (const entry of TIMESTAMPING_REGISTRY_ENTRIES) {
        const d = TIMESTAMPING_RESOURCE_TYPES.find((r) => r.type === entry.type)!;
        expect(entry.teardown, entry.type).toEqual({ step: 3, handler: 'timestamping' });
        expect(d.handlerModule, entry.type).toBe('../timestamping/teardown');
        const filled = entry.ownership.url.replace('{uuid}', uuid).replace('{parent}', parent);
        expect(filled, entry.type).toBe(d.liveRead.detailUrl(uuid, entry.ownership.kind === 'parent' ? { [entry.ownership.parent]: parent } : undefined));
        expect('nameField' in entry.ownership ? entry.ownership.nameField : 'name', entry.type).toBe(d.liveRead.nameField);
        expect(entry.snapshot.gap).toMatch(/^timestamping block: its own run has no snapshot/);
    }
});
