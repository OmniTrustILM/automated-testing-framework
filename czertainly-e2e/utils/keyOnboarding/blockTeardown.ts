/**
 * blockTeardown — the teardown of the key onboarding block (utils/devBlocks/blockTeardown.ts), with the token clean-up as its `after` step.
 * The token step runs only when every platform object of the block is gone. When it cannot run while the planting marker exists,
 * or a plant attempt never reported its end, the teardown fails and names the file with the manual removal command.
 */
import * as devBlock from '../devBlocks/blockTeardown';
import { scrubError } from '../devBlocks/provision/transport';
import { keyOnboardingConfig } from './config';
import { DEV_BLOCKS } from '../devBlocks/registry';
import { BUDGET_MARGIN_MS, plantingLeftover, type UnplantDeps } from './provision/plant';
import { unplantRunKeys } from './provision/provision';

export const BLOCK_SPEC_PREFIX = 'key-onboarding/';
export const TEARDOWN_LEDGER_SPEC = `${BLOCK_SPEC_PREFIX}teardown`;

export function keyOnboardingBlock(deps: UnplantDeps = {}, startedAt: number = (deps.now ?? Date.now)()): devBlock.DevBlock {
    const deadlineAt = deps.deadlineAt ?? startedAt + DEV_BLOCKS['key-onboarding'].timeouts.teardown - BUDGET_MARGIN_MS;
    return {
        prefix: BLOCK_SPEC_PREFIX,
        teardownSpec: TEARDOWN_LEDGER_SPEC,
        after: (env, runId) => unplantRunKeys(env, runId, { ...deps, deadlineAt }),
        mustRunAfter: plantingLeftover,
    };
}

export function teardownBlock(deps: devBlock.BlockTeardownDeps = {}, block: devBlock.DevBlock = keyOnboardingBlock()): Promise<devBlock.BlockTeardownOutcome> {
    return devBlock.teardownBlock(block, deps).catch((e: unknown) => {
        throw scrubError(e, [keyOnboardingConfig(deps.env ?? process.env).tokenPin]);
    });
}
