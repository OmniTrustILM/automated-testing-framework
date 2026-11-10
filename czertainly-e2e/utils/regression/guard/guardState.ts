/** guardState — what one guarded context knows between its requests (wrapped context, probes, run id, live-check options). */
import { callerUuidOf } from './approvals';
import { currentRunId } from '../run/runId';
import { hasLocalProof } from '../tier/localProof';
import { isLocalTier, tierIdentity } from '../tier/kind';
import type { LiveOptions } from '../ledger/ownership';
import type { APIRequestContext } from '@playwright/test';
import type { GuardTestSeams } from './types';

/** For guard/callbackTargets.ts only (lint rule `callback-target`). */
export const STATES = new WeakMap<object, GuardState>();

export class GuardState {
    readonly probes = new Set<string>();
    readonly callbackTargets: Record<'authority' | 'connector', Set<string>> = { authority: new Set(), connector: new Set() };
    readonly env: NodeJS.ProcessEnv;
    private readonly localStack: boolean;
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

    isProvenLocal(): boolean {
        return this.localStack && isLocalTier(this.env) && hasLocalProof(this.env);
    }

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
