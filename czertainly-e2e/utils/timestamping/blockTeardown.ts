/**
 * blockTeardown — the tear-down of the timestamping block: the developers' block tear-down (utils/devBlocks/
 * blockTeardown.ts) for the ledger lines whose spec starts with `timestamping/`.
 *
 * WHAT / WHY / HOW: see utils/devBlocks/blockTeardown.ts. The timestamping block makes nothing outside the platform, so
 * it has no `after` step.
 */
import type { LedgerLine } from '../regression/ledger/ledger';
import * as devBlock from '../devBlocks/blockTeardown';

/** The ledger `spec` prefix of everything the block records. */
export const BLOCK_SPEC_PREFIX = 'timestamping/';
/** The `spec` of the `deleted` lines this teardown writes. */
export const TEARDOWN_LEDGER_SPEC = `${BLOCK_SPEC_PREFIX}teardown`;

const TIMESTAMPING_BLOCK: devBlock.DevBlock = { prefix: BLOCK_SPEC_PREFIX, teardownSpec: TEARDOWN_LEDGER_SPEC };

export type BlockTeardownOutcome = devBlock.BlockTeardownOutcome;
export type BlockTeardownDeps = devBlock.BlockTeardownDeps;

/** The block's ledger lines of this run (devBlocks `blockLines` with the `timestamping/` prefix). */
export function blockLines(lines: LedgerLine[], runId: string): LedgerLine[] {
    return devBlock.blockLines(lines, runId, BLOCK_SPEC_PREFIX);
}

export function teardownBlock(deps: BlockTeardownDeps = {}): Promise<BlockTeardownOutcome> {
    return devBlock.teardownBlock(TIMESTAMPING_BLOCK, deps);
}
