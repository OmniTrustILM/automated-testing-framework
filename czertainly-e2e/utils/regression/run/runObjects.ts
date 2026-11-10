/**
 * runObjects — the objects every later spec of a run builds on (authority, RA profile, ACME profile, role, token chain), made once by the
 * `run-setup` project.
 * A tier that cannot offer an object is a named skip, never a failure: Playwright does not start a project whose dependency failed.
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

export interface RunObject {
    row: string;
    label: string;
    stateKeys: ReadonlyArray<keyof RunState>;
    make(api: GuardedApi, spec: string): Promise<string | undefined>;
}

/** The run objects in the order they are made: the MS ADCS authority first (base of the configuration rows), the RA profile is CA-agnostic. */
export const RUN_OBJECTS: readonly RunObject[] = [
    {
        row: 'authority',
        label: 'MS ADCS authority',
        stateKeys: ['authority'],
        async make(api, spec) {
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

const SHOWN_ERROR = 200;

export const RUN_SETUP_TEST_TIMEOUT_MS = 150_000;

/**
 * How long one object may take before the setup gives up; clearly below
 * the setup test's limit (a slow connector health read is the usual cause).
 */
export const RUN_OBJECT_DEADLINE_MS = 100_000;

/** How long an abandoned attempt may still settle after the deadline, before the API context is disposed. */
export const RUN_OBJECT_GRACE_MS = 10_000;

const describeDuration = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

/**
 * Makes one run object and answers `undefined` when ready, else the named reason the setup skips with. Never throws and never
 * outlasts `deadlineMs` plus `graceMs`; an attempt running at the deadline cannot be cancelled, so a late create may land without a ledger
 * line (the snapshot reports it).
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
