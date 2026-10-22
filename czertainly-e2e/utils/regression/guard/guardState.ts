/**
 * GuardState — what one guarded context knows between its requests.
 *
 * WHAT: the wrapped context, the environment the guard judges against, whether the context was made for a local stack,
 * the probe uuids it handed out, the run id, the options of every live ownership check and the caller's own user uuid.
 * WHY: the steps of the guard (reading, checking, claiming, sending) are separate modules; they share this one object
 * instead of closing over a factory's locals.
 * HOW: `createGuard` builds one GuardState per context. The ledger, run id, tier and environment are the process's own;
 * unit tests inject them through the test seams of `guardApiWithSeams` only.
 */
import { callerUuidOf } from './approvals';
import { currentRunId } from '../run/runId';
import { hasLocalProof } from '../tier/localProof';
import { isLocalTier, tierIdentity } from '../tier/kind';
import type { LiveOptions } from '../ledger/ownership';
import type { APIRequestContext } from '@playwright/test';
import type { GuardTestSeams } from './types';

export class GuardState {
    /** Uuids `probeUuid()` handed out: accepted as mutation targets, they name no object. */
    readonly probes = new Set<string>();
    readonly env: NodeJS.ProcessEnv;
    private readonly localStack: boolean;
    /** The caller's own user uuid once read (approval profile steps). */
    private caller: string | undefined;

    constructor(
        readonly api: APIRequestContext,
        options: { localStack?: boolean },
        private readonly seams: GuardTestSeams,
    ) {
        this.env = seams.env ?? process.env;
        this.localStack = options.localStack === true;
    }

    runId(): string {
        return this.seams.runId ?? currentRunId(this.env);
    }

    /** Ledger lines, run id, tier and environment of every live ownership check. */
    liveOptions(): LiveOptions {
        const { seams } = this;
        return {
            ...(seams.lines ? { lines: seams.lines } : {}),
            ...(seams.file ? { file: seams.file } : {}),
            runId: this.runId(),
            tier: seams.tier === undefined ? (tierIdentity(this.env) ?? null) : seams.tier,
            env: this.env,
        };
    }

    /** `localStack` lifts the platform deny-list and the ownership rules only on a proven local stack. */
    isProvenLocal(): boolean {
        return this.localStack && isLocalTier(this.env) && hasLocalProof(this.env);
    }

    /** The caller's own user uuid (`GET /v1/auth/profile` through the wrapped context), cached once read. */
    async callerUuid(): Promise<string | undefined> {
        if (this.caller) return this.caller;
        try {
            const r = await this.api.get('/api/v1/auth/profile', { failOnStatusCode: false });
            if (r.ok()) this.caller = callerUuidOf(await r.json());
        } catch {
            this.caller = undefined;
        }
        return this.caller;
    }
}
