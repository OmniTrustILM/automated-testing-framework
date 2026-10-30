/**
 * blockTeardown — the teardown of the key onboarding block.
 *
 * The developers' block teardown (utils/devBlocks/blockTeardown.ts) for ledger lines whose spec starts with
 * `key-onboarding/`, with the token clean-up as its `after` step; see that file for the switches.
 *
 * First the block's platform objects go, in the run-end teardown's delete order. Then every object left on the token whose
 * label starts with this run's id is deleted. The token step runs only when every platform object of the block is gone,
 * so the platform never keeps a key whose token objects were removed.
 */
import * as devBlock from '../devBlocks/blockTeardown';
import { unplantRunKeys } from './provision/provision';

/** The ledger `spec` prefix of everything the block records. */
export const BLOCK_SPEC_PREFIX = 'key-onboarding/';
/** The `spec` of the `deleted` lines this teardown writes. */
export const TEARDOWN_LEDGER_SPEC = `${BLOCK_SPEC_PREFIX}teardown`;

export const KEY_ONBOARDING_BLOCK: devBlock.DevBlock = {
    prefix: BLOCK_SPEC_PREFIX,
    teardownSpec: TEARDOWN_LEDGER_SPEC,
    after: (env, runId) => unplantRunKeys(env, runId),
};

export function teardownBlock(deps: devBlock.BlockTeardownDeps = {}): Promise<devBlock.BlockTeardownOutcome> {
    return devBlock.teardownBlock(KEY_ONBOARDING_BLOCK, deps);
}
