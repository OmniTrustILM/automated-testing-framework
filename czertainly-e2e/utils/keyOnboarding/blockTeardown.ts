/**
 * blockTeardown — the tear-down of the key onboarding block: the developers' block tear-down (utils/devBlocks/
 * blockTeardown.ts) for the ledger lines whose spec starts with `key-onboarding/`, with the token clean-up as its
 * `after` step.
 *
 * WHAT: first the block's platform objects go, in the run-end teardown's delete order (keys — destroyed on the token
 * when a plain delete is refused — certificates, token profile, token, PIN secret, vault profile, vault instance, the
 * custom attribute); then every object left on the token whose label starts with this run's id (the pairs never
 * onboarded, or removed from the inventory) is deleted there (provision/plant.ts `unplantRunKeys`).
 * WHY: the block plants key pairs on the token the way a tool outside the platform would, so its tear-down has to
 * remove them outside the platform too. The token step runs only when every platform object of the block is gone:
 * otherwise the platform would keep a key whose token objects were removed under it.
 * HOW: see utils/devBlocks/blockTeardown.ts for the switches (dry run, API_DELETE_OWN, local-backend proof).
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
