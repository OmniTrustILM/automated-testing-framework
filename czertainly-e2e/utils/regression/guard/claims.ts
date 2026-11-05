/**
 * claims — the objects one request names, and the proof that each is the run's own: a probe uuid, or a ledger `created`
 * line of this run of exactly the type the route acts on plus a live read.
 */
import { assertOwn, assertOwnLive, isIdNamed } from '../ledger/ownership';
import { approvalLiveProblem } from './approvals';
import { isCanonicalUuid } from './uuids';
import { PathTarget } from './targets';
import { listBodyRoute } from './routes';
import type { GuardState } from './guardState';
import type { Refuse } from './refuse';

export interface Claim {
    type?: string;
    why?: string;
    /** Named in text the server does not read as JSON: only a live-checked ledger type may back it, an id-named line is refused. */
    free?: boolean;
}

export class Claims {
    private readonly claimed: Map<string, Claim>;

    constructor(
        private readonly state: GuardState,
        private readonly refuse: Refuse,
        associations: Iterable<string> = [],
        free = false,
    ) {
        this.claimed = new Map([...associations].map((u): [string, Claim] => [u, free ? { free } : {}]));
    }

    add(uuid: string, type: string | undefined, why: string): void {
        const prior = this.claimed.get(uuid);
        if (prior?.type !== undefined && type !== undefined && prior.type !== type) this.refuse('one uuid named as two different resources in one request', 'request', { uuid });
        this.claimed.set(uuid, type !== undefined ? { ...prior, type, why } : (prior ?? {}));
    }

    targets(targets: PathTarget[], what: string): void {
        for (const t of targets) {
            if (t.type === undefined && !this.state.probes.has(t.uuid)) {
                this.refuse(`${what} on a resource the suite has no ledger type for (guard/routes.ts TARGET_TYPES / BULK_ROUTES): ownership cannot be ` +
                    'matched to the resource the request acts on', 'request', { uuid: t.uuid });
            }
            this.add(t.uuid, t.type, `the request acts on ${t.type}`);
        }
    }

    fields(typed: Array<[string, string | null, string]>): void {
        for (const [uuid, type, field] of typed) {
            if (this.state.probes.has(uuid)) continue;
            if (type === null) {
                this.refuse(`the body field ${field} names a resource the suite has no ledger type for (guard/routes.ts BODY_FIELD_TYPES): probes only`, 'request', { uuid });
            }
            this.add(uuid, type as string, `the body field ${field} names ${type}`);
        }
    }

    /**
     * A top-level uuid list is typed by LIST_BODY_TYPES (own with that type,
     * or a probe); on any other such route a non-probe uuid is refused.
     */
    list(method: string, apiPath: string, list: unknown[]): void {
        const route = listBodyRoute(method, apiPath);
        // A nested list, object, number or null would escape the type check, so it is refused.
        if (route && list.some((e) => typeof e !== 'string')) {
            this.refuse(`the list body of ${route.path} holds an element that is not a string (its body is ${route.dto.split(' ')[0]})`, 'request');
        }
        const named = [...new Set(list.filter(isCanonicalUuid).map((u) => (u as string).toLowerCase()))].filter((u) => !this.state.probes.has(u));
        if (!named.length) return;
        if (!route) {
            this.refuse('a top-level uuid list body on a route without a typed list (guard/routes.ts LIST_BODY_TYPES): the guard cannot tell which ' +
                'resource it names', 'request', { uuid: named[0] });
        }
        if (route!.type === null) {
            this.refuse(`the list body of ${route!.path} names a resource the suite has no ledger type for (guard/routes.ts LIST_BODY_TYPES): probes only`, 'request', { uuid: named[0] });
        }
        for (const uuid of named) this.add(uuid, route!.type as string, `the list body of ${route!.path} names ${route!.type}`);
    }

    entries(): Array<[string, Claim]> {
        return [...this.claimed];
    }
}

/** Every named uuid must be own or a probe; a target and a typed body field need a ledger line of exactly the resource type. */
export async function assertOwnAll(state: GuardState, claims: Claims, helper: string, refuse: Refuse): Promise<void> {
    const live = state.liveOptions();
    const { tier: _tier, ...ledgerOpts } = live;
    for (const [uuid, claim] of claims.entries()) {
        if (state.probes.has(uuid)) continue;
        const line = assertOwn({ uuid }, helper, ledgerOpts);
        if (line.derived) {
            refuse('a derived object (made by the platform for the run) is removed only by the run-end teardown, after its creation-time and adoption checks', 'derived', { uuid });
        }
        if (claim.type !== undefined && line.type !== claim.type) {
            refuse(`the ledger records it as ${line.type}, but ${claim.why} (an ownership claim counts only for the ` +
                'resource the request acts on)', 'ownership', { uuid });
        }
        if (claim.free && isIdNamed(line.type)) {
            refuse(`named in a body the server does not read as JSON, backed by an id-named ledger line (${line.type}: no live check, ` +
                'so the resource it names cannot be proven)', 'ownership', { uuid });
        }
        await assertOwnLive(state.api, line.type, { uuid }, helper, live);
    }
}

/** The approval's line names an own certificate and an own approval profile (read live), and its live detail names exactly those two. */
export async function assertOwnApprovalDecision(state: GuardState, uuid: string, helper: string, refuse: Refuse): Promise<void> {
    const live = state.liveOptions();
    const { tier: _tier, ...ledgerOpts } = live;
    const line = assertOwn({ uuid }, helper, ledgerOpts);
    const single = (key: string): string | undefined => {
        const v = line.parents?.[key];
        return typeof v === 'string' ? v : undefined;
    };
    const parents: Array<[string | undefined, string]> = [[single('certificate'), 'certificates'], [single('approvalProfile'), 'approvalProfiles']];
    for (const [p, type] of parents) {
        if (!p) refuse(`the approvals line names no own ${type === 'certificates' ? 'certificate' : 'approval profile'} (parents certificate, approvalProfile)`, 'ownership', { uuid });
        const pl = assertOwn({ uuid: p! }, helper, ledgerOpts);
        if (pl.type !== type || pl.derived) refuse(`the approval's ${type} parent is not an own ${type} line of this run`, 'ownership', { uuid: p });
        await assertOwnLive(state.api, type, { uuid: p! }, helper, live);
    }
    const res = await state.api.get(`/api/v1/approvals/${uuid}`, { failOnStatusCode: false });
    if (!res.ok()) refuse(`the approval's live detail answered ${res.status()}: its certificate and approval profile cannot be proven`, 'ownership', { uuid });
    let detail: unknown;
    try {
        detail = await res.json();
    } catch {
        detail = undefined;
    }
    const why = approvalLiveProblem(detail, parents[0][0]!.toLowerCase(), parents[1][0]!.toLowerCase());
    if (why) refuse(why, 'ownership', { uuid });
}
