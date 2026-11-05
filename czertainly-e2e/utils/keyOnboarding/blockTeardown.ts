/**
 * blockTeardown — the teardown of the key onboarding block (utils/devBlocks/blockTeardown.ts), with the token clean-up as its `after` step.
 * The token step runs only when every platform object of the block is
 * gone, so the platform never keeps a key whose token objects were removed.
 */
import * as devBlock from '../devBlocks/blockTeardown';
import { unplantRunKeys } from './provision/provision';

export const BLOCK_SPEC_PREFIX = 'key-onboarding/';
export const TEARDOWN_LEDGER_SPEC = `${BLOCK_SPEC_PREFIX}teardown`;

export const KEY_ONBOARDING_BLOCK: devBlock.DevBlock = {
    prefix: BLOCK_SPEC_PREFIX,
    teardownSpec: TEARDOWN_LEDGER_SPEC,
    after: (env, runId) => unplantRunKeys(env, runId),
};

export function teardownBlock(deps: devBlock.BlockTeardownDeps = {}): Promise<devBlock.BlockTeardownOutcome> {
    return devBlock.teardownBlock(KEY_ONBOARDING_BLOCK, deps);
}
