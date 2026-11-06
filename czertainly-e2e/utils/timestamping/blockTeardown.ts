/**
 * blockTeardown — the tear-down of the timestamping block (utils/devBlocks/blockTeardown.ts), with no `after` step.
 */
import type { LedgerLine } from '../regression/ledger/ledger';
import * as devBlock from '../devBlocks/blockTeardown';

export const BLOCK_SPEC_PREFIX = 'timestamping/';
export const TEARDOWN_LEDGER_SPEC = `${BLOCK_SPEC_PREFIX}teardown`;

const TIMESTAMPING_BLOCK: devBlock.DevBlock = { prefix: BLOCK_SPEC_PREFIX, teardownSpec: TEARDOWN_LEDGER_SPEC };

export type BlockTeardownOutcome = devBlock.BlockTeardownOutcome;
export type BlockTeardownDeps = devBlock.BlockTeardownDeps;

export function blockLines(lines: LedgerLine[], runId: string): LedgerLine[] {
    return devBlock.blockLines(lines, runId, BLOCK_SPEC_PREFIX);
}

export function teardownBlock(deps: BlockTeardownDeps = {}): Promise<BlockTeardownOutcome> {
    return devBlock.teardownBlock(TIMESTAMPING_BLOCK, deps);
}
