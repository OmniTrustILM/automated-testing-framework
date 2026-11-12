/**
 * compare — judges two snapshots: did the run change anything it did not create?
 *
 * WHAT: `compareSnapshots(before, after, options)` returns the violations (a finding for a human) and the notes. It checks
 * that every stored foreign object is unchanged, that the net change of every total is explained by the ledger (own objects
 * created and deleted since the before snapshot, other tools' lines inside the window), that platform event associations and
 * system jobs are identical, that required resources were readable and that both snapshots come from the same tier.
 *
 * WHY: this is the proof that the run touched nothing foreign on a shared tier; a wrong sign in the accounting would be a
 * silent false "clean".
 *
 * HOW: pure; the rules are listed in the header of nonInterference.ts and pinned by tests/unit/nonInterference*.spec.ts.
 * `REG_NET_TOLERANCE` (default 0) widens the accepted unexplained change of a total.
 */
import { foreignWindowLines, LedgerWindowOptions, ownUuidsOf } from './foreignLedger';
import { SNAPSHOT_RESOURCES } from '../resourceTypes';
import { settings } from '../run/settings';
import { AccountingCounts, ItemMark, REQUIRED_RESOURCES, ResourceSnapshot, TierSnapshot } from './snapshotModel';

/** REG_NET_TOLERANCE: allowed unexplained change of a total (default 0; raise it only on a busy tier, and say so). */
export function allowedNetChange(env: NodeJS.ProcessEnv = process.env): number {
    const raw = settings(env).netTolerance;
    if (raw === undefined || raw.trim() === '') return 0;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`REG_NET_TOLERANCE="${raw}" is not a non-negative integer`);
    return n;
}

export interface CompareOptions extends LedgerWindowOptions {
    /** Allowed unexplained change of a total (default: REG_NET_TOLERANCE, else 0). */
    tolerance?: number;
    /** `<type>:<uuid>` of other tools' creates in a large collection confirmed by a detail read (`confirmForeignCreates`). */
    confirmedCreated?: readonly string[];
}

export interface CompareResult {
    violations: string[];
    /** Resources that could not be compared, the accounting tolerance, and own deletions that explain a missing object. */
    notes: string[];
}

// ------------------------------------------------------------------ own accounting: what this run's ledger lines explain

/** The run's own ledger lines since the before snapshot, counted per resource type. */
interface OwnAccounting {
    /** Uuids this run created / uuids it deleted (ledger `deleted` lines and the objects the teardown deleted). */
    created: ReadonlySet<string>;
    gone: ReadonlySet<string>;
    createdSince(type: string): number;
    deletedSince(type: string): number;
    /** The same counts without the derived objects (an object the platform made on its own, e.g. a `certKey_` key). */
    createdOwn(type: string): number;
    deletedOwn(type: string): number;
}

type CountedLine = { type: string; uuid: string; derived?: boolean };

function ownAccounting(since: number, runId: string, opts: CompareOptions): OwnAccounting {
    const own = (opts.ledger ?? []).filter((l) => l.runId === runId);
    const recent = own.filter((l) => Date.parse(l.at) >= since);
    const countBy = (lines: CountedLine[], pick: (l: { derived?: boolean }) => boolean = () => true) => {
        const m = new Map<string, Set<string>>();
        for (const l of lines) if (pick(l)) m.set(l.type, (m.get(l.type) ?? new Set()).add(l.uuid));
        return (type: string) => m.get(type)?.size ?? 0;
    };
    const createdLines = recent.filter((l) => l.event === 'created');
    // A `deleted` line (the teardown's, or a spec's) carries no `derived`: the flag comes from the object's `created` line.
    const derivedOf = (uuid: string): boolean | undefined => own.find((l) => l.event === 'created' && l.uuid === uuid)?.derived;
    const deletedLines = [...recent.filter((l) => l.event === 'deleted'), ...(opts.ownDeleted ?? [])].map((d) => ({ type: d.type, uuid: d.uuid, derived: derivedOf(d.uuid) }));
    const notDerived = (l: { derived?: boolean }) => !l.derived;
    return {
        created: new Set(own.filter((l) => l.event === 'created').map((l) => l.uuid)),
        gone: new Set([...own.filter((l) => l.event === 'deleted').map((l) => l.uuid), ...(opts.ownDeleted ?? []).map((d) => d.uuid)]),
        createdSince: countBy(createdLines),
        deletedSince: countBy(deletedLines),
        createdOwn: countBy(createdLines, notDerived),
        deletedOwn: countBy(deletedLines, notDerived),
    };
}

// ------------------------------------------------------------------ foreign accounting: what other tools' lines explain

type ByTypeAndUuid = Map<string, Map<string, string>>;

/** Other QA tools' lines inside [before.takenAt, after.takenAt], keyed by resource type and uuid, and what they explain. */
interface ForeignAccounting {
    deleted: ByTypeAndUuid;
    created: ByTypeAndUuid;
    /** The family of a line, marked when the line carries no tier identity. */
    familyOf(by: ByTypeAndUuid, type: string, uuid: string): string;
    /** Stored foreign objects of `type` that are gone and whose deletion another tool recorded inside the window. */
    gone(type: string): string[];
    /** Objects another tool created inside the window, proven new (see `foreignAccounting`). */
    fresh(type: string): string[];
    /** Notes collected while comparing: a stored object deleted by another tool, a total changed by another tool. */
    explained: string[];
    explainedTotals: string[];
}

/**
 * `fresh(type)`: no deletion line of their own inside the window, and
 * - a collection read whole: not stored before, stored after;
 * - a large collection with a creation time on the detail: confirmed by `confirmForeignCreates`;
 * - any other large collection: in the after newest sample, absent from the before newest sample.
 */
function foreignAccounting(before: TierSnapshot, after: TierSnapshot, runId: string, opts: CompareOptions): ForeignAccounting {
    const lines = foreignWindowLines(opts.ledger ?? [], runId, Date.parse(before.takenAt), Date.parse(after.takenAt), before.tier, ownUuidsOf(opts.ledger ?? [], runId, opts.ownDeleted));
    const tierless = new Set(lines.filter((f) => f.tierless).map((f) => `${f.type}:${f.uuid}`));
    const by = (event: 'created' | 'deleted'): ByTypeAndUuid => {
        const m: ByTypeAndUuid = new Map();
        for (const f of lines) if (f.event === event) m.set(f.type, (m.get(f.type) ?? new Map()).set(f.uuid, f.family));
        return m;
    };
    const deleted = by('deleted');
    const created = by('created');
    const confirmed = new Set(opts.confirmedCreated ?? []);
    const readable = (type: string): [ResourceSnapshot, ResourceSnapshot] | undefined => {
        const b = before.resources[type];
        const a = after.resources[type];
        return !b || b.error || !a || a.error ? undefined : [b, a];
    };
    return {
        deleted,
        created,
        familyOf: (m, type, uuid) => `${m.get(type)!.get(uuid)}${tierless.has(`${type}:${uuid}`) ? ', a line without tier identity' : ''}`,
        gone(type) {
            const pair = readable(type);
            if (!pair) return [];
            const [b, a] = pair;
            return [...(deleted.get(type)?.keys() ?? [])].filter((u) => b.foreign[u] && !a.foreign[u]);
        },
        fresh(type) {
            const pair = readable(type);
            if (!pair) return [];
            const [b, a] = pair;
            const def = SNAPSHOT_RESOURCES.find((d) => d.type === type);
            const proven = (u: string): boolean => {
                if (!def?.large) return !b.foreign[u] && !!a.foreign[u];
                if (def.detailCreated) return confirmed.has(`${type}:${u}`);
                // An empty before sample of a non-empty collection is a failed read, not evidence: it fails closed.
                const beforeSampled = !!b.newestUuids && (b.newestUuids.length > 0 || b.total === 0);
                return beforeSampled && !!a.newestUuids && a.newestUuids.includes(u) && !b.newestUuids!.includes(u);
            };
            return [...(created.get(type)?.keys() ?? [])].filter((u) => !deleted.get(type)?.has(u) && proven(u));
        },
        explained: [],
        explainedTotals: [],
    };
}

// ------------------------------------------------------------------ per-resource comparison

/** What one comparison needs besides the two snapshots. */
interface CompareContext {
    own: OwnAccounting;
    foreign: ForeignAccounting;
    tolerance: number;
}

interface Findings {
    violations: string[];
    notes: string[];
}

/** Every stored foreign object is still there with the same name, description and marker. */
function compareStoredObjects(type: string, b: ResourceSnapshot, a: ResourceSnapshot, ctx: CompareContext, out: Findings): void {
    const { own, foreign } = ctx;
    for (const [uuid, mark] of Object.entries(b.foreign)) {
        const now: ItemMark | undefined = a.foreign[uuid];
        if (!now) {
            if (own.created.has(uuid) && own.gone.has(uuid)) out.notes.push(`${type}: ${uuid} is a ledger object of this run, deleted by it`);
            else if (foreign.deleted.get(type)?.has(uuid.toLowerCase())) foreign.explained.push(`${type} ${uuid} deleted (${foreign.familyOf(foreign.deleted, type, uuid.toLowerCase())})`);
            else out.violations.push(`${type}: pre-existing ${uuid} is gone`);
            continue;
        }
        if (mark.name !== now.name || (mark.wrapper !== undefined && now.wrapper !== undefined && mark.wrapper !== now.wrapper)) {
            out.violations.push(`${type}: pre-existing ${uuid} was renamed (name withheld)`);
        }
        if (mark.description !== undefined && now.description !== undefined && mark.description !== now.description) {
            out.violations.push(`${type}: pre-existing ${uuid} changed its description (text withheld)`);
        }
        if (mark.marker !== undefined && now.marker !== undefined && mark.marker !== now.marker) {
            out.violations.push(`${type}: pre-existing ${uuid} changed ${mark.marker} -> ${now.marker}`);
        }
    }
}

/** The counts a resource's accounting rule reads (see `AccountingCounts`). */
function countsOf(type: string, ctx: CompareContext, foreignNew: number, foreignGone: number): AccountingCounts {
    const { own, foreign } = ctx;
    return {
        created: own.createdSince(type),
        deleted: own.deletedSince(type),
        createdOwn: own.createdOwn(type),
        deletedOwn: own.deletedOwn(type),
        foreignNew,
        foreignGone,
        of: (other) => ({ created: own.createdSince(other), foreignNew: foreign.fresh(other).length }),
    };
}

/**
 * Net accounting: `after.total - before.total` must lie in the range the ledger explains (own objects created and deleted
 * since the before snapshot, other tools' objects proven new or gone), within the tolerance. A resource with a `delta` hook
 * (keys count key items: an own key brings one or two, an own certificate up to one `certKey_<CN>` item; a derived key line is
 * one such item) states its own range; every other resource explains exactly created - deleted.
 */
function compareTotal(type: string, b: ResourceSnapshot, a: ResourceSnapshot, ctx: CompareContext, out: Findings): void {
    const { foreign, tolerance } = ctx;
    const created = foreign.fresh(type);
    const foreignNew = created.length;
    const foreignGone = foreign.gone(type).length;
    if (foreignNew) foreign.explainedTotals.push(`${type} +${foreignNew} created (${[...new Set(created.map((u) => foreign.familyOf(foreign.created, type, u)))].sort().join(', ')})`);
    const counts = countsOf(type, ctx, foreignNew, foreignGone);
    const hook = SNAPSHOT_RESOURCES.find((d) => d.type === type)?.delta;
    const [lo, hi] = hook ? hook(counts) : [counts.created - counts.deleted + foreignNew - foreignGone, counts.created - counts.deleted + foreignNew - foreignGone];
    const delta = a.total - b.total;
    if (delta < lo - tolerance || delta > hi + tolerance) {
        const expected = lo === hi ? `${lo >= 0 ? '+' : ''}${lo}` : `${lo}..+${hi}`;
        out.violations.push(`${type}: total ${b.total} -> ${a.total} (${delta >= 0 ? '+' : ''}${delta}), the ledger explains ${expected}` +
            (tolerance ? ` ±${tolerance}` : ''));
    }
}

function compareResource(type: string, b: ResourceSnapshot, a: ResourceSnapshot | undefined, ctx: CompareContext, out: Findings): void {
    if (b.error) {
        if (REQUIRED_RESOURCES.includes(type)) out.violations.push(`${type}: required resource unreadable before the run, the proof is incomplete (${b.error})`);
        else out.notes.push(`${type}: not compared (before snapshot unreadable: ${b.error})`);
        return;
    }
    if (!a || a.error) {
        out.violations.push(`${type}: readable before the run, unreadable after (${a?.error ?? 'missing'})`);
        return;
    }
    out.notes.push(...(b.notes ?? []).map((n) => `before: ${n}`), ...(a.notes ?? []).map((n) => `after: ${n}`));
    compareStoredObjects(type, b, a, ctx, out);
    compareTotal(type, b, a, ctx, out);
}

// ------------------------------------------------------------------ platform comparison

/** Platform event associations and system jobs are identical (or were unreadable before, which is a note). */
function comparePlatform(before: TierSnapshot, after: TierSnapshot, out: Findings): void {
    if (before.platformEvents !== undefined) {
        if (before.platformEvents.startsWith('error:')) out.notes.push(`platform events: not compared (${before.platformEvents})`);
        else if (after.platformEvents !== before.platformEvents) out.violations.push('platform event associations changed');
    }
    if (before.systemJobs !== undefined) {
        if (before.systemJobs.startsWith('error:')) out.notes.push(`system jobs: not compared (${before.systemJobs})`);
        else if (after.systemJobs !== before.systemJobs) out.violations.push('system jobs changed (uuid, name, type, cron, enabled, one-time)');
    }
}

/**
 * The comparison in four phases: the run's own accounting, other tools' accounting, one comparison per resource of the
 * before snapshot (stored objects, then the total), and the platform-level state.
 */
export function compareSnapshots(before: TierSnapshot, after: TierSnapshot, opts: CompareOptions = {}): CompareResult {
    const runId = opts.runId ?? before.runId;
    const tolerance = opts.tolerance ?? allowedNetChange();
    const ctx: CompareContext = {
        own: ownAccounting(Date.parse(before.takenAt), runId, opts),
        foreign: foreignAccounting(before, after, runId, opts),
        tolerance,
    };
    const out: Findings = { violations: [], notes: [] };
    if (before.tier && after.tier && before.tier !== after.tier) out.violations.push('the snapshots were taken on different tiers (tier identity differs)');
    if (tolerance > 0) out.notes.push(`net accounting tolerance: ±${tolerance} per resource (REG_NET_TOLERANCE)`);
    for (const [type, b] of Object.entries(before.resources)) compareResource(type, b, after.resources[type], ctx, out);
    const { explained, explainedTotals } = ctx.foreign;
    if (explained.length || explainedTotals.length) {
        out.notes.push(`explained by other QA tools' ledger lines inside the run window: ${[...explained, ...explainedTotals].join('; ')}`);
    }
    comparePlatform(before, after, out);
    return out;
}
