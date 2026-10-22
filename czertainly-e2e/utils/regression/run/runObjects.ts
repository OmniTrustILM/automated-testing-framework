/**
 * runObjects — the objects every later spec of a run builds on, made once by the `run-setup` project.
 *
 * WHAT: `RUN_OBJECTS` lists the run's authority, RA profile, ACME profile, role and token chain; `prepareRunObject` makes one
 * of them through the API with the `ensure…` helper that already owns its logic (RA profile on the first healthy CA of
 * REG_CA_CONNECTORS, ACME profile, role, token → profile → key) and answers whether it is ready or why it is not.
 * WHY: until now the first spec that created a role, RA profile, ACME profile or authority became the run's object, so the CA
 * behind every lifecycle row depended on which spec ran first (and on whether it passed). The run objects are now decided
 * before the first spec, by one project, in one order, from reads of the tier.
 * HOW: each helper reads the run state first (a reused REG_RUN_ID finds its objects) and writes it after a create, so the
 * setup is idempotent and a spec run alone (`--no-deps`, a `--grep` that drops the setup) still gets the object lazily from
 * the same helper. A tier that cannot offer an object (no healthy CA, no cryptography connector, no MS ADCS authority) is a
 * named skip, never a failure: Playwright does not start a project whose dependency has a failed test, and one missing CA
 * must not stop every row. The create goes through the guarded `api` and the ledger line is written before anything else.
 */
import { ensureAuthority, adcsBlocker } from '../config/authorities';
import { ensureAcmeProfile } from '../config/acmeProfiles';
import type { GuardedApi } from '../guard/types';
import { readRunState, type RunState } from '../ledger/runState';
import { ensureRunRaProfile, RaProfileSourceMissing } from '../ownRaProfiles';
import { ensureRunRole } from '../ownRoles';
import { ensureKeyChain, isSkip } from '../platform/keyChain';
import { settings } from './settings';
import { isLocalTier } from '../tier/kind';

/** One run object: what the setup row is called, the run-state keys that say it exists, and how it is made. */
export interface RunObject {
    /** The row of the setup test (`testMeta({ row })`). */
    row: string;
    /** The words of the test title and of a skip reason. */
    label: string;
    /** The run-state keys that must be present once the object exists. */
    stateKeys: ReadonlyArray<keyof RunState>;
    /** Makes the object (or finds it in the run state); returns a skip reason when the tier cannot offer it. */
    make(api: GuardedApi, spec: string): Promise<string | undefined>;
}

/**
 * The run objects in the order they are made. The MS ADCS authority is the base of the configuration rows, so it comes first; the
 * RA profile is CA-agnostic (any healthy CA in REG_CA_CONNECTORS order); the ACME profile and the role need no CA; the token
 * chain needs a cryptography connector.
 */
export const RUN_OBJECTS: readonly RunObject[] = [
    {
        row: 'authority',
        label: 'MS ADCS authority',
        stateKeys: ['authority'],
        async make(api, spec) {
            // On a local stack REG_RA_PROFILE_NAME names an existing RA profile whose authority becomes the (issue-only) run authority.
            const issueOnlyParent = isLocalTier() && settings().raProfileName !== undefined;
            if (!issueOnlyParent && !readRunState().authority) {
                const blocker = await adcsBlocker(api);
                if (blocker) return blocker;
            }
            await ensureAuthority(api, spec);
            return undefined;
        },
    },
    {
        row: 'raProfile',
        label: 'RA profile',
        stateKeys: ['raProfile'],
        async make(api, spec) {
            try {
                await ensureRunRaProfile(api, spec);
                return undefined;
            } catch (e) {
                if (e instanceof RaProfileSourceMissing) return e.reason;
                throw e;
            }
        },
    },
    {
        row: 'acmeProfile',
        label: 'ACME profile',
        stateKeys: ['acmeProfile'],
        async make(api, spec) {
            await ensureAcmeProfile(api, spec);
            return undefined;
        },
    },
    {
        row: 'role',
        label: 'role',
        stateKeys: ['role'],
        async make(api, spec) {
            await ensureRunRole(api, spec);
            return undefined;
        },
    },
    {
        row: 'tokenChain',
        label: 'token chain',
        stateKeys: ['token', 'tokenProfile', 'key'],
        async make(api, spec) {
            const chain = await ensureKeyChain(api, spec);
            return isSkip(chain) ? chain.skip : undefined;
        },
    },
];

/** The longest part of an unexpected error that goes into a skip reason (reports may be shared). */
const SHOWN_ERROR = 200;

/** The time limit of one setup test (the run-setup file sets it for every row). */
export const RUN_SETUP_TEST_TIMEOUT_MS = 150_000;

/**
 * How long one object may take before the setup gives up on it. Clearly below the limit of the setup test: a test that runs past
 * its limit is "not ok", and Playwright would not start the `regression` project. A connector that does not answer its health read
 * (about 30 s each, several in a row) is the usual cause.
 */
export const RUN_OBJECT_DEADLINE_MS = 100_000;

/**
 * How long an abandoned attempt may still settle after the deadline, before the test ends and the API context is disposed. Deadline
 * plus grace stays well below the limit of the setup test.
 */
export const RUN_OBJECT_GRACE_MS = 10_000;

const describeDuration = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

/**
 * Makes one run object and answers `undefined` when it is ready, else the named reason the setup skips with. Never throws and never
 * outlasts `deadlineMs` plus `graceMs`: a refusal the tier explains (no CA, no connector) keeps its own reason; an error is reported
 * as "could not be made" with the start of the error; an overrun as "gave up". Either way the specs that need the object make it
 * themselves. An attempt that is still running at the deadline cannot be cancelled. It gets `graceMs` more to settle, so a create
 * that is already in flight can still write its ledger line (written right after the answer) before the caller disposes the API
 * context. That is a bounded chance, not a guarantee: a create that answers after the grace may land on the tier with no ledger line
 * (the non-interference snapshot reports such an object). The late outcome is always dropped and never changes the answer.
 */
export async function prepareRunObject(
    object: RunObject,
    api: GuardedApi,
    spec: string,
    deadlineMs: number = RUN_OBJECT_DEADLINE_MS,
    graceMs: number = RUN_OBJECT_GRACE_MS,
): Promise<string | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const overrun = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`run setup gave up on the run ${object.label} after ${describeDuration(deadlineMs)} (a connector or the platform did not answer); the specs that need it make it themselves`), deadlineMs);
    });
    const attempt = Promise.resolve().then(() => object.make(api, spec)).catch((e: unknown): string => {
        const message = e instanceof Error ? e.message : String(e);
        return `run setup could not make the run ${object.label} (${message.slice(0, SHOWN_ERROR)}); the specs that need it make it themselves`;
    });
    try {
        const first = await Promise.race([attempt, overrun.then((reason) => ({ reason }))]);
        if (typeof first !== 'object' || first === null) return first;
        let graceTimer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([attempt, new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, graceMs); })]);
        } finally {
            clearTimeout(graceTimer);
        }
        return first.reason;
    } finally {
        clearTimeout(timer);
    }
}
