/**
 * teardownHandlers — how the run-end teardown removes each kind of object the regression suite can create.
 *
 * Loaded lazily by runTeardown's registry (type → module) and wrapped by `wrapHandlerWithGuard`: before `remove` runs, the dry
 * run is checked and the live object is read through `assertOwnLive` (ledger line of this run on this tier, live
 * run-prefixed name for named types); `ctx.live` is that object and its uuid is in `ctx.seen`. Later batches add
 * their own `teardownHandlers` export in the module that creates the objects (protocolProfiles, cryptoApi,
 * workflowUtils, …) and get the same wrapper; until such a module exists the teardown reports "no handler (type X)".
 *
 * Deletion rule: `deleteAndVerify` sends the DELETE only for an object read with 200 in this step, accepts a 404
 * answer only then, and proves absence afterwards with a detail GET (polled: some deletes finish asynchronously).
 * Only a 404 proves absence; a 5xx never does by itself. Roles and users are the one exception path (found
 * by the first live guard proof): their detail answers 500 for a deleted uuid (known bug core#2511), so a 5xx there is
 * confirmed through the authoritative full list (`GET /v1/roles`, `GET /v1/users`; ledger/ownership.ts `absenceOf`) and the
 * workaround is logged and listed in the run's kept report (`knownBugs`). A list that still names the uuid, or that
 * cannot prove anything (unreadable, at its 1000-row cap), leaves the delete unconfirmed (red).
 * A handler that touches a SECOND object (deactivating ACME on an RA profile) checks that one live too. A handler throws
 * on failure (attemptCleanup records it); an error carrying `blockedBy` names the object that prevents it (a CA that
 * refuses the revoke). Returning 'kept' means "provably not ours" or "adopted" (a derived key the platform made before
 * the run, a discovered certificate someone assigned to a group): no delete, a warning and a line in the kept report
 * (REG_KEPT_STRICT=1 turns a non-empty kept list red). A derived object whose creation time cannot be read is NOT
 * kept quietly: the handler throws, the object stays on the tier and the run ends red, so a human checks it.
 */
import { APIRequestContext, APIResponse } from '@playwright/test';
import { revokeCertificate, waitForCertificateState } from '../../certificateUtils';
import { listNewlyDiscoveredInventoryUuids } from '../../discoveryUtils';
import { assertNotDryRun } from '../run/flags';
import { absenceOf, assertOwnLive, carriesRunPrefix, derivedDeletable, checkOwnership } from '../ledger/ownership';
import { createdAfterMarker, LedgerLine, recordDerived } from '../ledger/ledger';
import type { TeardownContext, TeardownHandler } from './runTeardown';
import { pollUntil } from '../wait';

type Json = Record<string, any>;

const parent = (line: LedgerLine, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

const parentList = (line: LedgerLine, key: string): string[] => {
    const v = line.parents?.[key];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

/** GET that answers the body on 2xx, undefined on 404, and throws on anything else. */
async function getJson(api: APIRequestContext, url: string): Promise<Json | undefined> {
    const resp = await api.get(url);
    if (resp.status() === 404) return undefined;
    if (!resp.ok()) throw new Error(`GET ${url} failed: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
    return (await resp.json()) as Json;
}

function blocked(message: string, blockedBy: string): Error {
    return Object.assign(new Error(message), { blockedBy });
}

/**
 * Polls `detailUrl` until absence is proven (`absenceOf`: a 404; for roles / users a 5xx confirmed through the full
 * list, core#2511). A 2xx after all attempts means the delete did not happen; a 5xx is never accepted alone.
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
    /** Detail URL whose 404 proves the object gone. */
    detailUrl: string;
    /** DELETE URL (default detailUrl). */
    deleteUrl?: string;
    /** A custom removal call (a bulk DELETE with a body) instead of DELETE deleteUrl. */
    send?: () => Promise<APIResponse>;
    /** The ledger type: roles / users may confirm a 5xx detail read through their full list (core#2511). */
    type?: string;
}

/**
 * Deletion rule: DELETE only an object read with 200 in this step; a 404 answer counts only then; absence is proven by GET.
 * Without a prior 200 the step fails: a wrong route must never be mistaken for a deleted object.
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

/** Read a second object (not the handler's own line) live, marking it seen; LiveObjectMissing propagates. */
async function ownLive(ctx: TeardownContext, type: string, line: LedgerLine | { uuid: string }, helper: string): Promise<Json | undefined> {
    const { body } = await assertOwnLive(ctx.api, type, line, helper, { lines: ctx.ledger, runId: ctx.runId, tier: ctx.tier, ...(ctx.knownBug ? { onKnownBug: ctx.knownBug } : {}) });
    if (body) ctx.seen.add(line.uuid);
    return body;
}

/** The authority of an RA profile: the ledger's parents, else the RA profile detail (read-only). */
async function authorityOfRaProfile(ctx: TeardownContext, raProfileUuid: string): Promise<string | undefined> {
    const own = ctx.ledger.find((l) => l.uuid === raProfileUuid && l.event === 'created');
    const fromLedger = own && parent(own, 'authority');
    if (fromLedger) return fromLedger;
    return (await getJson(ctx.api, `/api/v1/raProfiles/${raProfileUuid}`))?.authorityInstanceUuid;
}

/** Live (created, not deleted) ledger objects of this run of one type. */
function liveOwn(ctx: TeardownContext, type: string): LedgerLine[] {
    return liveOwnLines(ctx.ledger, ctx.runId, type);
}

/** Live (created, not deleted, own) ledger lines of one type (the same rule as the handlers' `liveOwn`). */
export function liveOwnLines(lines: LedgerLine[], runId: string, type: string): LedgerLine[] {
    return lines.filter((l) => l.type === type && l.event === 'created' && checkOwnership(l, { lines, runId }).own);
}

export const hasLiveOwn = (lines: LedgerLine[], runId: string, type: string): boolean => liveOwnLines(lines, runId, type).length > 0;

/** The lower-case uuids of live own lines of a type. */
const liveOwnUuids = (ctx: TeardownContext, type: string): Set<string> => new Set(liveOwn(ctx, type).map((l) => l.uuid.toLowerCase()));

/** The own objects a derived certificate may be attached to without counting as adopted. */
export interface OwnAttachments {
    groups: Set<string>;
    users: Set<string>;
    raProfiles: Set<string>;
}

const inSet = (set: Set<string> | undefined, uuid: unknown): boolean => typeof uuid === 'string' && !!set?.has(uuid.toLowerCase());

/**
 * What makes a discovered certificate someone's: kept and reported instead of deleted.
 * "Adopted" means attached to something that is NOT this run's own — with `own` given,
 * an RA profile, an owner and every group must each be an own, live ledger object of this run (the sets), else the
 * certificate is kept as before; `locations` and a `certificateRequest` always adopt. Without `own` (the old call) the
 * answer is the old one: any attachment adopts. The order makes it safe: certificates are step 4, groups / users / RA
 * profiles later, so the own objects still exist when the certificate is judged and are deleted afterwards anyway.
 */
export function adoptionOf(cert: Json, own?: OwnAttachments): string[] {
    const why: string[] = [];
    const ra = cert.raProfile?.uuid;
    if (ra && !inSet(own?.raProfiles, ra)) why.push('RA profile');
    const owner = cert.ownerUuid ?? (cert.owner ? '(name only)' : undefined);
    if ((cert.owner || cert.ownerUuid) && !inSet(own?.users, owner)) why.push('owner');
    if (Array.isArray(cert.groups) && cert.groups.length && !cert.groups.every((g: Json) => inSet(own?.groups, g?.uuid))) why.push('groups');
    if (Array.isArray(cert.locations) && cert.locations.length) why.push('locations');
    if (cert.certificateRequest) why.push('certificate request');
    return why;
}

/** The platform's creation time of a certificate: the earliest event of its history (the detail DTO has no such field). */
export async function certificateCreationTime(api: APIRequestContext, uuid: string): Promise<string | undefined> {
    const resp = await api.get(`/api/v1/certificates/${uuid}/history`);
    if (!resp.ok()) return undefined;
    const events = (await resp.json()) as Array<{ created?: string }>;
    const times = events.map((e) => Date.parse(e.created ?? '')).filter((t) => !Number.isNaN(t));
    return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

/**
 * The own compliance profile teardown (seen on a live tier: a single DELETE failed with "no status" and no text). Steps: (1) read
 * the associations (`GET /v2/complianceProfiles/{uuid}/associations`) and remove those of OWN RA profiles of this run (a
 * pre-existing object's association is never touched; it makes the delete fail and is reported); (2) `DELETE /v1/complianceProfiles/{uuid}`;
 * (3) when that is refused, `DELETE /v2/complianceProfiles/force` with `[uuid]`: core answers a list of `BulkActionMessageDto`
 * (uuid, name, message) for what it could not delete, so a non-empty list is a failure carrying the messages; (4) absence by GET.
 */
export async function removeComplianceProfile(ctx: TeardownContext, uuid: string): Promise<void> {
    const associationsOf = async (): Promise<Json[] | undefined> => {
        const r = await ctx.api.get(`/api/v2/complianceProfiles/${uuid}/associations`);
        if (!r.ok()) return undefined;
        const rows = (await r.json().catch(() => [])) as Json[];
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
                // suspected defect: a dangling association to a deleted RA profile makes core answer 404 although the profile exists.
                // A 404 is success only when a re-read no longer finds the profile; otherwise it is reported blocked, never forced.
                const again = await ctx.api.get(`/api/v1/complianceProfiles/${uuid}`);
                if (again.status() === 404) return first;
                throw blocked(`compliance profile ${uuid}: DELETE answered 404 but the profile still exists (GET ${again.status()}) — dangling association to a deleted RA profile (core suspected product defect), left as is, not force-deleted`, `compliance profile association of a deleted RA profile ${uuid}`);
            }
            const firstText = (await first.text()).replace(/\s+/g, ' ').slice(0, 300);
            // Core's v2 force deletes EVERY association of the profile, foreign ones too. v1 refuses exactly because
            // an association is left, so before any force the associations are read again: anything left (a foreign one) is left as is and
            // reported; the force is sent only for an empty list (or when the list cannot be read at all and the v1 refusal named none).
            const left = await associationsOf();
            if (left && left.length) {
                throw blocked(`compliance profile ${uuid}: DELETE /v1 answered ${first.status()} (${firstText}); ${left.length} association(s) not made by this run remain (${left.map((a) => `${String(a.resource)} ${String(a.objectUuid ?? a.uuid)}`).join(', ').slice(0, 200)}) — foreign association left as is, the profile is not force-deleted`, `compliance profile associations ${uuid}`);
            }
            if (!left) throw new Error(`compliance profile ${uuid}: DELETE /v1 answered ${first.status()} (${firstText}); the associations cannot be read, so the force delete (which removes every association) is not sent`);
            const forced = await ctx.api.delete('/api/v2/complianceProfiles/force', { data: [uuid] });
            if (!forced.ok()) throw new Error(`compliance profile ${uuid}: DELETE /v1 answered ${first.status()} (${firstText}); DELETE /v2/force answered ${forced.status()} - ${(await forced.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
            const messages = ((await forced.json().catch(() => [])) as Json[]) ?? [];
            if (Array.isArray(messages) && messages.length) {
                throw new Error(`compliance profile ${uuid}: DELETE /v1 answered ${first.status()} (${firstText}); DELETE /v2/force refused: ${messages.map((m) => `${m.name ?? m.uuid}: ${m.message}`).join('; ').slice(0, 400)}`);
            }
            return forced;
        },
    });
}

/**
 * Safety net: core links a key named `certKey_<CN>` to every issued / imported / registered
 * certificate at request time. A spec that forgot `recordDerivedKeyOf` left five of them on the tier. Before an OWN certificate
 * is deleted (while the key is still linked) the handler finds that key by name (key list, rows carry ITEM uuids: the WRAPPER
 * uuid is `keyWrapperUuid`) and by the certificate's own `key.uuid`, checks it read-only and RECORDS it as a derived key line;
 * the keys step (5) re-reads the ledger and deletes it under its own rules (not in a token, made after `createdAfter`, unused
 * once the certificate is gone). Recorded only when: the name is exactly `certKey_<run-prefixed CN>`, the key is in no token,
 * its only association is this certificate, it was created no earlier than a minute before the certificate, and the ledger
 * does not hold it yet. An ITEM uuid is never recorded.
 */
export async function recordCertKeySafetyNet(ctx: TeardownContext, line: LedgerLine, cert: Json): Promise<string[]> {
    const cn = String(cert.commonName ?? line.name ?? '');
    if (!carriesRunPrefix(cn, ctx.runId, 'certificates')) return [];
    const wanted = `certKey_${cn}`;
    const candidates = new Set<string>();
    if (typeof cert.key?.uuid === 'string') candidates.add(cert.key.uuid);
    try {
        const res = await ctx.api.post('/api/v1/keys', { data: { itemsPerPage: 100, pageNumber: 1, filters: [{ fieldSource: 'property', fieldIdentifier: 'CKI_NAME', condition: 'EQUALS', value: wanted }] } });
        if (res.ok()) {
            for (const row of ((await res.json()) as { cryptographicKeys?: Json[] }).cryptographicKeys ?? []) {
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
    // The history gives the certificate's creation time; without it the ledger line's own bound (server clock) is used, never "now".
    const basis = created ? Date.parse(created) : Date.parse(String(line.createdAfter ?? line.at ?? ''));
    const bound = new Date((Number.isNaN(basis) ? Date.now() : basis) - 60_000);
    const recorded: string[] = [];
    for (const wrapper of candidates) {
        if (checkOwnership({ uuid: wrapper }, { lines: ctx.ledger, runId: ctx.runId }).own) continue;
        const res = await ctx.api.get(`/api/v1/keys/${wrapper}`);
        if (res.status() === 404) continue; // an item uuid (or a gone key): never deleted directly
        if (!res.ok()) { ctx.warn(`certificate ${line.uuid}: key ${wrapper} unreadable (${res.status()}); not recorded`); continue; }
        const key = (await res.json()) as Json;
        const others = (key.associations ?? []).filter((a: Json) => String(a?.uuid ?? a) !== line.uuid);
        if (String(key.name) !== wanted || key.tokenInstanceUuid || others.length || !key.creationTime || Date.parse(String(key.creationTime)) < bound.getTime()) {
            ctx.warn(`certificate ${line.uuid}: key ${wrapper} does not qualify for the leftover net (name ${String(key.name)}, token ${key.tokenInstanceUuid ? 'yes' : 'no'}, other associations ${others.length})`);
            continue;
        }
        recordDerived('keys', { uuid: wrapper, name: wanted }, 'runTeardown', bound, 'certKey_ key of an own certificate, found by the teardown safety net', { certificate: line.uuid }, ctx.runId);
        recorded.push(wrapper);
    }
    return recorded;
}

const certificates: TeardownHandler = {
    action: 'derived: keep unless made after createdAfter and not adopted; issued with an RA profile: revoke (v2) → wait revoked → delete; else delete',
    async remove(ctx, line) {
        const cert = ctx.live!;
        if (line.derived) {
            // A certificate a discovery onboarded is deleted only when nobody adopted it AND the platform created it
            // at or after createdAfter (server clock). Anything else stays and is reported. An attachment to
            // this run's own group / user / RA profile (an own trigger's Set-field on the own discovery) is not an adoption.
            const adopted = adoptionOf(cert, { groups: liveOwnUuids(ctx, 'groups'), users: liveOwnUuids(ctx, 'users'), raProfiles: liveOwnUuids(ctx, 'raProfiles') });
            if (adopted.length) {
                ctx.warn(`kept derived certificate ${line.uuid}: adopted (${adopted.join(', ')})`);
                return 'kept';
            }
            const created = await certificateCreationTime(ctx.api, line.uuid);
            if (!created) {
                // Unknown is not "kept": the object stays, the run is red, a human decides.
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
            // Lines written before `parents` existed fall back to the certificate's own RA profile; none → no revoke.
            const raProfileUuid = parent(line, 'raProfile') ?? cert.raProfile?.uuid;
            const authorityUuid = parent(line, 'authority') ?? cert.raProfile?.authorityInstanceUuid;
            if (raProfileUuid && authorityUuid) {
                try {
                    await revokeCertificate(ctx.api, { authorityUuid, raProfileUuid, certUuid: line.uuid, reason: 'unspecified' });
                } catch (e) {
                    throw blocked(`revoke refused: ${String(e).slice(0, 300)}`, `authority ${authorityUuid}`);
                }
                await waitForCertificateState(ctx.api, line.uuid, 'revoked', 120_000);
            }
        }
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `certificate ${line.uuid}`, detailUrl: `/api/v1/certificates/${line.uuid}` });
    },
};

/** A bulk key call (`PATCH /v1/keys/disable|destroy`, `DELETE /v1/keys`) for ONE own key; the caller judges the answer. */
const bulkKeyCall = (ctx: TeardownContext, method: 'patch' | 'delete', path: string, uuid: string): Promise<APIResponse> =>
    method === 'patch' ? ctx.api.patch(path, { data: [uuid] }) : ctx.api.delete(path, { data: [uuid] });

/**
 * Exactly ONE handler for every own (non-derived) token key (protocol rows): the area
 * modules have no `keys` handler of their own (protocols/protocolCa.ts, platform/keyApi.ts) — HANDLER_MODULES.keys is
 * this module. Without it core refuses to delete the key's token profile ("dependent Key(s)", TokenProfileWriter.java:195-203)
 * and then the token ("Dependent Token Profiles", TokenInstanceServiceImpl.java:524-537), so a protocol-CA run would
 * leave key + token profile + token behind. Core's `DELETE /v1/keys` (CryptographicKeyServiceImpl.java:615-645) destroys
 * every item at the connector and deletes the key with its associations whatever the items' states; it answers 204 even
 * for a uuid it did not find, so absence is proven by `GET /v1/keys/{uuid}`. Should the delete be refused (a 4xx),
 * the items are deactivated and destroyed first (`PATCH /v1/keys/disable`, `PATCH /v1/keys/destroy`: the destroy takes
 * DEACTIVATED / PRE_ACTIVE / COMPROMISED items, :1555-1560) and the delete is sent once more. Never a foreign key:
 * wrapHandlerWithGuard reads it live first (ledger line + run-prefixed live name). The derived `certKey_*` rule is unchanged.
 */
async function removeOwnTokenKey(ctx: TeardownContext, line: LedgerLine): Promise<void> {
    const uuid = line.uuid;
    const detailUrl = `/api/v1/keys/${uuid}`;
    // Before the first send: only a key read with 200 in this step may be deleted.
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
            // Unknown is not "kept": the object stays, the run is red, a human decides.
            throw new Error(`derived key ${line.uuid}: creation time unknown (no creationTime on the detail); not deleted, ` +
                'not provably made by this run: check it by hand');
        }
        const inToken = !!key.tokenInstanceUuid;
        const createdByUs = derivedDeletable(line, key.creationTime);
        const used = (key.associations?.length ?? 0) > 0;
        if (inToken || !createdByUs || used) {
            ctx.warn(`kept derived key ${line.uuid}: token=${inToken ? 'yes' : 'no'} created=${key.creationTime ?? '-'} (after ${line.createdAfter}) ` +
                `associations=${key.associations?.length ?? 0}`);
            return 'kept';
        }
        await deleteAndVerify(ctx, {
            uuid: line.uuid,
            what: `key ${line.uuid}`,
            detailUrl: `/api/v1/keys/${line.uuid}`,
            // The bulk DELETE answers 204 even for a uuid it did not find; the GET afterwards is the proof.
            send: () => ctx.api.delete('/api/v1/keys', { data: [line.uuid] }),
        });
    },
};

/**
 * A key item goes WITH its key (the key step runs first). The live read of wrapHandlerWithGuard finds it gone
 * and `goneWith` answers true when the parent key (`parents.key`) has a `deleted` line of this run: done. An item
 * still present (its key was not removed) is reported, blocked by its key; nothing is sent for it.
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

const discoveries: TeardownHandler = {
    action: 'record the certificates it onboarded as new (derived, createdAfter from the server clock), then delete the discovery',
    async remove(ctx, line) {
        const discovery = ctx.live!;
        // The server's clock, never the runner's: the discovery's own start time, else the create response's Date.
        const serverTime = discovery.startTime ?? line.serverAt;
        let createdAfter: string;
        if (serverTime) createdAfter = createdAfterMarker(serverTime);
        else {
            createdAfter = line.at;
            ctx.warn(`discovery ${line.uuid}: no server timestamp; its onboarded certificates use the runner clock (${line.at}) as createdAfter`);
        }
        const known = new Set(ctx.ledger.map((l) => l.uuid));
        for (const uuid of await listNewlyDiscoveredInventoryUuids(ctx.api, line.uuid)) {
            if (!known.has(uuid)) {
                recordDerived('certificates', { uuid, name: `onboarded by discovery ${line.uuid}` }, 'runTeardown', createdAfter,
                    'new in the inventory through an own discovery', { discovery: line.uuid }, ctx.runId);
            }
        }
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `discovery ${line.uuid}`, detailUrl: `/api/v1/discoveries/${line.uuid}` });
    },
};

const acmeProfiles: TeardownHandler = {
    action: 'deactivate on every own RA profile it is active on (each RA profile checked live), disable when enabled, delete',
    async remove(ctx, line) {
        // Core refuses the delete while any RA profile still has the profile activated ("Dependent RA Profiles").
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
            // The deactivation changes the RA profile: it must be this run's, live.
            await ownLive(ctx, 'raProfiles', { uuid: raUuid }, 'teardown.acmeProfiles (deactivate)');
            const resp = await ctx.api.patch(`/api/v1/authorities/${authorityUuid}/raProfiles/${raUuid}/protocols/acme/deactivate`);
            // A 404 here follows a 200 read of both objects in this step: the activation is gone already.
            if (!resp.ok() && resp.status() !== 404) {
                throw new Error(`Failed to deactivate ACME on RA profile ${raUuid}: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
            }
        }
        // Only an enabled profile is disabled (core refuses to disable a disabled one, and the delete does not need it).
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
        // The documented list proves the route; absence from it plus a 404 on the detail proves the account gone.
        const listResp = await ctx.api.get('/api/v1/acmeAccounts');
        if (!listResp.ok()) throw new Error(`ACME account ${line.uuid}: route or object missing (GET /api/v1/acmeAccounts answered ${listResp.status()})`);
        const account = ((await listResp.json()) as Json[]).find((a) => a.uuid === line.uuid);
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
        const roles = (await getJson(ctx.api, rolesUrl)) as unknown as Json[] | undefined;
        if (roles && roles.length) {
            const resp = await ctx.api.patch(rolesUrl, { data: [] });
            if (!resp.ok()) throw new Error(`Failed to remove user ${line.uuid} from its roles: ${resp.status()} - ${(await resp.text()).slice(0, 300)}`);
            const left = (await getJson(ctx.api, rolesUrl)) as unknown as Json[] | undefined;
            if (left?.length) throw new Error(`user ${line.uuid} still has ${left.length} role(s) after the roles were cleared`);
        }
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `user ${line.uuid}`, detailUrl: `/api/v1/users/${line.uuid}`, type: 'users' });
    },
};

/**
 * Approval-profile dissociation (a step hook before the certificate step): every own, live approval profile is dissociated from
 * every own, live RA profile it is associated with, so a crashed spec cannot leave the run-end revoke gated (a
 * certificate under an RA profile that still carries the run's approval profile goes `pending_approval` on revoke).
 * Routes (interfaces ApprovalProfileController.java:108, :133): `GET /v1/approvalProfiles/{uuid}/associations` (a list
 * of ResourceObjectDto: `resource`, `objectUuid`, `name`; `uuid` / `resourceUuid` are read as fallbacks) and
 * `DELETE /v1/approvalProfiles/{uuid}/associations/raProfiles/{raProfileUuid}` (core
 * ApprovalProfileServiceImpl.java:251-270 `disassociateApprovalProfile`: deletes the relation row only). Both objects
 * are read live first; the dissociation is proven by re-reading the list. A pre-existing RA profile that
 * carries the own approval profile is never touched (reported as a warning: the own profile's own deletion will fail
 * later and name it).
 */
export async function ungateOwnRaProfiles(ctx: TeardownContext): Promise<void> {
    assertNotDryRun('teardown.preStep.ungateOwnRaProfiles');
    // lower-case uuid → the ledger line's own spelling (the live read and the route use the ledger's).
    const ownRa = new Map(liveOwn(ctx, 'raProfiles').map((l) => [l.uuid.toLowerCase(), l.uuid]));
    for (const ap of liveOwn(ctx, 'approvalProfiles')) {
        await ownLive(ctx, 'approvalProfiles', ap, 'teardown.ungateOwnRaProfiles (approval profile)');
        const url = `/api/v1/approvalProfiles/${ap.uuid}/associations`;
        const read = async (): Promise<Array<{ resource: string; uuid: string }>> => {
            const rows = (await getJson(ctx.api, url)) as unknown as Json[] | undefined;
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

/** DELETE <url(uuid)>; the same URL proves absence (for roles / users also the full list after a 5xx, core#2511). */
const byUrl = (url: (uuid: string) => string, what: string, type?: string): TeardownHandler => ({
    action: `delete (DELETE ${url('{uuid}')}), absence proven by GET${type ? ' (a 5xx: confirmed through the full list, core#2511)' : ''}`,
    async remove(ctx, line) {
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `${what} ${line.uuid}`, detailUrl: url(line.uuid), type });
    },
});

/** The raw handlers; runTeardown wraps each with wrapHandlerWithGuard when it loads this module. */
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

