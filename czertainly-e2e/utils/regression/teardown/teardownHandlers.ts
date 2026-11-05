/**
 * teardownHandlers — how the run-end teardown removes each kind of object the suite can create.
 * `deleteAndVerify` sends DELETE only for an object read with 200 in this step and proves absence with a polled GET (only a 404 does).
 * 'kept' = provably not ours or adopted: no delete, a warning.
 */
import { APIRequestContext, APIResponse } from '@playwright/test';
import { listNewlyDiscoveredInventoryUuids, revokeThroughAuthority, waitUntilRevoked } from './certificateTeardownCalls';
import { assertNotDryRun } from '../run/flags';
import { absenceOf, assertOwnLive, carriesRunPrefix, derivedDeletable, checkOwnership } from '../ledger/ownership';
import { createdAfterMarker, keepingBound, LedgerLine, recordDerived } from '../ledger/ledger';
import type { TeardownContext, TeardownHandler } from './teardownTypes';
import { pollUntil } from '../wait';
import { objectOf } from '../json';
import type { JsonObject } from '../json';


const parent = (line: LedgerLine, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

const parentList = (line: LedgerLine, key: string): string[] => {
    const v = line.parents?.[key];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

async function getJson(api: APIRequestContext, url: string): Promise<JsonObject | undefined> {
    const resp = await api.get(url);
    if (resp.status() === 404) return undefined;
    if (!resp.ok()) throw new Error(`GET ${url} failed: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
    return (await resp.json()) as JsonObject;
}

function blocked(message: string, blockedBy: string): Error {
    return Object.assign(new Error(message), { blockedBy });
}

/**
 * Polls `detailUrl` until absence is proven (a 404; roles / users: a 5xx confirmed through the full list, core#2511). A 2xx after all
 * attempts means the delete did not happen.
 */
async function verifyGone(ctx: TeardownContext, spec: { uuid: string; what: string; detailUrl: string; type?: string }, attempts = 5): Promise<void> {
    const last = await pollUntil(
        () => absenceOf(ctx.api, spec.type, spec.uuid, spec.detailUrl),
        (a) => a.absent,
        { attempts, timeoutMs: Number.POSITIVE_INFINITY, intervalMs: ctx.pollMs ?? 1000, tolerateErrors: 0, onTimeout: 'return' },
    );
    if (last?.absent) {
        if (last.knownBug) (ctx.knownBug ?? ((n) => ctx.warn(`known bug ${n.bug}: ${n.type} ${n.uuid}: ${n.note}`)))(last.knownBug);
        return;
    }
    const detail = last && !last.absent ? last.detail : '';
    throw new Error(`${spec.what}: the delete was answered but ${detail}: not deleted (absence not proven)`);
}

export interface DeleteSpec {
    uuid: string;
    what: string;
    detailUrl: string;
    deleteUrl?: string;
    send?: () => Promise<APIResponse>;
    type?: string;
}

/**
 * DELETE only an object read with 200 in this step, then prove absence by
 * GET; without a prior 200 the step fails (a wrong route is not a deletion).
 */
export async function deleteAndVerify(ctx: TeardownContext, spec: DeleteSpec): Promise<void> {
    assertNotDryRun(`deleteAndVerify ${spec.what}`);
    if (!ctx.seen.has(spec.uuid)) throw new Error(`${spec.what}: route or object missing (not read with 200 in this step; refusing a blind delete)`);
    const resp = spec.send ? await spec.send() : await ctx.api.delete(spec.deleteUrl ?? spec.detailUrl);
    if (!resp.ok() && resp.status() !== 404) {
        throw new Error(`Failed to delete ${spec.what}: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
    }
    await verifyGone(ctx, spec);
}

async function ownLive(ctx: TeardownContext, type: string, line: LedgerLine | { uuid: string }, helper: string): Promise<JsonObject | undefined> {
    const { body } = await assertOwnLive(ctx.api, type, line, helper, { lines: ctx.ledger, runId: ctx.runId, tier: ctx.tier, ...(ctx.knownBug ? { onKnownBug: ctx.knownBug } : {}) });
    if (body) ctx.seen.add(line.uuid);
    return body;
}

async function authorityOfRaProfile(ctx: TeardownContext, raProfileUuid: string): Promise<string | undefined> {
    const own = ctx.ledger.find((l) => l.uuid === raProfileUuid && l.event === 'created');
    const fromLedger = own && parent(own, 'authority');
    if (fromLedger) return fromLedger;
    const authority = (await getJson(ctx.api, `/api/v1/raProfiles/${raProfileUuid}`))?.authorityInstanceUuid;
    return typeof authority === 'string' ? authority : undefined;
}

function liveOwn(ctx: TeardownContext, type: string): LedgerLine[] {
    return liveOwnLines(ctx.ledger, ctx.runId, type);
}

export function liveOwnLines(lines: LedgerLine[], runId: string, type: string): LedgerLine[] {
    return lines.filter((l) => l.type === type && l.event === 'created' && checkOwnership(l, { lines, runId }).own);
}

export const hasLiveOwn = (lines: LedgerLine[], runId: string, type: string): boolean => liveOwnLines(lines, runId, type).length > 0;

const liveOwnUuids = (ctx: TeardownContext, type: string): Set<string> => new Set(liveOwn(ctx, type).map((l) => l.uuid.toLowerCase()));

export interface OwnAttachments {
    groups: Set<string>;
    users: Set<string>;
    raProfiles: Set<string>;
}

const inSet = (set: Set<string> | undefined, uuid: unknown): boolean => typeof uuid === 'string' && !!set?.has(uuid.toLowerCase());

/**
 * What makes a discovered certificate someone's (kept, not deleted): attached to something that is not this run's own live object;
 * `locations` and a `certificateRequest` always adopt.
 */
export function adoptionOf(cert: JsonObject, own?: OwnAttachments): string[] {
    const why: string[] = [];
    const ra = objectOf(cert.raProfile).uuid;
    if (ra && !inSet(own?.raProfiles, ra)) why.push('RA profile');
    const owner = cert.ownerUuid ?? (cert.owner ? '(name only)' : undefined);
    if ((cert.owner || cert.ownerUuid) && !inSet(own?.users, owner)) why.push('owner');
    if (Array.isArray(cert.groups) && cert.groups.length && !cert.groups.every((g: JsonObject) => inSet(own?.groups, g?.uuid))) why.push('groups');
    if (Array.isArray(cert.locations) && cert.locations.length) why.push('locations');
    if (cert.certificateRequest) why.push('certificate request');
    return why;
}

export async function certificateCreationTime(api: APIRequestContext, uuid: string): Promise<string | undefined> {
    const resp = await api.get(`/api/v1/certificates/${uuid}/history`);
    if (!resp.ok()) return undefined;
    const events = (await resp.json()) as Array<{ created?: string }>;
    const times = events.map((e) => Date.parse(e.created ?? '')).filter((t) => !Number.isNaN(t));
    return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

/**
 * The own compliance profile teardown: remove the associations of own RA profiles, DELETE v1, then v2 force when refused (a non-empty
 * answer is a failure), then prove absence by GET.
 */
export async function removeComplianceProfile(ctx: TeardownContext, uuid: string): Promise<void> {
    const associationsOf = async (): Promise<JsonObject[] | undefined> => {
        const r = await ctx.api.get(`/api/v2/complianceProfiles/${uuid}/associations`);
        if (!r.ok()) return undefined;
        const rows = (await r.json().catch(() => [])) as JsonObject[];
        return Array.isArray(rows) ? rows : [];
    };
    const first0 = await associationsOf();
    if (first0) {
        for (const a of first0) {
            const resource = String(a.resource ?? '');
            const object = String(a.objectUuid ?? a.uuid ?? '');
            if (resource !== 'raProfiles' || !object) continue;
            if (!checkOwnership({ uuid: object }, { lines: ctx.ledger, runId: ctx.runId }).own) continue;
            const d = await ctx.api.delete(`/api/v2/complianceProfiles/${uuid}/associations/raProfiles/${object}`);
            if (!d.ok() && d.status() !== 404) ctx.warn(`compliance profile ${uuid}: removing the association of own RA profile ${object} answered ${d.status()}`);
        }
    }
    await deleteAndVerify(ctx, {
        uuid, what: `compliance profile ${uuid}`, detailUrl: `/api/v1/complianceProfiles/${uuid}`,
        send: async () => {
            const first = await ctx.api.delete(`/api/v1/complianceProfiles/${uuid}`);
            if (first.ok()) return first;
            if (first.status() === 404) {
                // A 404 is success only when a re-read no longer finds the profile
                // (a dangling association can cause it); otherwise reported blocked.
                const again = await ctx.api.get(`/api/v1/complianceProfiles/${uuid}`);
                if (again.status() === 404) return first;
                throw blocked(`compliance profile ${uuid}: DELETE answered 404 but the profile still exists (GET ${again.status()}) — dangling association to a deleted RA profile (core suspected product defect), left as is, not force-deleted`, `compliance profile association of a deleted RA profile ${uuid}`);
            }
            const firstText = (await first.text()).replace(/\s+/g, ' ').slice(0, 300);
            // v2 force deletes every association, foreign ones too: re-read them first and force only an empty list.
            const left = await associationsOf();
            if (left && left.length) {
                throw blocked(`compliance profile ${uuid}: DELETE /v1 answered ${first.status()} (${firstText}); ${left.length} association(s) not made by this run remain (${left.map((a) => `${String(a.resource)} ${String(a.objectUuid ?? a.uuid)}`).join(', ').slice(0, 200)}) — foreign association left as is, the profile is not force-deleted`, `compliance profile associations ${uuid}`);
            }
            if (!left) throw new Error(`compliance profile ${uuid}: DELETE /v1 answered ${first.status()} (${firstText}); the associations cannot be read, so the force delete (which removes every association) is not sent`);
            const forced = await ctx.api.delete('/api/v2/complianceProfiles/force', { data: [uuid] });
            if (!forced.ok()) throw new Error(`compliance profile ${uuid}: DELETE /v1 answered ${first.status()} (${firstText}); DELETE /v2/force answered ${forced.status()} - ${(await forced.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
            const messages = ((await forced.json().catch(() => [])) as JsonObject[]) ?? [];
            if (Array.isArray(messages) && messages.length) {
                throw new Error(`compliance profile ${uuid}: DELETE /v1 answered ${first.status()} (${firstText}); DELETE /v2/force refused: ${messages.map((m) => `${m.name ?? m.uuid}: ${m.message}`).join('; ').slice(0, 400)}`);
            }
            return forced;
        },
    });
}

/**
 * Safety net: core links a `certKey_<CN>` key to every issued / imported / registered certificate. Before an own certificate is
 * deleted, a matching key (exact name, in no token, only this certificate associated, not older than a minute before it) is
 * recorded as a derived key line for the keys step. With no server time the key is recorded with `keepingBound()` and kept.
 */
export async function recordCertKeySafetyNet(ctx: TeardownContext, line: LedgerLine, cert: JsonObject): Promise<string[]> {
    const cn = String(cert.commonName ?? line.name ?? '');
    if (!carriesRunPrefix(cn, ctx.runId, 'certificates')) return [];
    const wanted = `certKey_${cn}`;
    const candidates = new Set<string>();
    const keyUuid = objectOf(cert.key).uuid;
    if (typeof keyUuid === 'string') candidates.add(keyUuid);
    try {
        const res = await ctx.api.post('/api/v1/keys', { data: { itemsPerPage: 100, pageNumber: 1, filters: [{ fieldSource: 'property', fieldIdentifier: 'CKI_NAME', condition: 'EQUALS', value: wanted }] } });
        if (res.ok()) {
            for (const row of ((await res.json()) as { cryptographicKeys?: JsonObject[] }).cryptographicKeys ?? []) {
                if (String(row.name) === wanted) candidates.add(String(row.keyWrapperUuid ?? ''));
            }
        } else {
            ctx.warn(`certificate ${line.uuid}: key search by name answered ${res.status()}; the linked key of the detail is still checked`);
        }
    } catch (e) {
        ctx.warn(`certificate ${line.uuid}: key search by name failed (${String(e).slice(0, 100)}); the linked key of the detail is still checked`);
    }
    candidates.delete('');
    const created = await certificateCreationTime(ctx.api, line.uuid);
    // The server's clock (history, else the ledger line's Date); with neither, the key is recorded with the keeping bound and kept.
    const basis = Date.parse(String(created || line.serverAt || ''));
    const judged = !Number.isNaN(basis);
    if (!judged && candidates.size) ctx.warn(`certificate ${line.uuid}: no server time for its creation (no history, no server date on its ledger line); its certKey_ key is recorded to be kept, check by hand`);
    const bound = judged ? new Date(basis - 60_000) : new Date(keepingBound());
    const recorded: string[] = [];
    for (const wrapper of candidates) {
        if (checkOwnership({ uuid: wrapper }, { lines: ctx.ledger, runId: ctx.runId }).own) continue;
        const res = await ctx.api.get(`/api/v1/keys/${wrapper}`);
        // 404 = an item uuid or a gone key; never deleted directly.
        if (res.status() === 404) continue;
        if (!res.ok()) { ctx.warn(`certificate ${line.uuid}: key ${wrapper} unreadable (${res.status()}); not recorded`); continue; }
        const key = (await res.json()) as JsonObject;
        const others = keyAssociationsOf(key).filter((a) => String(objectOf(a).uuid ?? a) !== line.uuid);
        if (String(key.name) !== wanted || key.tokenInstanceUuid || others.length || (judged && (!key.creationTime || Date.parse(String(key.creationTime)) < bound.getTime()))) {
            ctx.warn(`certificate ${line.uuid}: key ${wrapper} does not qualify for the leftover net (name ${String(key.name)}, token ${key.tokenInstanceUuid ? 'yes' : 'no'}, other associations ${others.length})`);
            continue;
        }
        recordDerived('keys', { uuid: wrapper, name: wanted }, { spec: 'runTeardown', createdAfter: bound, note: judged ? 'certKey_ key of an own certificate, found by the teardown safety net' : 'certKey_ key of an own certificate, found by the teardown safety net; no server time, kept', parents: { certificate: line.uuid }, runId: ctx.runId });
        recorded.push(wrapper);
    }
    return recorded;
}

/**
 * Every element of a key's `associations`, whatever its shape; a value that
 * is not a list counts as one foreign element, so the key reads as USED.
 */
export const keyAssociationsOf = (key: JsonObject): unknown[] => {
    const value: unknown = key.associations;
    if (Array.isArray(value)) return value;
    return value === undefined || value === null ? [] : [{ unreadable: value }];
};

const certificates: TeardownHandler = {
    action: 'derived: keep unless made after createdAfter and not adopted; issued with an RA profile: revoke (v2) → wait revoked → delete; else delete',
    async remove(ctx, line) {
        const cert = ctx.live!;
        if (line.derived) {
            // Deleted only when nobody adopted it AND the platform created it at or after createdAfter (server clock); an own group / user
            // / RA profile is no adoption.
            const adopted = adoptionOf(cert, { groups: liveOwnUuids(ctx, 'groups'), users: liveOwnUuids(ctx, 'users'), raProfiles: liveOwnUuids(ctx, 'raProfiles') });
            if (adopted.length) {
                ctx.warn(`kept derived certificate ${line.uuid}: adopted (${adopted.join(', ')})`);
                return 'kept';
            }
            const created = await certificateCreationTime(ctx.api, line.uuid);
            if (!created) {
                throw new Error(`derived certificate ${line.uuid}: creation time unknown (history unreadable or empty); not deleted, ` +
                    'not provably made by this run: check it by hand');
            }
            if (!derivedDeletable(line, created)) {
                ctx.warn(`kept derived certificate ${line.uuid}: creation time ${created} is before createdAfter ${line.createdAfter}`);
                return 'kept';
            }
        }
        if (!line.derived) {
            const found = await recordCertKeySafetyNet(ctx, line, cert);
            if (found.length) ctx.warn(`certificate ${line.uuid}: its certKey_ key ${found.join(', ')} was not in the ledger; recorded now, the keys step removes it`);
        }
        if (cert.state === 'issued') {
            const raProfileUuid = parent(line, 'raProfile') ?? stringOf(objectOf(cert.raProfile).uuid);
            const authorityUuid = parent(line, 'authority') ?? stringOf(objectOf(cert.raProfile).authorityInstanceUuid);
            if (raProfileUuid && authorityUuid) {
                try {
                    await revokeThroughAuthority(ctx.api, { authorityUuid, raProfileUuid, certUuid: line.uuid, reason: 'unspecified' });
                } catch (e) {
                    throw blocked(`revoke refused: ${String(e).slice(0, 300)}`, `authority ${authorityUuid}`);
                }
                await waitUntilRevoked(ctx.api, line.uuid, 120_000);
            }
        }
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `certificate ${line.uuid}`, detailUrl: `/api/v1/certificates/${line.uuid}` });
    },
};

const bulkKeyCall = (ctx: TeardownContext, method: 'patch' | 'delete', path: string, uuid: string): Promise<APIResponse> =>
    method === 'patch' ? ctx.api.patch(path, { data: [uuid] }) : ctx.api.delete(path, { data: [uuid] });

/**
 * The one handler for every own (non-derived) token key: without it core refuses to delete the token profile and token.
 * `DELETE /v1/keys` answers 204 even for an unknown uuid, so absence is proven by GET; if refused, the items are deactivated and destroyed
 * first and the delete is sent once more.
 */
async function removeOwnTokenKey(ctx: TeardownContext, line: LedgerLine): Promise<void> {
    const uuid = line.uuid;
    const detailUrl = `/api/v1/keys/${uuid}`;
    if (!ctx.seen.has(uuid)) throw new Error(`key ${uuid}: route or object missing (not read with 200 in this step; refusing a blind delete)`);
    let last: APIResponse | undefined;
    const attempt = async (): Promise<boolean> => {
        last = await bulkKeyCall(ctx, 'delete', '/api/v1/keys', uuid);
        return last.ok() || last.status() === 404;
    };
    if (!await attempt()) {
        const refused = `${last!.status()} - ${(await last!.text()).slice(0, 200)}`;
        ctx.warn(`key ${uuid}: DELETE /v1/keys answered ${refused}; deactivating and destroying its items, then deleting again`);
        for (const path of ['/api/v1/keys/disable', '/api/v1/keys/destroy']) {
            const r = await bulkKeyCall(ctx, 'patch', path, uuid);
            if (!r.ok() && r.status() !== 404) ctx.warn(`key ${uuid}: PATCH ${path.replace('/api', '')} answered ${r.status()} (ignored, the delete decides)`);
        }
        if (!await attempt()) throw new Error(`Failed to delete key ${uuid}: ${last!.status()} - ${(await last!.text()).slice(0, 300)} (after deactivate / destroy; first answer ${refused})`);
    }
    await deleteAndVerify(ctx, { uuid, what: `key ${uuid}`, detailUrl, send: async () => last! });
}

const keys: TeardownHandler = {
    action: 'derived certKey_*: delete when not in a token, made after createdAfter and unused; own token key: bulk DELETE /v1/keys (items deactivated + destroyed first when refused), absence by GET',
    async remove(ctx, line) {
        if (!line.derived) return removeOwnTokenKey(ctx, line);
        const key = ctx.live!;
        if (!key.creationTime) {
            throw new Error(`derived key ${line.uuid}: creation time unknown (no creationTime on the detail); not deleted, ` +
                'not provably made by this run: check it by hand');
        }
        const inToken = !!key.tokenInstanceUuid;
        const createdByUs = derivedDeletable(line, stringOf(key.creationTime));
        const associationCount = keyAssociationsOf(key).length;
        const used = associationCount > 0;
        if (inToken || !createdByUs || used) {
            ctx.warn(`kept derived key ${line.uuid}: token=${inToken ? 'yes' : 'no'} created=${key.creationTime ?? '-'} (after ${line.createdAfter}) ` +
                `associations=${associationCount}`);
            return 'kept';
        }
        await deleteAndVerify(ctx, {
            uuid: line.uuid,
            what: `key ${line.uuid}`,
            detailUrl: `/api/v1/keys/${line.uuid}`,
            send: () => ctx.api.delete('/api/v1/keys', { data: [line.uuid] }),
        });
    },
};

/**
 * A key item goes with its key: `goneWith` is true when the parent key has a
 * `deleted` line of this run; an item still present is reported as blocked.
 */
const keyItems: TeardownHandler = {
    action: 'gone with its key (no request): the key\'s `deleted` line explains the 404; a remaining item is reported, blocked by its key',
    goneWith(ctx, line) {
        const key = parent(line, 'key');
        return !!key && ctx.ledger.some((l) => l.event === 'deleted' && l.runId === ctx.runId && l.type === 'keys' && l.uuid === key);
    },
    async remove(ctx, line) {
        const key = parent(line, 'key') ?? '(unknown key)';
        throw blocked(`key item ${line.uuid} is still present: its key was not removed (items go with their key)`, `keys ${key}`);
    },
};

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const discoveries: TeardownHandler = {
    action: 'record the certificates it onboarded as new (derived; createdAfter from the server clock, else the keeping bound), then delete the discovery',
    async remove(ctx, line) {
        const discovery = ctx.live!;
        // The server's clock (the discovery's start time, else the create response's Date); with neither, the certificates are recorded
        // with the keeping bound.
        const serverTime = stringOf(discovery.startTime) ?? line.serverAt;
        const createdAfter = serverTime ? createdAfterMarker(serverTime) : keepingBound();
        if (!serverTime) ctx.warn(`discovery ${line.uuid}: no server timestamp; the certificates it onboarded are recorded to be kept, check by hand`);
        const known = new Set(ctx.ledger.map((l) => l.uuid));
        for (const uuid of await listNewlyDiscoveredInventoryUuids(ctx.api, line.uuid)) {
            if (!known.has(uuid)) {
                recordDerived('certificates', { uuid, name: `onboarded by discovery ${line.uuid}` }, { spec: 'runTeardown', createdAfter, note: serverTime ? 'new in the inventory through an own discovery' : 'new in the inventory through an own discovery; no server time, kept', parents: { discovery: line.uuid }, runId: ctx.runId });
            }
        }
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `discovery ${line.uuid}`, detailUrl: `/api/v1/discoveries/${line.uuid}` });
    },
};

const acmeProfiles: TeardownHandler = {
    action: 'deactivate on every own RA profile it is active on (each RA profile checked live), disable when enabled, delete',
    async remove(ctx, line) {
        // Core refuses the delete while any RA profile still has the profile activated.
        const candidates = new Set([...parentList(line, 'raProfiles'), ...liveOwn(ctx, 'raProfiles').map((l) => l.uuid)]);
        for (const raUuid of candidates) {
            let authorityUuid: string | undefined;
            try {
                authorityUuid = await authorityOfRaProfile(ctx, raUuid);
            } catch {
                authorityUuid = undefined;
            }
            if (!authorityUuid) continue;
            const info = await getJson(ctx.api, `/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}/protocols/acme`);
            if (!info?.acmeAvailable || (info.uuid !== line.uuid && info.name !== line.name)) continue;
            await ownLive(ctx, 'raProfiles', { uuid: raUuid }, 'teardown.acmeProfiles (deactivate)');
            const resp = await ctx.api.patch(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}/protocols/acme/deactivate`);
            if (!resp.ok() && resp.status() !== 404) {
                throw new Error(`Failed to deactivate ACME on RA profile ${raUuid}: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
            }
        }
        // Core refuses to disable a disabled profile.
        if (ctx.live?.enabled === true) {
            const disable = await ctx.api.patch(`/api/v1/acmeProfiles/${line.uuid}/disable`);
            if (!disable.ok() && disable.status() !== 404) {
                throw new Error(`Failed to disable ACME profile ${line.uuid}: ${disable.status()} - ${(await disable.text()).slice(0, 300)}`);
            }
        }
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `ACME profile ${line.uuid}`, detailUrl: `/api/v1/acmeProfiles/${line.uuid}` });
    },
};

const acmeAccounts: TeardownHandler = {
    action: 'id-named; expected to go with its ACME profile (no delete endpoint): list read, then detail read; a remaining account is reported',
    async remove(ctx, line) {
        const listResp = await ctx.api.get('/api/v1/acmeAccounts');
        if (!listResp.ok()) throw new Error(`ACME account ${line.uuid}: route or object missing (GET /api/v1/acmeAccounts answered ${listResp.status()})`);
        const account = ((await listResp.json()) as JsonObject[]).find((a) => a.uuid === line.uuid);
        if (account) {
            throw new Error(`ACME account ${line.uuid} is still listed (status ${account.status}) after its profile was removed; the API has no delete for accounts`);
        }
        const profile = parent(line, 'acmeProfile');
        if (profile) {
            const detail = await ctx.api.get(`/api/v1/acmeProfiles/${profile}/acmeAccounts/${line.uuid}`);
            if (detail.status() !== 404) throw new Error(`ACME account ${line.uuid}: absent from the list but its detail answers ${detail.status()}`);
        }
    },
};

const raProfiles: TeardownHandler = {
    action: 'delete (DELETE /authorities/{authority}/raProfiles/{uuid}), absence proven by GET /raProfiles/{uuid}',
    async remove(ctx, line) {
        const authorityUuid = parent(line, 'authority') ?? ctx.live?.authorityInstanceUuid;
        if (!authorityUuid) throw new Error(`RA profile ${line.uuid}: no authority known (ledger parents or detail)`);
        await deleteAndVerify(ctx, {
            uuid: line.uuid,
            what: `RA profile ${line.uuid}`,
            detailUrl: `/api/v1/raProfiles/${line.uuid}`,
            deleteUrl: `/api/v1/authorities/${authorityUuid}/raProfiles/${line.uuid}`,
        });
    },
};

const tokenProfiles: TeardownHandler = {
    action: 'delete (DELETE /tokens/{token}/tokenProfiles/{uuid}), absence proven by the same detail URL',
    async remove(ctx, line) {
        const token = parent(line, 'token') ?? ctx.live?.tokenInstanceUuid;
        if (!token) throw new Error(`token profile ${line.uuid}: no token known (ledger parents or list)`);
        const url = `/api/v1/tokens/${token}/tokenProfiles/${line.uuid}`;
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `token profile ${line.uuid}`, detailUrl: url });
    },
};

const users: TeardownHandler = {
    action: 'remove the user from its roles (PATCH /users/{uuid}/roles []), then delete (a 5xx detail: confirmed through the full list, core#2511)',
    async remove(ctx, line) {
        const rolesUrl = `/api/v1/users/${line.uuid}/roles`;
        const roles = (await getJson(ctx.api, rolesUrl)) as unknown as JsonObject[] | undefined;
        if (roles && roles.length) {
            const resp = await ctx.api.patch(rolesUrl, { data: [] });
            if (!resp.ok()) throw new Error(`Failed to remove user ${line.uuid} from its roles: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
            const left = (await getJson(ctx.api, rolesUrl)) as unknown as JsonObject[] | undefined;
            if (left?.length) throw new Error(`user ${line.uuid} still has ${left.length} role(s) after the roles were cleared`);
        }
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `user ${line.uuid}`, detailUrl: `/api/v1/users/${line.uuid}`, type: 'users' });
    },
};

/**
 * Approval-profile dissociation (a step hook before the certificate step): every own approval profile is dissociated from
 * every own RA profile, so a crashed spec cannot leave the run-end revoke gated. A pre-existing RA profile is never touched (warning).
 */
export async function ungateOwnRaProfiles(ctx: TeardownContext): Promise<void> {
    assertNotDryRun('teardown.preStep.ungateOwnRaProfiles');
    const ownRa = new Map(liveOwn(ctx, 'raProfiles').map((l) => [l.uuid.toLowerCase(), l.uuid]));
    for (const ap of liveOwn(ctx, 'approvalProfiles')) {
        await ownLive(ctx, 'approvalProfiles', ap, 'teardown.ungateOwnRaProfiles (approval profile)');
        const url = `/api/v1/approvalProfiles/${ap.uuid}/associations`;
        const read = async (): Promise<Array<{ resource: string; uuid: string }>> => {
            const rows = (await getJson(ctx.api, url)) as unknown as JsonObject[] | undefined;
            if (!Array.isArray(rows)) throw new Error(`approval profile ${ap.uuid}: ${url} did not answer a list`);
            return rows.map((r) => ({ resource: String(r?.resource ?? ''), uuid: String(r?.uuid ?? r?.objectUuid ?? r?.resourceUuid ?? '').toLowerCase() }));
        };
        for (const rel of await read()) {
            if (rel.resource !== 'raProfiles') continue;
            const raUuid = ownRa.get(rel.uuid);
            if (!raUuid) {
                ctx.warn(`approval profile ${ap.uuid} is associated with an RA profile that is not this run's (${rel.uuid}): left as it is`);
                continue;
            }
            await ownLive(ctx, 'raProfiles', { uuid: raUuid }, 'teardown.ungateOwnRaProfiles (RA profile)');
            const resp = await ctx.api.delete(`${url}/raProfiles/${raUuid}`);
            if (!resp.ok() && resp.status() !== 404) {
                throw new Error(`Failed to dissociate approval profile ${ap.uuid} from RA profile ${raUuid}: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
            }
            if ((await read()).some((r) => r.resource === 'raProfiles' && r.uuid === rel.uuid)) {
                throw new Error(`approval profile ${ap.uuid} is still associated with RA profile ${rel.uuid} after the dissociation`);
            }
        }
    }
}

const byUrl = (url: (uuid: string) => string, what: string, type?: string): TeardownHandler => ({
    action: `delete (DELETE ${url('{uuid}')}), absence proven by GET${type ? ' (a 5xx: confirmed through the full list, core#2511)' : ''}`,
    async remove(ctx, line) {
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `${what} ${line.uuid}`, detailUrl: url(line.uuid), type });
    },
});

export const teardownHandlers: Record<string, TeardownHandler> = {
    certificates,
    keys,
    keyItems,
    discoveries,
    acmeProfiles,
    acmeAccounts,
    raProfiles,
    tokenProfiles,
    users,
    authorities: byUrl((u) => `/api/v1/authorities/${u}`, 'authority'),
    credentials: byUrl((u) => `/api/v1/credentials/${u}`, 'credential'),
    connectors: byUrl((u) => `/api/v1/connectors/${u}`, 'connector'),
    tokens: byUrl((u) => `/api/v1/tokens/${u}`, 'token'),
    customAttributes: byUrl((u) => `/api/v1/attributes/custom/${u}`, 'custom attribute'),
    roles: byUrl((u) => `/api/v1/roles/${u}`, 'role', 'roles'),
    groups: byUrl((u) => `/api/v1/groups/${u}`, 'group'),
};

