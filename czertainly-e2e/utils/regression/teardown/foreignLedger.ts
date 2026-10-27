/**
 * foreignLedger — what other QA tools' ledger lines explain inside a run window.
 *
 * WHAT: reads the SHARED ledger for lines of other run ids whose `at` lies inside [before.takenAt, after.takenAt]
 * (`foreignWindowLines`), says which of them record a creation or a deletion (`foreignEventOf`, `foreignResourceType`), and
 * confirms by a detail read which new objects of a large collection really are new (`confirmForeignCreates`).
 *
 * WHY: a manual-test session sharing the tier may create or delete its own objects while a run is in flight; the
 * comparison must tell that apart from a change the run made, and must never explain more than it can prove.
 *
 * HOW: fail-closed; the rules are listed in the header of nonInterference.ts. Pure except `confirmForeignCreates`, which
 * reads one detail URL per candidate.
 */
import { LedgerLine, runIdPrefix } from '../ledger/ledger';
import { call, SnapshotReader } from './snapshot';
import { SNAPSHOT_RESOURCES } from '../resourceTypes';
import type { TierSnapshot } from './snapshotModel';

/** The ledger and run the window lines are taken from. */
export interface LedgerWindowOptions {
    /** The ledger; own lines of `runId` written at or after before.takenAt explain total changes. */
    ledger?: LedgerLine[];
    runId?: string;
    /** Objects the run-end teardown deleted (counted like ledger `deleted` lines). */
    ownDeleted?: Array<{ type: string; uuid: string }>;
}

// ------------------------------------------------------------------ other QA tools (shared ledger)

/**
 * The ledger types other QA tools write (shared ledger, read 2026-10-16: qa-man, qa-cand, …) that name a snapshot
 * resource under another spelling. A snapshot resource type names itself; every other type explains nothing.
 */
const FOREIGN_TYPE_ALIASES: Readonly<Record<string, string>> = {
    certificate: 'certificates', key: 'keys', cryptographicKeys: 'keys', raProfile: 'raProfiles', authority: 'authorities',
    role: 'roles', discovery: 'discoveries', customAttribute: 'customAttributes', trigger: 'triggers', workflowTriggers: 'triggers',
    rule: 'rules', condition: 'conditions', action: 'actions', workflowActions: 'actions', execution: 'executions',
    workflowExecutions: 'executions', approvalProfile: 'approvalProfiles', scheduledJob: 'scheduledJobs',
};

/** The snapshot resource a ledger type of another tool names, or undefined. */
export function foreignResourceType(type: unknown): string | undefined {
    if (typeof type !== 'string') return undefined;
    if (SNAPSHOT_RESOURCES.some((d) => d.type === type)) return type;
    return Object.hasOwn(FOREIGN_TYPE_ALIASES, type) ? FOREIGN_TYPE_ALIASES[type] : undefined;
}

/** An event-less line of an older tool records a deletion when its note STARTS with this (`DELETED (own)`, `DELETED → …`). */
const FOREIGN_DELETION_NOTE = /^DELETED\b/;
/** Any other mention of a removal in an event-less note leaves the line ambiguous ("uploaded; will be bulk-deleted"). */
const REMOVAL_WORDS = /delet|remov/i;

/**
 * What a line of ANOTHER run records: `created`, `deleted`, or undefined (explains nothing). A line with an explicit
 * event is read by it; an event-less line (`eventImplied`) by its note: `DELETED…` at the start is a deletion, a note
 * mentioning a deletion or removal anywhere else is ambiguous, any other note (or none) a creation.
 */
export function foreignEventOf(line: Pick<LedgerLine, 'event' | 'note' | 'eventImplied'>): 'created' | 'deleted' | undefined {
    if (!line.eventImplied) return line.event === 'created' || line.event === 'deleted' ? line.event : undefined;
    const note = typeof line.note === 'string' ? line.note : '';
    if (FOREIGN_DELETION_NOTE.test(note)) return 'deleted';
    if (REMOVAL_WORDS.test(note)) return undefined;
    return 'created';
}

export interface ForeignLine {
    /** The snapshot resource type. */
    type: string;
    uuid: string;
    event: 'created' | 'deleted';
    /** The QA tool family of the line's run id (`qa-man`, …; never the run id itself). */
    family: string;
    /** The line carries no tier identity while the snapshots do (accepted only in the older event-less shape). */
    tierless?: boolean;
}

/**
 * The lines of other runs inside the run window [since, until] (epoch ms) that can explain something, or none when the
 * window itself is not known. `ownUuids`: the uuids of this run's own lines (never explained by another tool).
 */
export function foreignWindowLines(ledger: readonly LedgerLine[], runId: string, since: number, until: number, tier?: string, ownUuids: ReadonlySet<string> = new Set()): ForeignLine[] {
    if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) return [];
    const own = new Set([...ownUuids].map((u) => u.toLowerCase()));
    const out: ForeignLine[] = [];
    for (const l of ledger) {
        if (typeof l.runId !== 'string' || !l.runId || l.runId === runId) continue;
        if (typeof l.uuid !== 'string' || own.has(l.uuid.toLowerCase())) continue;
        const at = typeof l.at === 'string' ? Date.parse(l.at) : NaN;
        if (!Number.isFinite(at) || at < since || at > until) continue;
        if (tier && l.tier && l.tier !== tier) continue;
        // A line without a tier on a tier with a known identity: only the older event-less shape of the other QA tools.
        const tierless = !!tier && !l.tier;
        if (tierless && !l.eventImplied) continue;
        const type = foreignResourceType(l.type);
        const event = foreignEventOf(l);
        if (!type || !event) continue;
        out.push({ type, uuid: l.uuid.toLowerCase(), event, family: runIdPrefix(l), ...(tierless ? { tierless: true } : {}) });
    }
    return out;
}

/** The uuids of this run (its ledger lines and the objects its teardown deleted), lower-cased. */
export function ownUuidsOf(ledger: readonly LedgerLine[], runId: string, ownDeleted: ReadonlyArray<{ uuid: string }> = []): Set<string> {
    return new Set([...ledger.filter((l) => l.runId === runId).map((l) => l.uuid), ...ownDeleted.map((d) => d.uuid)].filter((u) => typeof u === 'string').map((u) => u.toLowerCase()));
}

/**
 * Objects other QA tools created inside the window in a LARGE collection whose detail carries a creation time (keys):
 * each is read by its detail URL, and the ones that answer 200 with a creation time at or after before.takenAt are
 * returned as `<type>:<uuid>` for `CompareOptions.confirmedCreated`. Anything else (404, an error, no or an older
 * creation time) confirms nothing; existing alone is no proof that an object is new.
 */
export async function confirmForeignCreates(api: SnapshotReader, before: TierSnapshot, after: TierSnapshot, opts: LedgerWindowOptions = {}): Promise<string[]> {
    const runId = opts.runId ?? before.runId;
    const ledger = opts.ledger ?? [];
    const lines = foreignWindowLines(ledger, runId, Date.parse(before.takenAt), Date.parse(after.takenAt), before.tier, ownUuidsOf(ledger, runId, opts.ownDeleted));
    const deleted = new Set(lines.filter((f) => f.event === 'deleted').map((f) => `${f.type}:${f.uuid}`));
    const out: string[] = [];
    for (const f of lines) {
        const def = SNAPSHOT_RESOURCES.find((d) => d.type === f.type);
        const key = `${f.type}:${f.uuid}`;
        if (f.event !== 'created' || !def?.large || !def.detail || !def.detailCreated || deleted.has(key) || out.includes(key)) continue;
        const b = before.resources[f.type];
        const a = after.resources[f.type];
        if (!b || b.error || !a || a.error || b.foreign[f.uuid]) continue;
        try {
            const r = await call(api, 'GET', def.detail(f.uuid));
            const created = r.status === 200 ? Date.parse(String(def.detailCreated(r.body ?? {}) ?? '')) : NaN;
            if (Number.isFinite(created) && created >= Date.parse(before.takenAt)) out.push(key);
        } catch {
            // unreadable: confirms nothing
        }
    }
    return out;
}
