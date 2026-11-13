/** foreignLedger — what other QA tools' ledger lines explain inside a run window; fail-closed (see nonInterference.ts). */
import { LedgerLine, runIdPrefix } from '../ledger/ledger';
import { call, SnapshotReader } from './snapshot';
import { SNAPSHOT_RESOURCES } from '../resourceTypes';
import type { TierSnapshot } from './snapshotModel';

export interface LedgerWindowOptions {
    ledger?: LedgerLine[];
    runId?: string;
    ownDeleted?: Array<{ type: string; uuid: string }>;
}

/** Ledger types other QA tools write that name a snapshot resource under another spelling; every other type explains nothing. */
const FOREIGN_TYPE_ALIASES: Readonly<Record<string, string>> = {
    certificate: 'certificates', key: 'keys', cryptographicKeys: 'keys', raProfile: 'raProfiles', authority: 'authorities',
    role: 'roles', discovery: 'discoveries', customAttribute: 'customAttributes', trigger: 'triggers', workflowTriggers: 'triggers',
    rule: 'rules', condition: 'conditions', action: 'actions', workflowActions: 'actions', execution: 'executions',
    workflowExecutions: 'executions', approvalProfile: 'approvalProfiles', scheduledJob: 'scheduledJobs',
};

export function foreignResourceType(type: unknown): string | undefined {
    if (typeof type !== 'string') return undefined;
    if (SNAPSHOT_RESOURCES.some((d) => d.type === type)) return type;
    return Object.hasOwn(FOREIGN_TYPE_ALIASES, type) ? FOREIGN_TYPE_ALIASES[type] : undefined;
}

const FOREIGN_DELETION_NOTE = /^DELETED\b/;
const REMOVAL_WORDS = /delet|remov/i;

/** What a line of another run records: `created`, `deleted`, or undefined (explains nothing). An event-less line is read by its note. */
export function foreignEventOf(line: Pick<LedgerLine, 'event' | 'note' | 'eventImplied'>): 'created' | 'deleted' | undefined {
    if (!line.eventImplied) return line.event === 'created' || line.event === 'deleted' ? line.event : undefined;
    const note = typeof line.note === 'string' ? line.note : '';
    if (FOREIGN_DELETION_NOTE.test(note)) return 'deleted';
    if (REMOVAL_WORDS.test(note)) return undefined;
    return 'created';
}

export interface ForeignLine {
    type: string;
    uuid: string;
    event: 'created' | 'deleted';
    family: string;
    tierless?: boolean;
}

/**
 * The lines of other runs inside the window [since, until] (epoch ms) that
 * can explain something; `ownUuids` are never explained by another tool.
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
        const tierless = !!tier && !l.tier;
        if (tierless && !l.eventImplied) continue;
        const type = foreignResourceType(l.type);
        const event = foreignEventOf(l);
        if (!type || !event) continue;
        out.push({ type, uuid: l.uuid.toLowerCase(), event, family: runIdPrefix(l), ...(tierless ? { tierless: true } : {}) });
    }
    return out;
}

export function ownUuidsOf(ledger: readonly LedgerLine[], runId: string, ownDeleted: ReadonlyArray<{ uuid: string }> = []): Set<string> {
    return new Set([...ledger.filter((l) => l.runId === runId).map((l) => l.uuid), ...ownDeleted.map((d) => d.uuid)].filter((u) => typeof u === 'string').map((u) => u.toLowerCase()));
}

/**
 * Objects other tools created in a large collection, confirmed by a detail read that answers 200 with a creation time at or after the
 * before snapshot; returned as `<type>:<uuid>`.
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
            // confirms nothing
        }
    }
    return out;
}
