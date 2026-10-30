/**
 * teardown — the teardown handlers of the timestamping block's ledger types: `tspProfiles`, `signingProfiles`,
 * `timeQualityConfigurations` and `tspBasicCredentials` (descriptor: ./resourceTypes.ts).
 *
 * Used by the run-end teardown and the block's own teardown project; handlers are idempotent and run wrapped by
 * `wrapHandlerWithGuard`. A signing profile activated on a TSP profile pins it, so a deactivation breaks the cycle first.
 * ONE DELETE OUTSIDE THE LEDGER GUARD: `DELETE /v1/secrets/{uuid}?deleteInVaults=true` for a Basic-credential vault secret
 * core's queue left behind. It is sent only for a secret read live in the same step whose name matches
 * `tsp-basic-<uuid of the run's own TSP profile>-<username>-<8 hex>` (the credential's own username in its handler, any in the
 * TSP profile's), after its own object is gone.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { assertNotDryRun } from '../regression/run/flags';
import { assertOwnLive } from '../regression/ledger/ownership';
import type { LedgerLine } from '../regression/ledger/ledger';
import type { TeardownContext, TeardownHandler } from '../regression/teardown/runTeardown';
import { recordCleanupFailure } from '../cleanupLedger';
import { deleteAndVerify, liveOwnLines } from '../regression/teardown/teardownHandlers';
import { pollUntil } from '../regression/wait';
import { Logger } from '../Logger';

const logger = new Logger('TimestampingHandlers');

type Json = Record<string, any>;

/** Signing records are listed and deleted a page at a time; core's page maximum is 1000. */
export const SIGNING_RECORD_PAGE = 1000;
/** Rounds of list + bulk delete before the handler gives up: it ends a loop in which core reports every delete done but keeps the records. */
export const SIGNING_RECORD_ROUNDS = 100;
/** Tries of "empty the records, delete the profile" (a record staged by the deferred persistence can land after the last page). */
export const DELETE_ATTEMPTS = 3;
/** Reads of a Basic-credential secret while core's queue removes it, and again after the explicit delete. */
export const SECRET_WAIT_ATTEMPTS = 20;
/** The name core gives the vault secret behind a TSP Basic credential (TspProfileBasicCredentialServiceImpl.createVaultSecret). */
export const basicSecretPrefix = (tspProfileUuid: string): string => `tsp-basic-${tspProfileUuid}-`;

const parentList = (line: LedgerLine, key: string): string[] => {
    const v = line.parents?.[key];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

function blocked(message: string, blockedBy: string): Error {
    return Object.assign(new Error(message), { blockedBy });
}

const brief = async (r: APIResponse): Promise<string> => (await r.text()).replace(/\s+/g, ' ').slice(0, 300);

/** Read a second object (not the handler's own line) live, marking it seen; LiveObjectMissing propagates. */
async function ownLive(ctx: TeardownContext, type: string, uuid: string, helper: string): Promise<void> {
    const { body } = await assertOwnLive(ctx.api, type, { uuid }, helper, {
        lines: ctx.ledger, runId: ctx.runId, tier: ctx.tier, ...(ctx.knownBug ? { onKnownBug: ctx.knownBug } : {}),
    });
    if (body) ctx.seen.add(uuid);
}

/** `GET /v1/signingProfiles/{uuid}/protocols/tsp`: the TSP profile it is activated on (`available`, uuid, name), undefined on 404. */
async function tspActivation(api: APIRequestContext, signingProfileUuid: string): Promise<Json | undefined> {
    const url = `/api/v1/signingProfiles/${signingProfileUuid}/protocols/tsp`;
    const resp = await api.get(url);
    if (resp.status() === 404) return undefined;
    if (!resp.ok()) throw new Error(`GET ${url} failed: ${resp.status()} - ${await brief(resp)}`);
    return (await resp.json()) as Json;
}

/**
 * Deactivate TSP on a signing profile and prove it (`available: false`). A 404 answer follows a 200 read of the same
 * object in this step, so the activation (or the profile) is gone already.
 */
async function deactivateTsp(ctx: TeardownContext, signingProfileUuid: string): Promise<void> {
    assertNotDryRun(`teardown.timestamping deactivate TSP on signing profile ${signingProfileUuid}`);
    const resp = await ctx.api.patch(`/api/v1/signingProfiles/${signingProfileUuid}/protocols/tsp/deactivate`);
    if (!resp.ok() && resp.status() !== 404) {
        throw new Error(`Failed to deactivate TSP on signing profile ${signingProfileUuid}: ${resp.status()} - ${await brief(resp)}`);
    }
    if ((await tspActivation(ctx.api, signingProfileUuid))?.available) {
        throw new Error(`signing profile ${signingProfileUuid} is still activated on a TSP profile after the deactivation`);
    }
}

/**
 * Empty a signing profile's signing records: `POST /v1/signingProfiles/{uuid}/signingRecords` (page 1, `items[].uuid`),
 * bulk `DELETE /v1/signingRecords` with the page's uuids (core answers a `BulkActionMessageDto` per record it could not
 * delete). Ends on an empty first page (the absence proof) or a 404 of the listing (the profile is gone). A record that
 * stays — a message, a non-2xx answer, or still there after `rounds` rounds — is a failure.
 *
 * Each listed row must prove association with this signing profile (`signingProfile.uuid`) before any bulk delete.
 * The unscoped DELETE would otherwise wipe foreign records if the path-scoped listing ever returned a mixed page.
 */
export async function emptySigningRecords(ctx: TeardownContext, signingProfileUuid: string, rounds: number = SIGNING_RECORD_ROUNDS): Promise<void> {
    assertNotDryRun(`teardown.timestamping signing records of ${signingProfileUuid}`);
    const listUrl = `/api/v1/signingProfiles/${signingProfileUuid}/signingRecords`;
    for (let round = 0; round < rounds; round++) {
        const list = await ctx.api.post(listUrl, { data: { itemsPerPage: SIGNING_RECORD_PAGE, pageNumber: 1, filters: [] } });
        if (list.status() === 404) return;
        if (!list.ok()) throw new Error(`signing profile ${signingProfileUuid}: listing its signing records answered ${list.status()} - ${await brief(list)}`);
        const items = (((await list.json()) as Json).items ?? []) as Json[];
        if (!items.length) return;
        const uuids: string[] = [];
        for (const row of items) {
            if (typeof row?.uuid !== 'string') {
                throw new Error(`signing profile ${signingProfileUuid}: its signing record list holds rows without a uuid; not deleting blindly`);
            }
            const owner = row?.signingProfile?.uuid;
            if (owner !== signingProfileUuid) {
                throw new Error(
                    `signing profile ${signingProfileUuid}: listing returned record ${row.uuid} owned by ${typeof owner === 'string' ? owner : 'no signingProfile.uuid'}; not deleting blindly`,
                );
            }
            uuids.push(row.uuid);
        }
        const del = await ctx.api.delete('/api/v1/signingRecords', { data: uuids });
        if (!del.ok()) throw new Error(`signing profile ${signingProfileUuid}: deleting ${uuids.length} signing record(s) answered ${del.status()} - ${await brief(del)}`);
        const messages = (await del.json().catch(() => [])) as Json[] | null;
        if (Array.isArray(messages) && messages.length) {
            throw new Error(`signing profile ${signingProfileUuid}: core kept ${messages.length} of ${uuids.length} signing record(s): ${String(messages[0]?.message ?? messages[0]).replace(/\s+/g, ' ').slice(0, 200)}`);
        }
    }
    throw new Error(`signing profile ${signingProfileUuid}: signing records remain after ${rounds} rounds of deletion`);
}

const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `name` belong to the secrets of this TSP profile — anchored either way, with core's 8-hex suffix:
 * `tsp-basic-<tsp>-<username>-<8 hex>` for one credential when `username` is given (so the username `a` never matches the
 * secret of `a-b`), `tsp-basic-<tsp>-<any username>-<8 hex>` for the profile as a whole (a name without the suffix never matches).
 */
export const isBasicSecretName = (name: string, tspProfileUuid: string, username?: string): boolean =>
    username === undefined
        ? new RegExp(`^${escapeRegExp(basicSecretPrefix(tspProfileUuid))}.+-[0-9a-f]{8}$`).test(name)
        : new RegExp(`^${escapeRegExp(basicSecretPrefix(tspProfileUuid) + username)}-[0-9a-f]{8}$`).test(name);

/** The uuid and name of every vault secret of this TSP profile (of one credential with `username`): POST /v1/secrets, name filter, checked again client-side. */
async function basicCredentialSecrets(ctx: TeardownContext, tspProfileUuid: string, username?: string): Promise<Array<{ uuid: string; name: string }>> {
    const prefix = basicSecretPrefix(tspProfileUuid);
    const resp = await ctx.api.post('/api/v1/secrets', {
        data: { itemsPerPage: SIGNING_RECORD_PAGE, pageNumber: 1, filters: [{ fieldSource: 'property', fieldIdentifier: 'SECRET_NAME', condition: 'STARTS_WITH', value: prefix }] },
    });
    if (!resp.ok()) throw new Error(`TSP profile ${tspProfileUuid}: listing the vault secrets of its Basic credentials answered ${resp.status()} - ${await brief(resp)}`);
    const rows = (((await resp.json()) as Json).items ?? []) as Json[];
    return rows
        .filter((r) => typeof r?.uuid === 'string' && typeof r?.name === 'string' && isBasicSecretName(r.name, tspProfileUuid, username))
        .map((r) => ({ uuid: r.uuid as string, name: r.name as string }));
}

/** Polls `GET /v1/secrets/{uuid}` until it answers 404 (core's queue ran the delete); false when it is still readable. */
async function secretGone(ctx: TeardownContext, uuid: string): Promise<boolean> {
    const last = await pollUntil(
        async () => (await ctx.api.get(`/api/v1/secrets/${uuid}`)).status(),
        (status) => status === 404,
        { attempts: SECRET_WAIT_ATTEMPTS, timeoutMs: Number.POSITIVE_INFINITY, intervalMs: ctx.pollMs ?? 1000, tolerateErrors: 0, onTimeout: 'return' },
    );
    return last === 404;
}

/**
 * After the own object is deleted and proven absent: every secret behind its Basic credentials should be gone. Core
 * queues their removal; one that stays after the wait gets ONE explicit delete (`?deleteInVaults=true`, the way core's own
 * credential path deletes), but only when it was read with 200 in this step and its live name still matches the exact
 * secret name of this TSP profile (`-<any>-<8 hex>`, or this credential's username when given), so it is provably the credential's.
 *
 * This is the one delete that does not go through the ledger guard: the secret has no `created` line. Its ownership
 * rests on that anchored live name, which carries the uuid of the run's own TSP profile, the 8-hex suffix and, for a
 * credential's handler, its run-prefixed username.
 *
 * A secret that stays is NOT a failure of the handler: the object it belongs to is already gone and has its `deleted`
 * line (a failure here would hide that line, and a later pass would read 404 for the object). It is reported (warning
 * and cleanup-failure record); the `vaultProfiles` step then fails with core's own refusal if the secret really stays.
 */
async function settleBasicSecrets(ctx: TeardownContext, tspProfileUuid: string, secrets: Array<{ uuid: string; name: string }>, username?: string): Promise<void> {
    assertNotDryRun(`teardown settleBasicSecrets ${tspProfileUuid}`);
    // Never throws: the own object is gone, and an error here would keep its `deleted` line from being written.
    const leftover = (uuid: string, message: string): void => {
        const text = `Basic-credential secret ${uuid} of TSP profile ${tspProfileUuid} stays in the vault profile (${message.slice(0, 300)}); its vault profile cannot be deleted while it exists`;
        try {
            ctx.warn(text);
        } catch {
            logger.warn(text);
        }
        try {
            recordCleanupFailure({ resource: 'secrets', uuid, message: text, blockedBy: `secrets ${uuid}` });
        } catch (e) {
            logger.warn(`could not record the cleanup failure of secret ${uuid}: ${String(e).slice(0, 200)}`);
        }
    };
    for (const secret of secrets) {
        try {
            if (await secretGone(ctx, secret.uuid)) continue;
            const detail = await ctx.api.get(`/api/v1/secrets/${secret.uuid}`);
            if (detail.status() === 404) continue;
            if (!detail.ok()) {
                leftover(secret.uuid, `GET answered ${detail.status()}`);
                continue;
            }
            const live = (await detail.json()) as Json;
            if (typeof live?.name !== 'string' || !isBasicSecretName(live.name, tspProfileUuid, username)) {
                leftover(secret.uuid, 'its live name no longer carries the secret name of this TSP profile: not touching it');
                continue;
            }
            ctx.warn(`TSP profile ${tspProfileUuid}: core's queue left the vault secret ${secret.uuid} of its Basic credentials (state ${String(live.state ?? '?')}); deleting it explicitly`);
            const resp = await ctx.api.delete(`/api/v1/secrets/${secret.uuid}?deleteInVaults=true`);
            if (!resp.ok() && resp.status() !== 404) {
                leftover(secret.uuid, `the explicit delete answered ${resp.status()} - ${await brief(resp)}`);
                continue;
            }
            // Core queues this delete too: wait with the same poll as for its own queue.
            if (!(await secretGone(ctx, secret.uuid))) leftover(secret.uuid, `still readable ${SECRET_WAIT_ATTEMPTS} reads after the explicit delete`);
        } catch (e) {
            leftover(secret.uuid, `unexpected error: ${String(e)}`);
        }
    }
}

const tspProfiles: TeardownHandler = {
    action: 'deactivate TSP on every own signing profile activated on it (PATCH /signingProfiles/{uuid}/protocols/tsp/deactivate), delete (DELETE /tspProfiles/{uuid}), then wait until the vault secrets of its Basic credentials are gone; absence by GET /tspProfiles/{uuid}',
    async remove(ctx, line) {
        assertNotDryRun(`teardown.tspProfiles ${line.uuid}`);
        // Core refuses the delete while any signing profile is activated on the TSP profile. Candidates: the ledger's
        // parent, every other own live signing profile of the run; each is read live before it is changed.
        const candidates = new Set([...parentList(line, 'signingProfile'), ...liveOwnLines(ctx.ledger, ctx.runId, 'signingProfiles').map((l) => l.uuid)]);
        for (const signingUuid of candidates) {
            const activation = await tspActivation(ctx.api, signingUuid);
            if (!activation?.available || (activation.uuid !== line.uuid && activation.name !== line.name)) continue;
            await ownLive(ctx, 'signingProfiles', signingUuid, 'teardown.tspProfiles (deactivate)');
            await deactivateTsp(ctx, signingUuid);
        }
        // The credential rows go with the profile and the API does not expose the secrets' uuids: read them first.
        // A TSP profile without a vault profile cannot hold credentials (TspProfileBasicCredentialServiceImpl.java:94-96 create refuses).
        const secrets = ctx.live === undefined || ctx.live.vaultProfile ? await basicCredentialSecrets(ctx, line.uuid) : [];
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `TSP profile ${line.uuid}`, detailUrl: `/api/v1/tspProfiles/${line.uuid}` });
        await settleBasicSecrets(ctx, line.uuid, secrets);
    },
};

const signingProfiles: TeardownHandler = {
    action: 'deactivate TSP when still activated, empty its signing records (POST /signingProfiles/{uuid}/signingRecords + bulk DELETE /signingRecords, round limit), delete (DELETE /signingProfiles/{uuid}); absence by GET /signingProfiles/{uuid}',
    async remove(ctx, line) {
        assertNotDryRun(`teardown.signingProfiles ${line.uuid}`);
        const detailUrl = `/api/v1/signingProfiles/${line.uuid}`;
        // Normally the TSP profile's handler released the activation already; this makes the handler self-contained.
        if ((await tspActivation(ctx.api, line.uuid))?.available) await deactivateTsp(ctx, line.uuid);
        await deleteAndVerify(ctx, {
            uuid: line.uuid,
            what: `signing profile ${line.uuid}`,
            detailUrl,
            send: async () => {
                let resp!: APIResponse;
                for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
                    await emptySigningRecords(ctx, line.uuid);
                    resp = await ctx.api.delete(detailUrl);
                    if (resp.ok() || resp.status() === 404) return resp;
                    const text = await brief(resp);
                    if (/signing records/i.test(text) && attempt < DELETE_ATTEMPTS) continue; // staged records landed after the last page
                    if (/default signing profile by TSP Profiles/i.test(text)) throw blocked(`signing profile ${line.uuid}: ${text}`, 'a TSP profile naming it as its default signing profile');
                    if (/timestamp source/i.test(text)) throw blocked(`signing profile ${line.uuid}: ${text}`, 'a signing profile naming it as its timestamp source');
                    return resp;
                }
                return resp;
            },
        });
    },
};

const tspBasicCredentials: TeardownHandler = {
    action: 'delete (DELETE /tspProfiles/{tsp}/basicCredentials/{uuid}; core removes its vault secret, awaited), absence proven by the same detail URL; gone with its TSP profile',
    goneWith(ctx, line) {
        const tsp = parentList(line, 'tspProfile')[0];
        return !!tsp && ctx.ledger.some((l) => l.event === 'deleted' && l.runId === ctx.runId && l.type === 'tspProfiles' && l.uuid === tsp);
    },
    async remove(ctx, line) {
        assertNotDryRun(`teardown.tspBasicCredentials ${line.uuid}`);
        const tsp = parentList(line, 'tspProfile')[0];
        if (!tsp) throw new Error(`Basic credential ${line.uuid}: no TSP profile known (ledger parents)`);
        const username = typeof ctx.live?.username === 'string' ? ctx.live.username : undefined;
        // The secret behind it is not exposed by the API: read its name-matched secrets before the delete.
        const secrets = username === undefined ? [] : await basicCredentialSecrets(ctx, tsp, username);
        await deleteAndVerify(ctx, { uuid: line.uuid, what: `Basic credential ${line.uuid}`, detailUrl: `/api/v1/tspProfiles/${tsp}/basicCredentials/${line.uuid}` });
        await settleBasicSecrets(ctx, tsp, secrets, username);
    },
};

const timeQualityConfigurations: TeardownHandler = {
    action: 'delete (DELETE /timeQualityConfigurations/{uuid}), absence proven by GET; core refuses while a signing profile references it',
    async remove(ctx, line) {
        assertNotDryRun(`teardown.timeQualityConfigurations ${line.uuid}`);
        const detailUrl = `/api/v1/timeQualityConfigurations/${line.uuid}`;
        await deleteAndVerify(ctx, {
            uuid: line.uuid,
            what: `time-quality configuration ${line.uuid}`,
            detailUrl,
            send: async () => {
                const resp = await ctx.api.delete(detailUrl);
                if (resp.ok() || resp.status() === 404) return resp;
                const text = await brief(resp);
                if (/associated with Signing Profiles/i.test(text)) throw blocked(`time-quality configuration ${line.uuid}: ${text}`, 'a signing profile referencing it');
                return resp;
            },
        });
    },
};

/** The raw handlers; runTeardown wraps each with wrapHandlerWithGuard when it loads this module. */
export const teardownHandlers: Record<string, TeardownHandler> = { tspBasicCredentials, tspProfiles, signingProfiles, timeQualityConfigurations };
