/**
 * runTeardown — globalTeardown of the REG-* and API-* configs: deletes the run's own objects (decision D1) and proves
 * afterwards that nothing else was touched.
 *
 * WHAT
 * 1. Refuses to run under an adhoc run id (`qa-reg-adhoc`, `qa-api-adhoc`) or when API_RUN_ID differs from REG_RUN_ID:
 *    without one real run id it cannot tell its objects from anyone else's (R13). Re-runs the tier assertion of the
 *    configs (TIER_KIND frozen, local proof, header auth, BASE_URL unchanged; R3). BASE_URL unset fails the run (Q11):
 *    a run without a tier tested nothing and must never end green.
 * 2. Rebuilds the object list from the ledger alone (workers and the runner share no memory): `created` lines of THIS
 *    run without a later `deleted` line, each checked with the own-object guard (ledger line + name prefix; derived
 *    objects through createdAfter) and recorded on THIS tier (tier identity, R15). Anything that fails is refused and
 *    reported, never deleted. Refused lines are reported by type and uuid only (R20).
 * 3. API_TEARDOWN_DRY_RUN on (parsed switch, R4) prints the plan (step, type, uuid, name, action, parents, refusals)
 *    and stops: no request, no authentication. The dry run is ALSO checked at the top of executeTeardown,
 *    removeOwnObject and every handler entry (`guardHandler`), so no path deletes under it.
 *    API_DELETE_OWN off keeps the objects and prints the ledger path.
 * 4. Walks DELETE_ORDER; every delete goes through attemptCleanup (one retry, cascade reporting) and appends a
 *    `deleted` ledger line. Every object gets a FRESH authenticated context (R10: a long revoke wait cannot outlive the
 *    token) and its own `seen` set (R5). The handlers are loaded per type from the module that creates the objects and
 *    wrapped by `guardHandler`: dry-run check, then `assertOwnLive` (ledger + live run-prefixed name, R6) before the
 *    handler sees the object; a type whose module does not exist yet is reported as "no handler (type X)", but only
 *    when such ledger lines exist. A handler that answers "kept" (a derived object provably older than the run, or
 *    adopted) is a WARNING, not a failure (R17); the kept objects are written to `<state dir>/<run id>.kept.json`
 *    (type, uuid, reasons) and REG_KEPT_STRICT=1 fails the run on a non-empty list (review Q6). A derived object whose
 *    creation time is unknown is not "kept": its handler fails (red).
 * 5. Deletion rule (R5): a delete counts only when a GET afterwards proves the object absent; a DELETE answering 404
 *    counts as done only if the same object was read with 200 earlier in its step; otherwise the step fails with
 *    "route or object missing".
 * 6. On a shared tier, takes a second snapshot after the deletes (with a context that re-authenticates once on 401) and
 *    re-runs compareSnapshots against the "before" snapshot the `snapshot` project stored: a wrong delete would otherwise
 *    pass the API-GEN-33 proof, which runs before this teardown. A missing before snapshot on a shared tier, a
 *    violation or any cleanup failure fails the run (non-zero exit, R9): cleanup is part of the result.
 * 7. Under TIER_KIND=local, before the first delete: the authenticated local-backend check (tier.ts
 *    `assertLocalBackend`, review Q4). At the very end (every path) the run's local-backend proof file is removed.
 * 8. Roles and users whose detail answers 5xx after the delete (known bug core#2511) are confirmed gone through their
 *    full list only; the workaround is logged and listed under `knownBugs` in `<run id>.kept.json`.
 * 9. Guard-integration pass (2026-10-14): DELETE_ORDER follows core's reference refusals (REFERENCED_BY, GD-04: actions
 *    before executions, the notification steps after the workflow step); step hooks (PRE_STEPS, cert-lifecycle G2:
 *    own RA profiles are dissociated from own approval profiles before the certificate step, so a crashed spec cannot
 *    leave the revoke gated); `keyItems` go with their key (platform G-1, `goneWith`); own token keys are removed by
 *    teardownHandlers' own `keys` handler — exactly ONE handler for every own token key (protocols G-PROT-1, the
 *    protocols review F5): the area modules' `keys` handlers (protocolCa, keyApi / cryptoApi) are never consulted;
 *    approvals / approval profiles the platform
 *    retains (core never deletes an approval; an approval profile with approvals cannot be deleted,
 *    ApprovalProfileServiceImpl.java:119-127) may be answered `kept` by their handlers (cert-lifecycle G3: a warning
 *    and a kept-report line, REG_KEPT_STRICT=1 turns it red — the documented residue of a lifecycle run).
 *
 * Kubernetes objects (`k8s:<kind>` ledger lines, REG-USE-06 / REG-PROT-19…21) are never deleted here. Contract: the
 * spec removes them in its own `afterAll` (attemptCleanup) and appends `recordDeleted('k8s:<kind>', ref, spec)` for each
 * one it removed; a `k8s:` line without its `deleted` line is listed below as a leftover and fails the run.
 */
import { APIRequestContext, FullConfig, request as playwrightRequest } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../Logger';
import { attemptCleanup, clearCleanupFailures, cleanupLedgerFile, formatCleanupReport, readCleanupFailures, recordCleanupFailure } from '../cleanupLedger';
import { assertNotDryRun, isDryRun, parseFlag } from './flags';
import { compareSnapshots, loadSnapshot, snapshotTier } from './nonInterference';
import { assertOwn, assertOwnLive, KnownBugNote, LiveObjectMissing, mayDeleteOwn, ownership } from './ownObjects';
import { LedgerLine, ledgerFile, readLedger, recordDeleted } from './regressionRun';
import { ADHOC_RUN_IDS, currentRunId, isAdhocRun, regressionStateDir, snapshotBeforeFile } from './runId';
import { assertLocalBackend, assertRunTier, isLocalTier, removeLocalProof, tierIdentity } from './tier';

const logger = new Logger('RunTeardown');

type Json = Record<string, any>;

export interface TeardownContext {
    api: APIRequestContext;
    runId: string;
    /** The ledger as of the start of the current step. */
    ledger: LedgerLine[];
    /** Uuids read with 200 during this object's step (R5): only those may count a 404 as "gone". */
    seen: Set<string>;
    /** Tier identity the ledger lines must carry; null = not checked (no BASE_URL, unit tests). */
    tier: string | null;
    /** The live object read by `guardHandler` right before `remove` (absent for an id-named type). */
    live?: Json;
    /** Report a kept object or another non-fatal finding (printed at the end of the teardown). */
    warn: (message: string) => void;
    /** Poll interval of the absence check (tests shorten it). */
    pollMs?: number;
    /** A known product bug was worked around (core#2511: absence confirmed through the full list); logged and reported. */
    knownBug?: (note: KnownBugNote) => void;
}

export type RemoveResult = void | 'kept';

export interface TeardownHandler {
    /** One line for the dry-run plan: what remove() does. */
    action: string;
    remove(ctx: TeardownContext, line: LedgerLine): Promise<RemoveResult>;
    /**
     * Platform G-1: an object that goes WITH its parent (a key item with its key). When the live read finds it gone and
     * this answers true (the parent's `deleted` ledger line of this run exists), the removal is done — the parent's
     * handler proved the absence. Any other missing object stays "route or object missing" (R5).
     */
    goneWith?(ctx: TeardownContext, line: LedgerLine): boolean;
}

/**
 * A step hook (cert-lifecycle G2): runs BEFORE the deletes of its step, once, with a fresh context, independent of
 * ledger lines. A failure is recorded as a cleanup failure (the run ends red) and the step still runs.
 */
export interface PreStep {
    /** The DELETE_ORDER step the hook precedes. */
    before: number;
    name: string;
    /** Whether the hook has anything to do for this ledger (no context is opened otherwise). */
    when(lines: LedgerLine[], runId: string): boolean;
    run(ctx: TeardownContext): Promise<void>;
}

/**
 * §B0.5 order: dependants before what they depend on. Within a step, types run in the listed order. Every pair of
 * REFERENCED_BY below is satisfied by this table (tests/unit/runTeardown.spec.ts asserts it mechanically).
 * Guard-integration pass (GD-04, events G-1 + the events review): step 8 runs actions BEFORE executions (core refuses
 * to delete an execution while an action references it) and the notification steps come after the workflow step.
 * Platform G-1: `keyItems` go with their key (step 6, after keys) — a remaining item is reported.
 */
export const DELETE_ORDER: Array<{ step: number; label: string; types: string[] }> = [
    { step: 1, label: 'pending approvals of own certificates (reject through the override path)', types: ['approvals'] },
    { step: 2, label: 'object-level event associations on own objects', types: ['eventAssociations'] },
    { step: 3, label: 'discoveries (their new certificates become derived lines first)', types: ['discoveries'] },
    { step: 4, label: 'certificates, own and derived (own RA profiles ungated from own approval profiles first: PRE_STEPS)', types: ['certificates'] },
    { step: 5, label: 'keys', types: ['keys'] },
    { step: 6, label: 'key items (gone with their key; a remaining item is reported)', types: ['keyItems'] },
    { step: 7, label: 'protocol profiles (deactivate, disable, delete); ACME accounts go with their profile', types: ['acmeProfiles', 'acmeAccounts', 'scepProfiles', 'cmpProfiles'] },
    { step: 8, label: 'triggers → rules → conditions → actions → executions', types: ['triggers', 'rules', 'conditions', 'actions', 'executions'] },
    { step: 9, label: 'notification profiles → instances', types: ['notificationProfiles', 'notificationInstances'] },
    { step: 10, label: 'compliance profiles (own RA associations removed first) → RA profiles → authorities → credentials → connectors this run registered', types: ['complianceProfiles', 'raProfiles', 'authorities', 'credentials', 'connectors'] },
    { step: 11, label: 'token profiles → tokens', types: ['tokenProfiles', 'tokens'] },
    { step: 12, label: 'users (removed from their roles first) → roles → groups → custom attributes → saved views → OID entries', types: ['users', 'roles', 'groups', 'customAttributes', 'savedViews', 'oidEntries'] },
    {
        step: 13,
        label: 'entities, locations, vault secrets → profiles → vaults, approval profiles (compliance profiles go in step 10, before the RA profiles)',
        types: ['entities', 'locations', 'secrets', 'vaultProfiles', 'vaultInstances', 'approvalProfiles'],
    },
    { step: 14, label: 'scheduled jobs (@local only)', types: ['scheduledJobs'] },
];

/**
 * The reference graph core enforces on deletes (GD-04 u2): type A cannot be deleted while an object of type B still
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
    { a: 'certificates', b: 'discoveries', core: 'handler order (R2): the discovery step records the onboarded certificates as derived lines, so it runs before the certificate step (3 before 4)' },
    { a: 'keyItems', b: 'keys', core: 'platform G-1: items go WITH their key (core deleteKey, CryptographicKeyServiceImpl.java:615-645, destroys and deletes the items): the item step follows the key step and only reports what remains' },
    { a: 'approvalProfiles', b: 'approvals', core: 'service/impl/ApprovalProfileServiceImpl.java:119-127 deleteApprovalProfile: 422 "Unable to delete approval profile with existing approvals." (approvals are never deleted by core: the handler may answer kept)' },
    { a: 'raProfiles', b: 'complianceProfiles', core: 'C12 (bug candidate): core\'s RaProfileServiceImpl removes no compliance_profile_association row, so a deleted RA profile leaves a dangling association and the compliance profile\'s non-force delete then answers 404 (v2 ComplianceProfileServiceImpl.java:565-577 resolves the deleted RA profile): the compliance profile (own RA associations removed) is deleted BEFORE the RA profile' },
    { a: 'raProfiles', b: 'certificates', core: 'handler order: the certificate handler (teardownHandlers certificates) revokes an issued certificate through its RA profile, so the certificate step precedes the RA profile step (4 before 10)' },
    { a: 'tokenProfiles', b: 'keys', core: 'service/writer/TokenProfileWriter.java:195-203 validateNoDependentObjects: "Cannot delete Token Profile … dependent Key(s)"' },
    { a: 'tokens', b: 'tokenProfiles', core: 'service/impl/TokenInstanceServiceImpl.java:524-537 deleteTokenInstance: "Dependent Token Profiles: …"' },
];

/** The step a type is deleted in (99: none). */
export const stepOf = (type: string): number => DELETE_ORDER.find((s) => s.types.includes(type))?.step ?? 99;
const typeRank = (type: string): number => DELETE_ORDER.find((s) => s.types.includes(type))?.types.indexOf(type) ?? 0;

/** True when `b` is deleted before `a` by DELETE_ORDER (an earlier step, or earlier in the same step). */
export function deletedBefore(b: string, a: string): boolean {
    return stepOf(b) < stepOf(a) || (stepOf(b) === stepOf(a) && typeRank(b) < typeRank(a));
}

/** Module (relative to utils/regression) whose `teardownHandlers` export removes a type. Missing module = no handler yet. */
export const HANDLER_MODULES: Record<string, string> = {
    approvals: 'lifecycle',
    approvalProfiles: 'lifecycle',
    eventAssociations: '../workflowUtils',
    triggers: '../workflowUtils',
    rules: '../workflowUtils',
    conditions: '../workflowUtils',
    executions: '../workflowUtils',
    actions: '../workflowUtils',
    notificationProfiles: '../notificationUtils',
    notificationInstances: '../notificationUtils',
    scepProfiles: 'protocolProfiles',
    cmpProfiles: 'protocolProfiles',
    entities: 'platformApi',
    locations: 'platformApi',
    secrets: 'platformApi',
    vaultProfiles: 'platformApi',
    vaultInstances: 'platformApi',
    complianceProfiles: 'platformApi',
    // No handler yet (guard-integration pass, platform review): platformApi (platform area) exports neither; the inventory
    // area owns saved views and OID entries and ships `inventoryApi` with their handlers — until then a ledger line of
    // either type is reported as "no handler (type …)" (rows creating them are probe-only / fixme).
    savedViews: 'inventoryApi',
    oidEntries: 'inventoryApi',
    scheduledJobs: 'schedulerApi',
    ...Object.fromEntries(
        ['certificates', 'keys', 'keyItems', 'discoveries', 'acmeProfiles', 'acmeAccounts', 'raProfiles', 'authorities', 'credentials', 'connectors',
            'tokenProfiles', 'tokens', 'users', 'roles', 'groups', 'customAttributes'].map((t) => [t, 'teardownHandlers']),
    ),
};

/**
 * Every handler entry (R4, R5, R6): no delete under the dry run; the line's type must be the handler's; then the live
 * object is read through `assertOwnLive` (ledger, tier, live run-prefixed name) and marked as seen. When the object was
 * seen with 200 earlier in this step and is gone now (the first attempt removed it), there is nothing left to do.
 */
export function guardHandler(type: string, handler: TeardownHandler): TeardownHandler {
    return {
        action: handler.action,
        async remove(ctx, line) {
            assertNotDryRun(`teardown.${type}`);
            if (line.type !== type) throw new Error(`teardown.${type}: handed a ${line.type} line`);
            let live;
            try {
                // No `env` seam: the run id and tier are given, REG_RESTRICTED_USERNAME comes from the process (GD-03).
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

const guardedModules = new Map<string, Record<string, TeardownHandler> | undefined>();

/** The `teardownHandlers` export of a module (each wrapped by guardHandler), or undefined when the module does not exist yet. */
export function loadModuleHandlers(module: string): Record<string, TeardownHandler> | undefined {
    if (guardedModules.has(module)) return guardedModules.get(module);
    const target = path.join(__dirname, module);
    try {
        require.resolve(target);
    } catch {
        return undefined;
    }
    const raw = (require(target) as { teardownHandlers?: Record<string, TeardownHandler> }).teardownHandlers;
    const wrapped = raw && Object.fromEntries(Object.entries(raw).map(([t, h]) => [t, guardHandler(t, h)]));
    guardedModules.set(module, wrapped);
    return wrapped;
}

export function handlerFor(type: string, modules: Record<string, string> = HANDLER_MODULES): TeardownHandler | undefined {
    // Own properties only (fix pass 4): a ledger type `constructor` / `__proto__` is not a handler module.
    const module = Object.hasOwn(modules, type) ? modules[type] : undefined;
    const handlers = typeof module === 'string' ? loadModuleHandlers(module) : undefined;
    return handlers && Object.hasOwn(handlers, type) ? handlers[type] : undefined;
}

/** A fresh per-object context (R5 seen set, R15 tier). */
export function objectContext(api: APIRequestContext, runId: string, ledger: LedgerLine[], tier: string | null, warn: (m: string) => void): TeardownContext {
    return { api, runId, ledger, seen: new Set(), tier, warn };
}

/**
 * Remove one own object the way the teardown does: dry-run check, registry handler (guarded), `deleted` ledger line
 * (unless kept). Used by the guard proof (tests/api/_run-setup.setup.ts); executeTeardown adds retries and cascade reporting.
 */
export async function removeOwnObject(ctx: Omit<TeardownContext, 'seen' | 'warn' | 'tier'> & Partial<TeardownContext>, line: LedgerLine, spec = 'runTeardown'): Promise<RemoveResult> {
    assertNotDryRun(`removeOwnObject.${line.type}`);
    const h = handlerFor(line.type);
    if (!h) throw new Error(`no handler (type ${line.type})`);
    const full: TeardownContext = {
        seen: new Set(), tier: tierIdentity() ?? null, warn: (m) => logger.warn(m),
        knownBug: (n) => {
            logger.warn(`known bug ${n.bug}: ${n.type} ${n.uuid}: ${n.note}`);
            recordKnownBug(n, ctx.runId);
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
    /** Tier identity the lines must carry (R15); null / undefined = not checked. */
    tier?: string | null;
}

/** Live own objects of the run in delete order (newest first inside a type), each with its action or its refusal. */
export function planTeardown(lines: LedgerLine[], runId: string, handler: (type: string) => TeardownHandler | undefined = handlerFor, opts: PlanOptions = {}): PlanItem[] {
    const seen = new Set<string>();
    const items: PlanItem[] = [];
    for (const line of [...lines].reverse()) {
        if (line.runId !== runId || line.event !== 'created' || seen.has(line.uuid)) continue;
        seen.add(line.uuid);
        const o = ownership(line, { lines, runId, ...(opts.tier ? { tier: opts.tier } : {}) });
        if (!o.own && /deleted already/.test(o.reason)) continue;
        if (line.type.startsWith('k8s:')) {
            // Contract: the spec's afterAll removes the object and records `deleted`; a live k8s line is a leftover.
            items.push({ step: 0, type: line.type, uuid: line.uuid, name: line.name, action: 'removed by its spec (afterAll + recordDeleted); listed here as a leftover', refused: 'not deleted by the teardown (k8s contract)', line });
            continue;
        }
        const h = handler(line.type);
        items.push({
            step: stepOf(line.type),
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

/** The plan as text; a refused line shows type and uuid only (its name may be a foreign object's, R20). */
export function formatPlan(plan: PlanItem[]): string {
    if (!plan.length) return '  (nothing to delete)';
    return plan
        .map((p) => `  ${String(p.step).padStart(2)} ${p.type.padEnd(18)} ${p.uuid.padEnd(36)} ${(p.refused ? '(name withheld)' : p.name).padEnd(40)} ` +
            `${p.refused ? `REFUSED: ${p.refused}` : p.action}` + (p.parents && !p.refused ? ` parents=${p.parents}` : ''))
        .join('\n');
}

export interface ExecuteOptions {
    runId: string;
    /** A fresh authenticated context; called once per object (R10). */
    newApi: () => Promise<APIRequestContext>;
    readLines?: () => LedgerLine[];
    handler?: (type: string) => TeardownHandler | undefined;
    onDeleted?: (item: PlanItem) => void;
    /** Tier identity the lines must carry; null = not checked. Default: tierIdentity() of the process. */
    tier?: string | null;
    /** Absence-check poll interval (tests). */
    pollMs?: number;
    /** attemptCleanup retry delay (tests). */
    retryDelayMs?: number;
    /** The step hooks (default PRE_STEPS; tests inject their own or none). */
    preSteps?: readonly PreStep[];
}

/** The step hooks of the run-end teardown (lazy: teardownHandlers imports this module). */
export function defaultPreSteps(): readonly PreStep[] {
    const { ungateOwnRaProfiles, hasLiveOwn } = require('./teardownHandlers') as typeof import('./teardownHandlers');
    return [{
        before: stepOf('certificates'), name: 'ungate own RA profiles (cert-lifecycle G2)',
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
    knownBugs: KnownBugNote[];
}

/** Deletes the plan step by step (the ledger is re-read before each step: a step can add derived lines). */
export async function executeTeardown(opts: ExecuteOptions): Promise<ExecuteResult> {
    assertNotDryRun('executeTeardown');
    const readLines = opts.readLines ?? (() => readLedger());
    const handler = opts.handler ?? handlerFor;
    const tier = opts.tier === undefined ? (tierIdentity() ?? null) : opts.tier;
    const onDeleted = opts.onDeleted ?? ((p: PlanItem) => recordDeleted(p.type, { uuid: p.uuid, name: p.name }, 'runTeardown'));
    const result: ExecuteResult = { deleted: [], kept: [], failed: [], warnings: [], keptReasons: {}, knownBugs: [] };
    let current: string[] = [];
    const warn = (m: string) => {
        logger.warn(m);
        result.warnings.push(m);
        current.push(m);
    };
    const steps = [0, ...DELETE_ORDER.map((s) => s.step), 99];
    const preSteps = opts.preSteps ?? defaultPreSteps();
    for (const step of steps) {
        // Cert-lifecycle G2: the hooks of this step run first (once, a fresh context), whatever the ledger holds.
        for (const hook of preSteps.filter((h) => h.before === step && h.when(readLines(), opts.runId))) {
            const api = await opts.newApi();
            try {
                await hook.run({ ...objectContext(api, opts.runId, readLines(), tier, warn), ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}) });
            } catch (e) {
                const message = `pre-step "${hook.name}" failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
                logger.error(message);
                recordCleanupFailure({ resource: `pre-step:${hook.name}`, uuid: '-', message });
                result.warnings.push(message);
            } finally {
                await api.dispose().catch(() => undefined);
            }
        }
        const lines = readLines();
        const items = planTeardown(lines, opts.runId, handler, { tier }).filter((p) => p.step === step);
        if (!items.length) continue;
        logger.info(`step ${step}: ${items.length} object(s)`);
        for (const item of items) {
            const describe = { resource: item.type, uuid: item.uuid, ...(item.refused ? {} : { name: item.name }) };
            const h = handler(item.type);
            if (item.refused || !h) {
                recordCleanupFailure({ ...describe, message: item.refused ? `refused: ${item.refused}` : `no handler (type ${item.type})` });
                result.failed.push(item);
                continue;
            }
            const upstream = result.failed.find((f) => f.step < step && !f.refused);
            current = [];
            const api = await opts.newApi();
            const knownBug = (n: KnownBugNote) => {
                logger.warn(`known bug ${n.bug}: ${n.type} ${n.uuid}: ${n.note}`);
                if (!result.knownBugs.some((k) => k.bug === n.bug && k.uuid === n.uuid && k.note === n.note)) result.knownBugs.push(n);
            };
            const ctx: TeardownContext = { ...objectContext(api, opts.runId, lines, tier, warn), knownBug, ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}) };
            let kept = false;
            try {
                const ok = await attemptCleanup(
                    describe,
                    async () => {
                        // The ledger guard once more right before the handler (which adds the live check, R6).
                        assertOwn(item.line, `runTeardown.${item.type}`, { lines, runId: opts.runId, ...(tier ? { tier } : {}) });
                        kept = (await h.remove(ctx, item.line)) === 'kept';
                    },
                    { blockedBy: upstream ? `${upstream.type} ${upstream.uuid}` : undefined, ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}) },
                );
                if (!ok) result.failed.push(item);
                else if (kept) {
                    const reasons = [...current];
                    warn(`kept ${item.type} ${item.uuid}: provably older than the run, or adopted (see the handler's reason above)`);
                    result.kept.push(item);
                    result.keptReasons[item.uuid] = reasons;
                } else {
                    onDeleted(item);
                    result.deleted.push({ type: item.type, uuid: item.uuid });
                }
            } finally {
                await api.dispose().catch(() => undefined);
            }
        }
    }
    return result;
}

export interface Authenticated {
    api: APIRequestContext;
    dispose: () => Promise<void>;
}

/** Authenticated context like the specs': loadEnv() + getAuthenticatedApiContext (loaded lazily: unit tests need no env). */
export async function authenticatedApi(): Promise<Authenticated> {
    const { loadEnv } = require('../env') as typeof import('../env');
    const { getAuthenticatedApiContext } = require('../../fixtures/testFixtures') as typeof import('../../fixtures/testFixtures');
    const env = loadEnv();
    const base = await playwrightRequest.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true });
    const api = await getAuthenticatedApiContext(base, env);
    return { api, dispose: async () => { await api.dispose(); await base.dispose(); } };
}

/**
 * A context that re-authenticates once and retries a request that answered 401 (a token that expired during a long
 * snapshot). Used for the post-delete snapshot; the delete steps get a fresh context per object.
 */
export async function reauthenticating(newApi: () => Promise<APIRequestContext>): Promise<APIRequestContext> {
    let current = await newApi();
    const retry = (method: 'get' | 'post' | 'fetch' | 'head') => async (...args: unknown[]) => {
        const call = () => (current as unknown as Record<string, (...a: unknown[]) => Promise<import('@playwright/test').APIResponse>>)[method](...args);
        let res = await call();
        if (res.status() === 401) {
            logger.info('401 during the teardown: authenticating again and retrying once');
            current = await newApi();
            res = await call();
        }
        return res;
    };
    return { get: retry('get'), post: retry('post'), fetch: retry('fetch'), head: retry('head'), dispose: async () => undefined } as unknown as APIRequestContext;
}

/**
 * `<state dir>/<run id>.kept.json`: the objects the teardown kept (type, uuid, reasons; no names, R20) and the known
 * product bugs it worked around (`knownBugs`: bug, type, uuid, note — core#2511 since B0 fix pass 3).
 */
export function keptReportFile(runId: string = currentRunId(), env: NodeJS.ProcessEnv = process.env): string {
    return path.join(regressionStateDir(env), `${runId}.kept.json`);
}

export interface KeptReport {
    runId: string;
    at: string;
    kept: Array<{ type: string; uuid: string; reasons: string[] }>;
    knownBugs: KnownBugNote[];
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

const sameNote = (a: KnownBugNote, b: KnownBugNote): boolean => a.bug === b.bug && a.uuid === b.uuid && a.note === b.note;
const mergeNotes = (a: KnownBugNote[], b: KnownBugNote[]): KnownBugNote[] => [...a, ...b.filter((n) => !a.some((m) => sameNote(m, n)))];

/**
 * Adds a known product bug the run worked around OUTSIDE the run-end teardown (the setup's guard proof deletes its role
 * through `removeOwnObject`) to the run's kept report, so the run summary lists it too (fix pass 4).
 */
export function recordKnownBug(note: KnownBugNote, runId: string = currentRunId(), env: NodeJS.ProcessEnv = process.env): string {
    const file = keptReportFile(runId, env);
    const current = readKeptReport(runId, env);
    const report: KeptReport = { runId, at: new Date().toISOString(), kept: current?.kept ?? [], knownBugs: mergeNotes(current?.knownBugs ?? [], [note]) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
}

/**
 * The run summary of the globalTeardown (fix pass 4): counts, and every known product bug listed in
 * `<run id>.kept.json` (worked around by the setup or by the teardown), so a green run still shows them.
 */
export function runSummary(runId: string, counts: { deleted: number; kept: number; failed: number } | undefined, env: NodeJS.ProcessEnv = process.env, failures: Array<{ resource: string; uuid?: string; message?: string }> = []): string {
    const report = readKeptReport(runId, env);
    const lines = [`run summary ${runId}: ${counts ? `deleted ${counts.deleted}, kept ${counts.kept}, failed ${counts.failed}` : 'nothing deleted by the teardown'}`];
    // Every failed removal with its full error text (never just a count: live run 2 left one "no status" failure unexplained).
    for (const f of failures) lines.push(`failed ${f.resource} ${f.uuid}: ${String(f.message ?? '(no error text)').replace(/\s+/g, ' ').trim().slice(0, 1500)}`);
    const bugs = report?.knownBugs ?? [];
    lines.push(bugs.length
        ? `known product bugs worked around (${bugs.length}, ${keptReportFile(runId, env)}):\n  ${bugs.map((k) => `${k.bug}: ${k.type} ${k.uuid} — ${k.note}`).join('\n  ')}`
        : 'known product bugs worked around: none');
    return lines.join('\n');
}

/**
 * Writes the kept report (removes a stale one when nothing was kept and no known bug was worked around); returns its
 * path when written. Known bugs already recorded for the same run (the setup's, `recordKnownBug`) are kept.
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

/** REG_KEPT_STRICT: a non-empty kept list fails the run (default off: kept objects are warnings, R17). */
export const isKeptStrict = (env: NodeJS.ProcessEnv = process.env): boolean => parseFlag(env.REG_KEPT_STRICT, 'REG_KEPT_STRICT', false);

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

/** Throws unless the run has one real id (R13): not adhoc, and API_RUN_ID equal to REG_RUN_ID when set. */
export function assertRealRunId(env: NodeJS.ProcessEnv = process.env): string {
    const runId = currentRunId(env);
    if (isAdhocRun(runId) || (env.API_RUN_ID !== undefined && (ADHOC_RUN_IDS.includes(env.API_RUN_ID) || env.API_RUN_ID !== runId))) {
        throw new Error(`runTeardown: the run id is an adhoc default (${ADHOC_RUN_IDS.join(' / ')}) or API_RUN_ID differs from REG_RUN_ID; ` +
            'refusing to delete anything. Run through playwright.regression.config.ts / playwright.api.config.ts, or set REG_RUN_ID.');
    }
    return runId;
}

/**
 * The globalTeardown. Whatever the outcome, the run's local-backend proof (`<run id>.local-proof.json`, tier.ts) is
 * removed at the end (B0 fix pass 3, Q4 residual d): a later invocation never inherits it.
 */
export default async function runTeardown(config?: FullConfig, deps: TeardownDeps = {}): Promise<void> {
    try {
        await teardownRun(config, deps);
    } finally {
        removeLocalProof();
    }
}

async function teardownRun(_config: FullConfig | undefined, deps: TeardownDeps): Promise<void> {
    const runId = assertRealRunId();
    assertRunTier();
    const dryRun = isDryRun();
    const strictKept = isKeptStrict();
    if (!process.env.BASE_URL) {
        // Q11: a run without a tier tested nothing; it must never end green and empty.
        const leftovers = leftoverReport();
        throw new Error(['BASE_URL is unset: the run had no tier, so it tested nothing and could not clean up; failing the run ' +
            '(set BASE_URL through REG_ENV_FILE / the config folder\'s .env).', ...(leftovers ? [leftovers] : [])].join('\n\n'));
    }
    const tier = tierIdentity() ?? null;
    const plan = planTeardown(readLedger(), runId, handlerFor, { tier });

    if (dryRun) {
        logger.info(`API_TEARDOWN_DRY_RUN — plan for run ${runId} (nothing is deleted):\n${formatPlan(plan)}`);
        const refused = plan.filter((p) => p.refused);
        if (refused.length) logger.warn(`${refused.length} ledger line(s) refused by the own-object guard`);
        logger.info(runSummary(runId, undefined));
        return;
    }
    if (!mayDeleteOwn()) {
        logger.info(`API_DELETE_OWN off — keeping the run's objects. Ledger: ${ledgerFile()} (run ${runId}), ${plan.length} live object(s)`);
        logger.info(runSummary(runId, undefined));
        const leftovers = leftoverReport();
        if (leftovers) throw new Error(leftovers);
        return;
    }

    logger.info(`deleting ${plan.length} own object(s) of run ${runId}; cleanup ledger ${cleanupLedgerFile()}`);
    const authenticate = deps.authenticate ?? authenticatedApi;
    if (isLocalTier()) {
        // Q4: the authenticated half of the local-backend proof, before anything is deleted on a "local" stack.
        const check = await authenticate();
        try {
            await assertLocalBackend(check.api);
        } finally {
            await check.dispose().catch(() => undefined);
        }
    }
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
        const keptFile = writeKeptReport(runId, result);
        // The run summary lists every known bug of <run id>.kept.json: the teardown's and the setup's (fix pass 4).
        const summary = runSummary(runId, { deleted: result.deleted.length, kept: result.kept.length, failed: result.failed.length }, process.env, readCleanupFailures());
        if (readKeptReport(runId)?.knownBugs.length) logger.warn(summary);
        else logger.info(summary);
        if (keptFile && result.kept.length) {
            logger.warn(`${result.kept.length} object(s) of the run were kept (not deleted): ${keptFile}`);
            if (strictKept) problems.push(`REG_KEPT_STRICT: ${result.kept.length} object(s) of the run were kept, not deleted (${keptFile}): ` +
                result.kept.map((k) => `${k.type} ${k.uuid}`).join(', '));
        }

        if (isLocalTier()) {
            logger.info('TIER_KIND=local: no non-interference snapshot');
        } else {
            const before = loadSnapshot(snapshotBeforeFile(runId));
            if (!before) {
                problems.push('No before snapshot of this run on a shared tier: the non-interference proof (API-GEN-33) is missing ' +
                    '(the snapshot project failed or was skipped, e.g. --no-deps). The run cannot show that it left the tier untouched.');
            } else {
                const after = await snapshotTier(await reauthenticating(newApi), { recheck: before, runId });
                const compared = compareSnapshots(before, after, { ledger: readLedger(), runId, ownDeleted: result.deleted });
                compared.notes.forEach((n) => logger.info(`non-interference note: ${n}`));
                if (compared.violations.length) {
                    logger.error(`non-interference after the deletes:\n  ${compared.violations.join('\n  ')}`);
                    problems.push(`Non-interference violated after the run-end deletes (API-GEN-33 re-check):\n  ${compared.violations.join('\n  ')}`);
                }
            }
        }
    } finally {
        for (const dispose of disposers) await dispose().catch(() => undefined);
    }
    if (warnings.length) logger.warn(`teardown warnings (kept objects are not deleted and not failures):\n  ${warnings.join('\n  ')}`);
    const leftovers = leftoverReport();
    if (leftovers) problems.push(leftovers);
    if (problems.length) throw new Error(problems.join('\n\n'));
}
