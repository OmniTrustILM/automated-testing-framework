/**
 * runTeardown — globalTeardown of the REG-* and API-* configs: deletes the run's own objects and proves
 * afterwards that nothing else was touched.
 *
 * WHAT
 * 1. Refuses to run under an adhoc run id (`qa-reg-adhoc`, `qa-api-adhoc`) or when API_RUN_ID differs from REG_RUN_ID:
 *    without one real run id it cannot tell its objects from anyone else's. Re-runs the tier assertion of the
 *    configs (TIER_KIND frozen, local proof, header auth, BASE_URL unchanged). BASE_URL unset fails the run:
 *    a run without a tier tested nothing and must never end green.
 * 2. Rebuilds the object list from the ledger alone (workers and the runner share no memory): `created` lines of THIS
 *    run without a later `deleted` line, each checked with the own-object guard (ledger line + name prefix; derived
 *    objects through createdAfter) and recorded on THIS tier (tier identity). Anything that fails is refused and
 *    reported, never deleted. Refused lines are reported by type and uuid only.
 * 3. API_TEARDOWN_DRY_RUN on (parsed switch) prints the plan (step, type, uuid, name, action, parents, refusals)
 *    and stops: no request, no authentication. The dry run is ALSO checked at the top of executeTeardown,
 *    removeOwnObject and every handler entry (`wrapHandlerWithGuard`), so no path deletes under it.
 *    API_DELETE_OWN off keeps the objects and prints the ledger path.
 * 4. Walks DELETE_ORDER; every delete goes through attemptCleanup (one retry, cascade reporting) and appends a `deleted` ledger line. Every
 *    object gets a FRESH authenticated context (a long revoke wait cannot outlive the token) and its own `seen` set. The handlers of each
 *    type come from the module that creates the objects (the registry in resourceTypes.ts names it, `HANDLER_SOURCES` imports it) and are
 *    wrapped by `wrapHandlerWithGuard`: dry-run check, then `assertOwnLive` (ledger + live run-prefixed name) before the handler sees the
 *    object; a type without a registry entry is reported as "no handler (type X)", but only when such ledger lines exist. A handler that
 *    answers "kept" (a derived object provably older than the run, or adopted) is a WARNING, not a failure; the kept objects are written to
 *    `<state dir>/<run id>.kept.json` (type, uuid, reasons) and REG_KEPT_STRICT=1 fails the run on a non-empty list. A derived object whose
 *    creation time is unknown is not "kept": its handler fails (red). FINAL PASS: after the last step, every object whose delete FAILED in
 *    this teardown (attempted: not refused, not without a handler, not kept, not "route or object missing", not a guard refusal) gets
 *    exactly one more attempt through the same wrapped handler, oldest failure first: an object a later step still referenced (a revoked
 *    certificate its own SCEP profile names, step 4 before step 7) goes then. A success appends the `deleted` line (note: final pass), then
 *    drops its failure; a failure stays one failure whose message names both attempts. One summary line: "final pass: N retried, M
 *    deleted".
 * 5. Deletion rule: a delete counts only when a GET afterwards proves the object absent; a DELETE answering 404
 *    counts as done only if the same object was read with 200 earlier in its step; otherwise the step fails with
 *    "route or object missing".
 * 6. On a shared tier, takes a second snapshot after the deletes (with a context that re-authenticates once on 401) and
 *    re-runs compareSnapshots against the "before" snapshot the `snapshot` project stored: a wrong delete would otherwise
 *    pass the API-GEN-33 proof, which runs before this teardown. A missing before snapshot on a shared tier, a
 *    violation or any cleanup failure fails the run (non-zero exit): cleanup is part of the result.
 * 7. Under TIER_KIND=local, before the first delete: the authenticated local-backend check (tier/localProof.ts
 *    `assertLocalBackend`). At the very end (every path) the run's local-backend proof file is removed.
 * 8. Roles and users whose detail answers 5xx after the delete (known bug core#2511) are confirmed gone through their
 *    full list only; the workaround is logged and listed under `knownBugs` in `<run id>.kept.json`.
 * 9. DELETE_ORDER follows core's reference refusals (REFERENCED_BY: actions
 *    before executions, the notification steps after the workflow step); step hooks (PRE_STEPS:
 *    own RA profiles are dissociated from own approval profiles before the certificate step, so a crashed spec cannot
 *    leave the revoke gated); `keyItems` go with their key (`goneWith`); own token keys are removed by
 *    teardownHandlers' own `keys` handler — exactly ONE handler for every own token key (protocols/protocolCa and platform/keys have none);
 *    approvals / approval profiles the platform
 *    retains (core never deletes an approval; an approval profile with approvals cannot be deleted,
 *    ApprovalProfileServiceImpl.java:119-127) may be answered `kept` by their handlers (a warning
 *    and a kept-report line, REG_KEPT_STRICT=1 turns it red — the documented residue of a lifecycle run).
 *
 * Structure: `teardownRun` = `assertPreconditions` → `dryRunReport` | `keepReport` | `deleteAndProve` (delete through
 * `TeardownRun`, report the kept objects, `proveNonInterference`). `TeardownRun` holds the state its phases share (the result,
 * the warnings of the object being removed, the failures the final pass retries): `prepSteps` → `deleteStep` / `deleteItem` per
 * step → `finalPass`. The tables (DELETE_ORDER, HANDLER_MODULES) are derived from the registry.
 *
 * Kubernetes objects (`k8s:<kind>` ledger lines, REG-USE-06 / REG-PROT-19…21) are never deleted here. Contract: the
 * spec removes them in its own `afterAll` (attemptCleanup) and appends `recordDeleted('k8s:<kind>', ref, spec)` for each
 * one it removed; a `k8s:` line without its `deleted` line is listed below as a leftover and fails the run.
 */
import { getAuthenticatedApiContext } from '../../auth/apiContext';
import { APIRequestContext, FullConfig, request as playwrightRequest } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../Logger';
import { attemptCleanup, clearCleanupFailures, cleanupLedgerFile, CleanupFailure, formatCleanupReport, readCleanupFailures, recordCleanupFailure, rewriteCleanupFailures, statusOf } from '../../cleanupLedger';
import { assertNotDryRun, isDryRun, parseFlag } from '../run/flags';
import { compareSnapshots, confirmForeignCreates, readSnapshot, SnapshotReader, snapshotTier } from './nonInterference';
import { teardownHandlers as coreHandlers, hasLiveOwn, ungateOwnRaProfiles } from './teardownHandlers';
import { teardownHandlers as lifecycleHandlers } from '../lifecycle/lifecycleTeardown';
import { teardownHandlers as workflowHandlers } from '../events/workflowTeardown';
import { teardownHandlers as notificationHandlers } from '../events/notificationTeardown';
import { teardownHandlers as protocolHandlers } from '../protocols/protocolProfiles';
import { teardownHandlers as platformHandlers } from '../platform/platformTeardown';
import { teardownHandlers as inventoryHandlers } from '../inventory/inventoryTeardown';
import { teardownHandlers as schedulerHandlers } from '../platform/schedulerApi';
import { deleteOrderOf, handlerModulesOf, type HandlerModule } from '../resourceTypes';
import { assertOwn, assertOwnLive, WorkaroundNote, LiveObjectMissing, mayDeleteOwn, checkOwnership } from '../ledger/ownership';
import { LedgerLine, ledgerFile, readLedger, recordDeleted } from '../ledger/ledger';
import { DEFAULT_RUN_IDS, currentRunId, isDefaultRunId, regressionStateDir, beforeSnapshotFile } from '../run/runId';
import { settings } from '../run/settings';
import { assertLocalBackend, assertRunTier, removeLocalProof } from '../tier/localProof';
import { isLocalTier, tierIdentity } from '../tier/kind';
import type { RemoveResult, TeardownContext, TeardownHandler, TeardownPrepStep } from './teardownTypes';

const logger = new Logger('RunTeardown');

export type { TeardownContext, TeardownHandler, RemoveResult, TeardownPrepStep };

/**
 * Delete order: dependants before what they depend on. Within a step, types run in the listed order. The steps and their
 * types come from the resource-type registry (resourceTypes.ts: the array order is the delete order), and every pair of
 * REFERENCED_BY below is satisfied by it (tests/unit/runTeardown.spec.ts asserts it mechanically).
 * Step 8 runs actions BEFORE executions (core refuses
 * to delete an execution while an action references it) and the notification steps come after the workflow step.
 * `keyItems` go with their key (step 6, after keys) — a remaining item is reported.
 */
export const DELETE_ORDER: Array<{ step: number; label: string; types: string[] }> = deleteOrderOf();

/**
 * The reference graph core enforces on deletes: type A cannot be deleted while an object of type B still
 * references it, so B must be deleted in an earlier step than A (or earlier in the same step). Each pair cites core
 * (`integration/spring-boot-4.1` @ 569e853c, paths under src/main/java/com/otilm/core/). Pending areas append their
 * pairs with a core citation; tests/unit/runTeardown.spec.ts asserts every pair against DELETE_ORDER.
 */
export const REFERENCED_BY: ReadonlyArray<{ a: string; b: string; core: string }> = [
    { a: 'executions', b: 'actions', core: 'service/impl/ActionServiceImpl.java:150-165 deleteExecution: 422 "Cannot delete execution … associated to following actions"' },
    { a: 'actions', b: 'triggers', core: 'service/impl/ActionServiceImpl.java:412-427 deleteAction: 422 "Cannot delete action … associated to following triggers"' },
    { a: 'rules', b: 'triggers', core: 'service/impl/RuleServiceImpl.java:295-305 deleteRule: 422 "Cannot delete rule … associated to following triggers"' },
    { a: 'conditions', b: 'rules', core: 'service/impl/RuleServiceImpl.java:140-150 deleteCondition: 422 "Cannot delete condition … associated to following rules"' },
    { a: 'triggers', b: 'eventAssociations', core: 'service/impl/TriggerServiceImpl.java:195-210 deleteTrigger: 422 "Cannot delete trigger. It has … event association(s)"' },
    { a: 'notificationProfiles', b: 'executions', core: 'service/impl/NotificationProfileServiceImpl.java:178-184 deleteNotificationProfile: 422 "… execution(s) are referencing this notification profile"' },
    { a: 'notificationInstances', b: 'notificationProfiles', core: 'service/impl/NotificationInstanceServiceImpl.java:334-343 removeNotificationInstance: 422 "Notification profile(s) referencing this notification instance"' },
    { a: 'certificates', b: 'discoveries', core: 'handler order: the discovery step records the onboarded certificates as derived lines, so it runs before the certificate step (3 before 4)' },
    { a: 'keyItems', b: 'keys', core: 'key items go WITH their key (core deleteKey, CryptographicKeyServiceImpl.java:615-645, destroys and deletes the items): the item step follows the key step and only reports what remains' },
    { a: 'approvalProfiles', b: 'approvals', core: 'service/impl/ApprovalProfileServiceImpl.java:119-127 deleteApprovalProfile: 422 "Unable to delete approval profile with existing approvals." (approvals are never deleted by core: the handler may answer kept)' },
    { a: 'raProfiles', b: 'complianceProfiles', core: 'suspected defect: core\'s RaProfileServiceImpl removes no compliance_profile_association row, so a deleted RA profile leaves a dangling association and the compliance profile\'s non-force delete then answers 404 (v2 ComplianceProfileServiceImpl.java:565-577 resolves the deleted RA profile): the compliance profile (own RA associations removed) is deleted BEFORE the RA profile' },
    { a: 'raProfiles', b: 'certificates', core: 'handler order: the certificate handler (teardownHandlers certificates) revokes an issued certificate through its RA profile, so the certificate step precedes the RA profile step (4 before 10)' },
    { a: 'tokenProfiles', b: 'keys', core: 'service/writer/TokenProfileWriter.java:195-203 validateNoDependentObjects: "Cannot delete Token Profile … dependent Key(s)"' },
    { a: 'tokens', b: 'tokenProfiles', core: 'service/impl/TokenInstanceServiceImpl.java:524-537 deleteTokenInstance: "Dependent Token Profiles: …"' },
];

/** The step a type is deleted in (99: none). */
export const deleteStepOf = (type: string): number => DELETE_ORDER.find((s) => s.types.includes(type))?.step ?? 99;
const typeRank = (type: string): number => DELETE_ORDER.find((s) => s.types.includes(type))?.types.indexOf(type) ?? 0;

/** True when `b` is deleted before `a` by DELETE_ORDER (an earlier step, or earlier in the same step). */
export function isDeletedBefore(b: string, a: string): boolean {
    return deleteStepOf(b) < deleteStepOf(a) || (deleteStepOf(b) === deleteStepOf(a) && typeRank(b) < typeRank(a));
}

/** The handler module of every ledger type (resourceTypes.ts). A type without an entry has no handler. */
export const HANDLER_MODULES: Record<string, HandlerModule> = handlerModulesOf();

/**
 * The `teardownHandlers` of each handler module, imported statically: a module that is missing or fails to load stops the
 * run at its start, never half-way through a teardown. The record is typed by `HandlerModule`, so a registry entry that names
 * a module without an import here does not compile.
 */
export const HANDLER_SOURCES: Record<HandlerModule, Record<string, TeardownHandler>> = {
    core: coreHandlers,
    lifecycle: lifecycleHandlers,
    workflow: workflowHandlers,
    notification: notificationHandlers,
    protocols: protocolHandlers,
    platform: platformHandlers,
    inventory: inventoryHandlers,
    scheduler: schedulerHandlers,
};

/**
 * Every handler entry: no delete under the dry run; the line's type must be the handler's; then the live
 * object is read through `assertOwnLive` (ledger, tier, live run-prefixed name) and marked as seen. When the object was
 * seen with 200 earlier in this step and is gone now (the first attempt removed it), there is nothing left to do.
 */
export function wrapHandlerWithGuard(type: string, handler: TeardownHandler): TeardownHandler {
    return {
        action: handler.action,
        async remove(ctx, line) {
            assertNotDryRun(`teardown.${type}`);
            if (line.type !== type) throw new Error(`teardown.${type}: handed a ${line.type} line`);
            let live;
            try {
                // No `env` seam: the run id and tier are given, REG_RESTRICTED_USERNAME comes from the process.
                live = await assertOwnLive(ctx.api, type, line, `teardown.${type}`, {
                    lines: ctx.ledger, runId: ctx.runId, tier: ctx.tier, ...(ctx.knownBug ? { onKnownBug: ctx.knownBug } : {}),
                });
            } catch (e) {
                if (e instanceof LiveObjectMissing && (ctx.seen.has(line.uuid) || handler.goneWith?.(ctx, line) === true)) return;
                throw e;
            }
            if (live.body) ctx.seen.add(line.uuid);
            return handler.remove({ ...ctx, live: live.body }, line);
        },
    };
}

const guardedModules = new Map<string, Record<string, TeardownHandler>>();

/** Forget the wrapped handler modules (unit tests that replace a module's handlers between tests). */
export function resetHandlerModulesForTests(): void {
    guardedModules.clear();
}

/**
 * The `teardownHandlers` of a handler module, each wrapped by wrapHandlerWithGuard, or undefined when `sources` has no such
 * module. The default sources are the static imports of HANDLER_SOURCES; tests may pass their own.
 */
export function loadHandlers(module: string, sources: Record<string, Record<string, TeardownHandler>> = HANDLER_SOURCES): Record<string, TeardownHandler> | undefined {
    const cached = sources === HANDLER_SOURCES ? guardedModules.get(module) : undefined;
    if (cached) return cached;
    if (!Object.hasOwn(sources, module)) return undefined;
    const wrapped = Object.fromEntries(Object.entries(sources[module]).map(([t, h]) => [t, wrapHandlerWithGuard(t, h)]));
    if (sources === HANDLER_SOURCES) guardedModules.set(module, wrapped);
    return wrapped;
}

export function handlerOf(
    type: string,
    modules: Record<string, string> = HANDLER_MODULES,
    sources: Record<string, Record<string, TeardownHandler>> = HANDLER_SOURCES,
): TeardownHandler | undefined {
    // Own properties only: a ledger type `constructor` / `__proto__` is not a handler module.
    const module = Object.hasOwn(modules, type) ? modules[type] : undefined;
    const handlers = typeof module === 'string' ? loadHandlers(module, sources) : undefined;
    return handlers && Object.hasOwn(handlers, type) ? handlers[type] : undefined;
}

/** A fresh per-object context (its own seen set, the tier identity). */
export function contextOf(api: APIRequestContext, runId: string, ledger: LedgerLine[], tier: string | null, warn: (m: string) => void): TeardownContext {
    return { api, runId, ledger, seen: new Set(), tier, warn };
}

/**
 * Remove one own object the way the teardown does: dry-run check, registry handler (guarded), `deleted` ledger line
 * (unless kept). Used by the guard proof (tests/api/tier-snapshot.setup.ts); executeTeardown adds retries and cascade reporting.
 */
export async function removeOwnObject(ctx: Omit<TeardownContext, 'seen' | 'warn' | 'tier'> & Partial<TeardownContext>, line: LedgerLine, spec = 'runTeardown'): Promise<RemoveResult> {
    assertNotDryRun(`removeOwnObject.${line.type}`);
    const h = handlerOf(line.type);
    if (!h) throw new Error(`no handler (type ${line.type})`);
    const full: TeardownContext = {
        seen: new Set(), tier: tierIdentity() ?? null, warn: (m) => logger.warn(m),
        knownBug: (n) => {
            logger.warn(`known bug ${n.bug}: ${n.type} ${n.uuid}: ${n.note}`);
            recordWorkaround(n, ctx.runId);
        },
        ...ctx,
    };
    const result = await h.remove(full, line);
    if (result !== 'kept') recordDeleted(line.type, { uuid: line.uuid, name: line.name }, spec);
    return result;
}

export interface PlanItem {
    step: number;
    type: string;
    uuid: string;
    name: string;
    action: string;
    parents?: string;
    /** Set when the guard refuses the line: it is reported (type + uuid), never deleted. */
    refused?: string;
    line: LedgerLine;
}

export interface PlanOptions {
    /** Tier identity the lines must carry; null / undefined = not checked. */
    tier?: string | null;
}

/** Live own objects of the run in delete order (newest first inside a type), each with its action or its refusal. */
export function planTeardown(lines: LedgerLine[], runId: string, handler: (type: string) => TeardownHandler | undefined = handlerOf, opts: PlanOptions = {}): PlanItem[] {
    const seen = new Set<string>();
    const items: PlanItem[] = [];
    for (const line of [...lines].reverse()) {
        if (line.runId !== runId || line.event !== 'created' || seen.has(line.uuid)) continue;
        seen.add(line.uuid);
        const o = checkOwnership(line, { lines, runId, ...(opts.tier ? { tier: opts.tier } : {}) });
        if (!o.own && /deleted already/.test(o.reason)) continue;
        if (line.type.startsWith('k8s:')) {
            // Contract: the spec's afterAll removes the object and records `deleted`; a live k8s line is a leftover.
            items.push({ step: 0, type: line.type, uuid: line.uuid, name: line.name, action: 'removed by its spec (afterAll + recordDeleted); listed here as a leftover', refused: 'not deleted by the teardown (k8s contract)', line });
            continue;
        }
        const h = handler(line.type);
        items.push({
            step: deleteStepOf(line.type),
            type: line.type,
            uuid: line.uuid,
            name: line.name,
            action: h?.action ?? `no handler (type ${line.type})`,
            ...(line.parents ? { parents: JSON.stringify(line.parents) } : {}),
            ...(o.own ? {} : { refused: o.reason }),
            line,
        });
    }
    return items.sort((a, b) => a.step - b.step || typeRank(a.type) - typeRank(b.type));
}

/** The plan as text; a refused line shows type and uuid only (its name may be a foreign object's). */
export function formatPlan(plan: PlanItem[]): string {
    if (!plan.length) return '  (nothing to delete)';
    return plan
        .map((p) => `  ${String(p.step).padStart(2)} ${p.type.padEnd(18)} ${p.uuid.padEnd(36)} ${(p.refused ? '(name withheld)' : p.name).padEnd(40)} ` +
            `${p.refused ? `REFUSED: ${p.refused}` : p.action}` + (p.parents && !p.refused ? ` parents=${p.parents}` : ''))
        .join('\n');
}

export interface ExecuteOptions {
    runId: string;
    /** A fresh authenticated context; called once per object. */
    newApi: () => Promise<APIRequestContext>;
    readLines?: () => LedgerLine[];
    handler?: (type: string) => TeardownHandler | undefined;
    onDeleted?: (item: PlanItem, note?: string) => void;
    /** Tier identity the lines must carry; null = not checked. Default: tierIdentity() of the process. */
    tier?: string | null;
    /** Absence-check poll interval (tests). */
    pollMs?: number;
    /** attemptCleanup retry delay (tests). */
    retryDelayMs?: number;
    /** The step hooks (default PRE_STEPS; tests inject their own or none). */
    preSteps?: readonly TeardownPrepStep[];
}

/** The `note` of a `deleted` ledger line written by the final pass. */
export const FINAL_PASS_NOTE = 'deleted in the final pass (the first attempt failed while a later step still referenced it)';

/**
 * Pure: whether a failed delete may get the final-pass attempt. Not retried: a missing route or object (nothing to delete) and any
 * refusal of the guard (OwnObjectViolation "refusing to touch …", the dry-run refusal): what the guard refused once it refuses again.
 */
export const isRetryableFailure = (message: string | undefined): boolean =>
    !/route or object missing|: refusing to touch |API_TEARDOWN_DRY_RUN is on/.test(String(message ?? ''));

/** The step hooks of the run-end teardown. */
export function defaultPrepSteps(): readonly TeardownPrepStep[] {
    return [{
        before: deleteStepOf('certificates'), name: 'ungate own RA profiles',
        when: (lines, runId) => hasLiveOwn(lines, runId, 'approvalProfiles') && hasLiveOwn(lines, runId, 'raProfiles'),
        run: ungateOwnRaProfiles,
    }];
}

export interface ExecuteResult {
    deleted: Array<{ type: string; uuid: string }>;
    kept: PlanItem[];
    failed: PlanItem[];
    warnings: string[];
    /** Per kept object: the handler's reasons (the warnings it raised for that object). */
    keptReasons: Record<string, string[]>;
    /** Known product bugs worked around during the deletes (core#2511), for the log and the kept report. */
    knownBugs: WorkaroundNote[];
    /** The final pass: objects retried and how many of them were deleted then. */
    finalPass: { retried: number; deleted: number };
}

/**
 * One run of the delete steps. The state the phases share lives in the fields: the result, the failures a final pass may
 * retry (`retryable`, in failure order) and the warnings of the object being removed (`current`, read for a kept
 * object's reasons). The phases are `prepSteps` (the hooks of a step), `deleteStep` (the objects of a step, one by one
 * through `deleteItem`) and `finalPass` (one more attempt per failed delete, oldest failure first).
 */
class TeardownRun {
    readonly result: ExecuteResult = { deleted: [], kept: [], failed: [], warnings: [], keptReasons: {}, knownBugs: [], finalPass: { retried: 0, deleted: 0 } };
    private readonly retryable: PlanItem[] = [];
    private current: string[] = [];
    private readonly readLines: () => LedgerLine[];
    private readonly handler: (type: string) => TeardownHandler | undefined;
    private readonly tier: string | null;
    private readonly onDeleted: (item: PlanItem, note?: string) => void;
    private readonly preSteps: readonly TeardownPrepStep[];

    constructor(private readonly opts: ExecuteOptions) {
        this.readLines = opts.readLines ?? (() => readLedger());
        this.handler = opts.handler ?? handlerOf;
        this.tier = opts.tier === undefined ? (tierIdentity() ?? null) : opts.tier;
        this.onDeleted = opts.onDeleted ?? ((p: PlanItem, note?: string) => recordDeleted(p.type, { uuid: p.uuid, name: p.name }, 'runTeardown', note));
        this.preSteps = opts.preSteps ?? defaultPrepSteps();
    }

    /** Attempted deletes that failed: the last failure record of an object (the final pass retries them in reverse order of failure). */
    private lastFailureOf(item: PlanItem): CleanupFailure | undefined {
        return readCleanupFailures().filter((f) => f.resource === item.type && f.uuid === item.uuid).pop();
    }

    private readonly knownBug = (n: WorkaroundNote): void => {
        logger.warn(`known bug ${n.bug}: ${n.type} ${n.uuid}: ${n.note}`);
        if (!this.result.knownBugs.some((k) => k.bug === n.bug && k.uuid === n.uuid && k.note === n.note)) this.result.knownBugs.push(n);
    };

    private readonly warn = (m: string): void => {
        logger.warn(m);
        this.result.warnings.push(m);
        this.current.push(m);
    };

    /** A fresh per-object context: its own seen set, the tier identity, the run's warning and known-bug sinks. */
    private contextFor(api: APIRequestContext, lines: LedgerLine[], withKnownBug: boolean): TeardownContext {
        return {
            ...contextOf(api, this.opts.runId, lines, this.tier, this.warn),
            ...(withKnownBug ? { knownBug: this.knownBug } : {}),
            ...(this.opts.pollMs !== undefined ? { pollMs: this.opts.pollMs } : {}),
        };
    }

    async execute(): Promise<ExecuteResult> {
        for (const step of [0, ...DELETE_ORDER.map((s) => s.step), 99]) {
            await this.prepSteps(step);
            await this.deleteStep(step);
        }
        await this.finalPass();
        logger.info(`final pass: ${this.result.finalPass.retried} retried, ${this.result.finalPass.deleted} deleted`);
        return this.result;
    }

    /** The hooks of this step run first (once, a fresh context), whatever the ledger holds. */
    private async prepSteps(step: number): Promise<void> {
        for (const hook of this.preSteps.filter((h) => h.before === step && h.when(this.readLines(), this.opts.runId))) {
            const api = await this.opts.newApi();
            try {
                await hook.run({ ...contextOf(api, this.opts.runId, this.readLines(), this.tier, this.warn), ...(this.opts.pollMs !== undefined ? { pollMs: this.opts.pollMs } : {}) });
            } catch (e) {
                const message = `pre-step "${hook.name}" failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
                logger.error(message);
                recordCleanupFailure({ resource: `pre-step:${hook.name}`, uuid: '-', message });
                this.result.warnings.push(message);
            } finally {
                await api.dispose().catch(() => undefined);
            }
        }
    }

    private async deleteStep(step: number): Promise<void> {
        const lines = this.readLines();
        const items = planTeardown(lines, this.opts.runId, this.handler, { tier: this.tier }).filter((p) => p.step === step);
        if (!items.length) return;
        logger.info(`step ${step}: ${items.length} object(s)`);
        for (const item of items) await this.deleteItem(item, lines, step);
    }

    /** One object: refused or without a handler is a recorded failure; otherwise one guarded attempt (attemptCleanup retries once). */
    private async deleteItem(item: PlanItem, lines: LedgerLine[], step: number): Promise<void> {
        const describe = { resource: item.type, uuid: item.uuid, ...(item.refused ? {} : { name: item.name }) };
        const h = this.handler(item.type);
        if (item.refused || !h) {
            recordCleanupFailure({ ...describe, message: item.refused ? `refused: ${item.refused}` : `no handler (type ${item.type})` });
            this.result.failed.push(item);
            return;
        }
        const upstream = this.result.failed.find((f) => f.step < step && !f.refused);
        this.current = [];
        const api = await this.opts.newApi();
        const ctx = this.contextFor(api, lines, true);
        let kept = false;
        try {
            const ok = await attemptCleanup(
                describe,
                async () => {
                    // The ledger guard once more right before the handler (which adds the live check).
                    assertOwn(item.line, `runTeardown.${item.type}`, { lines, runId: this.opts.runId, ...(this.tier ? { tier: this.tier } : {}) });
                    kept = (await h.remove(ctx, item.line)) === 'kept';
                },
                { blockedBy: upstream ? `${upstream.type} ${upstream.uuid}` : undefined, ...(this.opts.retryDelayMs !== undefined ? { retryDelayMs: this.opts.retryDelayMs } : {}) },
            );
            if (!ok) {
                this.result.failed.push(item);
                if (isRetryableFailure(this.lastFailureOf(item)?.message)) this.retryable.push(item);
            } else if (kept) {
                this.keep(item, `kept ${item.type} ${item.uuid}: provably older than the run, or adopted (see the handler's reason above)`);
            } else {
                this.onDeleted(item);
                this.result.deleted.push({ type: item.type, uuid: item.uuid });
            }
        } finally {
            await api.dispose().catch(() => undefined);
        }
    }

    /** A kept object: a warning, and the reasons the handler raised for it are the kept report's. */
    private keep(item: PlanItem, warning: string): void {
        const reasons = [...this.current];
        this.warn(warning);
        this.result.kept.push(item);
        this.result.keptReasons[item.uuid] = reasons;
    }

    /**
     * One more attempt for each failed delete, OLDEST failure first (in a cascade the root cause failed first: a certificate in
     * step 4, then its RA profile in step 10 because of it), through the same guarded handler path.
     */
    private async finalPass(): Promise<void> {
        if (!this.retryable.length) return;
        if (isDryRun()) {
            // The dry run never deletes (checked again by every wrapped handler); the failures stay as they are.
            this.warn(`final pass skipped under the dry run: ${this.retryable.length} failure(s) stay`);
            return;
        }
        for (const item of this.retryable) {
            if (this.handler(item.type)) await this.retryItem(item);
        }
    }

    private async retryItem(item: PlanItem): Promise<void> {
        const h = this.handler(item.type)!;
        this.result.finalPass.retried += 1;
        const lines = this.readLines();
        this.current = [];
        const api = await this.opts.newApi();
        const ctx = this.contextFor(api, lines, true);
        const first = this.lastFailureOf(item);
        const same = (f: CleanupFailure) => f.resource === item.type && f.uuid === item.uuid;
        try {
            assertOwn(item.line, `runTeardown.finalPass.${item.type}`, { lines, runId: this.opts.runId, ...(this.tier ? { tier: this.tier } : {}) });
            const kept = (await h.remove(ctx, item.line)) === 'kept';
            if (kept) {
                this.keep(item, `kept ${item.type} ${item.uuid} in the final pass: provably older than the run, or adopted (see the handler's reason above)`);
            } else if (!this.recordFinalPassDeletion(item)) {
                return;
            }
            rewriteCleanupFailures((all) => all.filter((f) => !same(f)));
            this.result.failed = this.result.failed.filter((f) => f !== item);
        } catch (e) {
            // Still a failure: one record, naming both attempts.
            const again = String((e as Error)?.message ?? e);
            rewriteCleanupFailures((all) => [
                ...all.filter((f) => !same(f)),
                {
                    ...(first ?? { resource: item.type, uuid: item.uuid, ...(item.refused ? {} : { name: item.name }) }),
                    status: statusOf(e) ?? first?.status,
                    message: `first attempt: ${first?.message ?? '(no error text)'} | final pass: ${again}`,
                },
            ]);
        } finally {
            await api.dispose().catch(() => undefined);
        }
    }

    /**
     * The `deleted` ledger line FIRST: if it cannot be written, the failure record and `failed` stay as they were, so the
     * counts and the ledger never disagree. False when the line could not be written.
     */
    private recordFinalPassDeletion(item: PlanItem): boolean {
        try {
            this.onDeleted(item, FINAL_PASS_NOTE);
        } catch (e) {
            this.warn(`final pass: ${item.type} ${item.uuid} was removed but its deleted ledger line could not be written (${String((e as Error)?.message ?? e).slice(0, 200)}); the failure stays`);
            return false;
        }
        this.result.deleted.push({ type: item.type, uuid: item.uuid });
        this.result.finalPass.deleted += 1;
        return true;
    }
}

/** Deletes the plan step by step (the ledger is re-read before each step: a step can add derived lines). */
export async function executeTeardown(opts: ExecuteOptions): Promise<ExecuteResult> {
    assertNotDryRun('executeTeardown');
    return new TeardownRun(opts).execute();
}

export interface Authenticated {
    api: APIRequestContext;
    dispose: () => Promise<void>;
}

/** Authenticated context like the specs': loadEnv() + getAuthenticatedApiContext (the env is read when called: unit tests need none). */
export async function authenticatedApi(): Promise<Authenticated> {
    // Required here, not imported at the top: utils/env.ts loads the dotenv file as a side effect of its import, and this
    // module is imported by unit tests, the dry run and the configs' teardown, none of which may read a .env file early.
    const { loadEnv } = require('../../env') as typeof import('../../env');
    const env = loadEnv();
    const base = await playwrightRequest.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
    const api = await getAuthenticatedApiContext(base, env);
    return { api, dispose: async () => { await api.dispose(); await base.dispose(); } };
}

/**
 * A reader that re-authenticates once and retries a request that answered 401 (a token that expired during a long
 * snapshot). Used for the post-delete snapshot; the delete steps get a fresh context per object.
 */
export async function reauthenticating(newApi: () => Promise<APIRequestContext>): Promise<SnapshotReader> {
    let current = await newApi();
    return {
        async fetch(urlOrRequest, options) {
            let res = await current.fetch(urlOrRequest, options);
            if (res.status() === 401) {
                logger.info('401 during the teardown: authenticating again and retrying once');
                current = await newApi();
                res = await current.fetch(urlOrRequest, options);
            }
            return res;
        },
    };
}

/**
 * `<state dir>/<run id>.kept.json`: the objects the teardown kept (type, uuid, reasons; no names) and the known
 * product bugs it worked around (`knownBugs`: bug, type, uuid, note — e.g. core#2511).
 */
function keptReportFile(runId: string = currentRunId(), env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${runId}.kept.json`);
}

export interface KeptReport {
    runId: string;
    at: string;
    kept: Array<{ type: string; uuid: string; reasons: string[] }>;
    knownBugs: WorkaroundNote[];
}

/** The run's kept report, or undefined (missing, unreadable, or another run's). */
export function readKeptReport(runId: string = currentRunId(), env: NodeJS.ProcessEnv = process.env): KeptReport | undefined {
    try {
        const r = JSON.parse(fs.readFileSync(keptReportFile(runId, env), 'utf8')) as KeptReport;
        return r && r.runId === runId ? { ...r, kept: Array.isArray(r.kept) ? r.kept : [], knownBugs: Array.isArray(r.knownBugs) ? r.knownBugs : [] } : undefined;
    } catch {
        return undefined;
    }
}

const sameNote = (a: WorkaroundNote, b: WorkaroundNote): boolean => a.bug === b.bug && a.uuid === b.uuid && a.note === b.note;
const mergeNotes = (a: WorkaroundNote[], b: WorkaroundNote[]): WorkaroundNote[] => [...a, ...b.filter((n) => !a.some((m) => sameNote(m, n)))];

/**
 * Adds a known product bug the run worked around OUTSIDE the run-end teardown (the setup's guard proof deletes its role
 * through `removeOwnObject`) to the run's kept report, so the run summary lists it too.
 */
export function recordWorkaround(note: WorkaroundNote, runId: string = currentRunId(), env: NodeJS.ProcessEnv = process.env): string {
    const file = keptReportFile(runId, env);
    const current = readKeptReport(runId, env);
    const report: KeptReport = { runId, at: new Date().toISOString(), kept: current?.kept ?? [], knownBugs: mergeNotes(current?.knownBugs ?? [], [note]) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
}

/**
 * The run summary of the globalTeardown: counts, and every known product bug listed in
 * `<run id>.kept.json` (worked around by the setup or by the teardown), so a green run still shows them.
 */
export function formatRunSummary(runId: string, counts: { deleted: number; kept: number; failed: number } | undefined, env: NodeJS.ProcessEnv = process.env, failures: Array<{ resource: string; uuid?: string; message?: string }> = []): string {
    const report = readKeptReport(runId, env);
    const lines = [`run summary ${runId}: ${counts ? `deleted ${counts.deleted}, kept ${counts.kept}, failed ${counts.failed}` : 'nothing deleted by the teardown'}`];
    // Every failed removal with its full error text (never just a count: on a live tier a count alone left one "no status" failure
    // unexplained).
    for (const f of failures) lines.push(`failed ${f.resource} ${f.uuid}: ${String(f.message ?? '(no error text)').replace(/\s+/g, ' ').trim().slice(0, 1500)}`);
    const bugs = report?.knownBugs ?? [];
    lines.push(bugs.length
        ? `known product bugs worked around (${bugs.length}, ${keptReportFile(runId, env)}):\n  ${bugs.map((k) => `${k.bug}: ${k.type} ${k.uuid} — ${k.note}`).join('\n  ')}`
        : 'known product bugs worked around: none');
    return lines.join('\n');
}

/**
 * Writes the kept report (removes a stale one when nothing was kept and no known bug was worked around); returns its
 * path when written. Known bugs already recorded for the same run (the setup's, `recordWorkaround`) are kept.
 */
export function writeKeptReport(runId: string, result: Pick<ExecuteResult, 'kept' | 'keptReasons'> & Partial<Pick<ExecuteResult, 'knownBugs'>>, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const file = keptReportFile(runId, env);
    const knownBugs = mergeNotes(readKeptReport(runId, env)?.knownBugs ?? [], result.knownBugs ?? []);
    if (!result.kept.length && !knownBugs.length) {
        fs.rmSync(file, { force: true });
        return undefined;
    }
    const rows = result.kept.map((k) => ({ type: k.type, uuid: k.uuid, reasons: result.keptReasons[k.uuid] ?? [] }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ runId, at: new Date().toISOString(), kept: rows, knownBugs }, null, 2)}\n`);
    return file;
}

/** REG_KEPT_STRICT: a non-empty kept list fails the run (default off: kept objects are warnings). */
export const isKeptStrict = (env: NodeJS.ProcessEnv = process.env): boolean => parseFlag(settings(env).keptStrict, 'REG_KEPT_STRICT', false);

/** The cleanup failures of the run as one report (the ledger is cleared), or undefined when nothing was left. */
function leftoverReport(): string | undefined {
    const failures = readCleanupFailures();
    clearCleanupFailures();
    if (!failures.length) return undefined;
    const report = formatCleanupReport(failures);
    logger.error(`Cleanup did not complete:\n${report}`);
    return `Cleanup did not complete — the environment still holds objects from this run.\n${report}`;
}

export interface TeardownDeps {
    /** How the teardown authenticates (default: loadEnv + the specs' token flow). The dry run never calls it. */
    authenticate?: () => Promise<Authenticated>;
}

/** Throws unless the run has one real id: not adhoc, and API_RUN_ID equal to REG_RUN_ID when set. */
function assertRealRunId(env: NodeJS.ProcessEnv = process.env): string {
    const runId = currentRunId(env);
    if (isDefaultRunId(runId) || (settings(env).apiRunId !== undefined && (DEFAULT_RUN_IDS.includes(settings(env).apiRunId!) || settings(env).apiRunId !== runId))) {
        throw new Error(`runTeardown: the run id is an adhoc default (${DEFAULT_RUN_IDS.join(' / ')}) or API_RUN_ID differs from REG_RUN_ID; ` +
            'refusing to delete anything. Run through playwright.regression.config.ts / playwright.api.config.ts, or set REG_RUN_ID.');
    }
    return runId;
}

/**
 * The globalTeardown. Whatever the outcome, the run's local-backend proof (`<run id>.local-proof.json`, tier/localProof.ts) is
 * removed at the end: a later invocation never inherits it.
 */
export default async function runTeardown(config?: FullConfig, deps: TeardownDeps = {}): Promise<void> {
    try {
        await teardownRun(config, deps);
    } finally {
        removeLocalProof();
    }
}

/** Preconditions: the run has one real id and a tier, and the flags parse. Throws before anything is read or sent. */
function assertPreconditions(): { runId: string; dryRun: boolean; strictKept: boolean; tier: string | null } {
    const runId = assertRealRunId();
    assertRunTier();
    const dryRun = isDryRun();
    const strictKept = isKeptStrict();
    if (!process.env.BASE_URL) {
        // A run without a tier tested nothing; it must never end green and empty.
        const leftovers = leftoverReport();
        throw new Error(['BASE_URL is unset: the run had no tier, so it tested nothing and could not clean up; failing the run ' +
            '(set BASE_URL through REG_ENV_FILE / the config folder\'s .env).', ...(leftovers ? [leftovers] : [])].join('\n\n'));
    }
    return { runId, dryRun, strictKept, tier: tierIdentity() ?? null };
}

/** Dry run: API_TEARDOWN_DRY_RUN prints the plan and stops: no request, no authentication. */
function dryRunReport(plan: PlanItem[], runId: string): void {
    logger.info(`API_TEARDOWN_DRY_RUN — plan for run ${runId} (nothing is deleted):\n${formatPlan(plan)}`);
    const refused = plan.filter((p) => p.refused);
    if (refused.length) logger.warn(`${refused.length} ledger line(s) refused by the own-object guard`);
    logger.info(formatRunSummary(runId, undefined));
}

/** Keep: API_DELETE_OWN off keeps the objects and prints the ledger path; what specs failed to clean still fails the run. */
function keepReport(plan: PlanItem[], runId: string): void {
    logger.info(`API_DELETE_OWN off — keeping the run's objects. Ledger: ${ledgerFile()} (run ${runId}), ${plan.length} live object(s)`);
    logger.info(formatRunSummary(runId, undefined));
    const leftovers = leftoverReport();
    if (leftovers) throw new Error(leftovers);
}

/** The authenticated half of the local-backend proof, before anything is deleted on a "local" stack. */
async function assertLocalBackendBeforeDeleting(authenticate: () => Promise<Authenticated>): Promise<void> {
    const check = await authenticate();
    try {
        await assertLocalBackend(check.api);
    } finally {
        await check.dispose().catch(() => undefined);
    }
}

/** The kept report and the run summary; returns the REG_KEPT_STRICT problem, if any. */
function reportKept(runId: string, result: ExecuteResult, strictKept: boolean): string[] {
    const keptFile = writeKeptReport(runId, result);
    // The run summary lists every known bug of <run id>.kept.json: the teardown's and the setup's.
    const summary = formatRunSummary(runId, { deleted: result.deleted.length, kept: result.kept.length, failed: result.failed.length }, process.env, readCleanupFailures());
    if (readKeptReport(runId)?.knownBugs.length) logger.warn(summary);
    else logger.info(summary);
    if (!keptFile || !result.kept.length) return [];
    logger.warn(`${result.kept.length} object(s) of the run were kept (not deleted): ${keptFile}`);
    return strictKept
        ? [`REG_KEPT_STRICT: ${result.kept.length} object(s) of the run were kept, not deleted (${keptFile}): ` + result.kept.map((k) => `${k.type} ${k.uuid}`).join(', ')]
        : [];
}

/**
 * Non-interference proof: on a shared tier, a second snapshot after the deletes judged against the "before" snapshot the `snapshot` project
 * stored; returns the problems (a missing before snapshot, a violation). A wrong delete would otherwise pass the API-GEN-33 proof,
 * which runs before this teardown.
 */
async function proveNonInterference(runId: string, result: ExecuteResult, newApi: () => Promise<APIRequestContext>): Promise<string[]> {
    if (isLocalTier()) {
        logger.info('TIER_KIND=local: no non-interference snapshot');
        return [];
    }
    const before = readSnapshot(beforeSnapshotFile(runId));
    if (!before) {
        return ['No before snapshot of this run on a shared tier: the non-interference proof (API-GEN-33) is missing ' +
            '(the snapshot project failed or was skipped, e.g. --no-deps). The run cannot show that it left the tier untouched.'];
    }
    const reader = await reauthenticating(newApi);
    const after = await snapshotTier(reader, { recheck: before, runId });
    const ledger = readLedger();
    const confirmedCreated = await confirmForeignCreates(reader, before, after, { ledger, runId, ownDeleted: result.deleted });
    const compared = compareSnapshots(before, after, { ledger, runId, ownDeleted: result.deleted, confirmedCreated });
    compared.notes.forEach((n) => logger.info(`non-interference note: ${n}`));
    if (!compared.violations.length) return [];
    logger.error(`non-interference after the deletes:\n  ${compared.violations.join('\n  ')}`);
    return [`Non-interference violated after the run-end deletes (API-GEN-33 re-check):\n  ${compared.violations.join('\n  ')}`];
}

/** Delete and prove: delete the plan with a fresh authenticated context per object, then prove nothing foreign changed. */
async function deleteAndProve(runId: string, tier: string | null, plan: PlanItem[], strictKept: boolean, deps: TeardownDeps): Promise<void> {
    logger.info(`deleting ${plan.length} own object(s) of run ${runId}; cleanup ledger ${cleanupLedgerFile()}`);
    const authenticate = deps.authenticate ?? authenticatedApi;
    if (isLocalTier()) await assertLocalBackendBeforeDeleting(authenticate);
    const disposers: Array<() => Promise<void>> = [];
    const newApi = async () => {
        const { api, dispose } = await authenticate();
        disposers.push(dispose);
        return api;
    };
    const problems: string[] = [];
    let warnings: string[] = [];
    try {
        const result = await executeTeardown({ runId, newApi, tier });
        warnings = result.warnings;
        problems.push(...reportKept(runId, result, strictKept), ...(await proveNonInterference(runId, result, newApi)));
    } finally {
        for (const dispose of disposers) await dispose().catch(() => undefined);
    }
    if (warnings.length) logger.warn(`teardown warnings (kept objects are not deleted and not failures):\n  ${warnings.join('\n  ')}`);
    const leftovers = leftoverReport();
    if (leftovers) problems.push(leftovers);
    if (problems.length) throw new Error(problems.join('\n\n'));
}

/** The teardown: preconditions, then the dry-run report, the keep report, or delete and prove. */
async function teardownRun(_config: FullConfig | undefined, deps: TeardownDeps): Promise<void> {
    const { runId, dryRun, strictKept, tier } = assertPreconditions();
    const plan = planTeardown(readLedger(), runId, handlerOf, { tier });
    if (dryRun) return dryRunReport(plan, runId);
    if (!mayDeleteOwn()) return keepReport(plan, runId);
    await deleteAndProve(runId, tier, plan, strictKept, deps);
}
