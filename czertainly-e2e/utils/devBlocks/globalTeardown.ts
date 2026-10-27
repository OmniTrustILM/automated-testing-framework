/**
 * globalTeardown of a developers' block run (playwright.devblock.config.ts) — the retry net, not the run-end teardown.
 *
 * WHAT: (a) runs the block's own prefix-scoped tear-down once more (utils/devBlocks/blockTeardown.ts: only this run's
 * live ledger lines of the block, idempotent, with the dry-run, API_DELETE_OWN and `after` rules), (b) always removes
 * this run's local-backend proof.
 * WHY: a block run has no run-end teardown, no snapshot and no non-interference check; the block's teardown project
 * can have failed or been skipped (a failed setup), and an object it missed must not stay behind.
 * HOW: on a shared tier with no ledger line of the block nothing is read from the tier and nothing is sent (a run that skipped
 * every row, or a `key-onboarding` run, holds no object). With lines (the timestamping block on a shared tier) the block's own tear-down
 * runs: own objects only, by ledger line, tier identity and live run-prefixed name. The tear-down error, if any, is rethrown after the proof is gone.
 */
import { readLedger } from '../regression/ledger/ledger';
import { currentRunId } from '../regression/run/runId';
import { isLocalTier } from '../regression/tier/kind';
import { removeLocalProof } from '../regression/tier/localProof';
import { Logger } from '../Logger';
import { blockLines } from './blockTeardown';
import { DEV_BLOCKS, selectedDevBlock, type DevBlockName } from './registry';

const logger = new Logger('DevBlockGlobalTeardown');

/** The block's own tear-down function, loaded when needed (the key onboarding one pulls in the token tools). */
function teardownOf(name: DevBlockName): () => Promise<unknown> {
    if (name === 'timestamping') return () => (require('../timestamping/blockTeardown') as typeof import('../timestamping/blockTeardown')).teardownBlock();
    return () => (require('../keyOnboarding/blockTeardown') as typeof import('../keyOnboarding/blockTeardown')).teardownBlock();
}

export interface GlobalTeardownDeps {
    env?: NodeJS.ProcessEnv;
    teardown?: () => Promise<unknown>;
    liveLines?: (prefix: string, runId: string) => number;
    removeProof?: (env: NodeJS.ProcessEnv) => void;
}

export default async function devBlockGlobalTeardown(_config?: unknown, deps: GlobalTeardownDeps = {}): Promise<void> {
    const env = deps.env ?? process.env;
    const removeProof = deps.removeProof ?? removeLocalProof;
    try {
        const block = selectedDevBlock(env);
        const prefix = `${DEV_BLOCKS[block.name].name}/`;
        const runId = currentRunId(env);
        const lines = (deps.liveLines ?? ((p, r) => blockLines(readLedger(), r, p).length))(prefix, runId);
        if (!isLocalTier(env) && lines === 0) {
            logger.info(`no ${prefix} object in this run's ledger on a shared tier: nothing to tear down`);
            return;
        }
        await (deps.teardown ?? teardownOf(block.name))();
    } finally {
        removeProof(env);
    }
}
