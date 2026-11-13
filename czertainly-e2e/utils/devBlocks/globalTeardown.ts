/**
 * globalTeardown of a developers' block run — the retry net: runs the block's own teardown once more (this run's live ledger lines only)
 * and always removes this run's local-backend proof. A teardown error is rethrown after the proof is gone.
 * With no ledger line and nothing left outside the platform (`mustRunAfter`, e.g. key pairs on a token), nothing is sent.
 */
import { readLedger } from '../regression/ledger/ledger';
import { currentRunId } from '../regression/run/runId';
import { isLocalTier } from '../regression/tier/kind';
import { removeLocalProof } from '../regression/tier/localProof';
import { Logger } from '../Logger';
import { blockLines } from './blockTeardown';
import { DEV_BLOCKS, selectedDevBlock, type DevBlockName } from './registry';

const logger = new Logger('DevBlockGlobalTeardown');

function leftoverOf(name: DevBlockName): (env: NodeJS.ProcessEnv, runId: string) => boolean {
    if (name === 'timestamping') return () => false;
    return (env, runId) => (require('../keyOnboarding/provision/plant') as typeof import('../keyOnboarding/provision/plant')).plantingMarkerExists(env, runId);
}

function teardownOf(name: DevBlockName): () => Promise<unknown> {
    if (name === 'timestamping') return () => (require('../timestamping/blockTeardown') as typeof import('../timestamping/blockTeardown')).teardownBlock();
    return () => (require('../keyOnboarding/blockTeardown') as typeof import('../keyOnboarding/blockTeardown')).teardownBlock();
}

export interface GlobalTeardownDeps {
    env?: NodeJS.ProcessEnv;
    teardown?: () => Promise<unknown>;
    liveLines?: (prefix: string, runId: string) => number;
    leftover?: (env: NodeJS.ProcessEnv, runId: string) => boolean;
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
        if (!isLocalTier(env) && lines === 0 && !(deps.leftover ?? leftoverOf(block.name))(env, runId)) {
            logger.info(`no ${prefix} object in this run's ledger and nothing outside the platform on a shared tier: nothing to tear down`);
            return;
        }
        await (deps.teardown ?? teardownOf(block.name))();
    } finally {
        removeProof(env);
    }
}
