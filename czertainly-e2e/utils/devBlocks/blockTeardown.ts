/**
 * blockTeardown — the tear-down of a developers' test block (`@dev-tests`: tests/timestamping, tests/key-onboarding):
 * deletes what the block's setup and specs created, right after the block, before the rest of the run goes on.
 *
 * WHAT: selects the ledger lines of THIS run that the block wrote (spec `<block>/…`) and hands exactly those to the
 * run-end delete engine (`executeTeardown`: delete order, own-object guard per object, one retry, final pass, absence
 * proof by GET). Deleted objects get their `deleted` ledger line (spec `<block>/teardown`). An optional `after` step
 * removes what the block made OUTSIDE the platform (key pairs planted on a token); it runs only when every ledger object
 * of the block is gone, so the platform never keeps a key whose token objects were removed under it.
 * WHY: one tear-up fills the environment for the block, one tear-down empties it again. The run-end teardown stays the
 * safety net: whatever fails here is still a live line there, and is retried and reported.
 * HOW: `blockLines()` is pure (unit-tested). `teardownBlock()` follows the run-end teardown's switches: under
 * API_TEARDOWN_DRY_RUN it only reports the plan, with API_DELETE_OWN off it keeps everything, and on a local tier it
 * re-checks the authenticated local-backend proof before the first delete. It throws when an object could not be
 * deleted, so the block's teardown test is red and names it (type and uuid only: names stay in the local state).
 */
import { Logger } from '../Logger';
import { readLedger, recordDeleted, type LedgerLine } from '../regression/ledger/ledger';
import { mayDeleteOwn } from '../regression/ledger/ownership';
import { isDryRun } from '../regression/run/flags';
import { currentRunId } from '../regression/run/runId';
import { isLocalTier, tierIdentity } from '../regression/tier/kind';
import { assertLocalBackend } from '../regression/tier/localProof';
import { authenticatedApi, executeTeardown, formatPlan, handlerOf, planTeardown, type ExecuteOptions, type ExecuteResult } from '../regression/teardown/runTeardown';

const logger = new Logger('DevBlockTeardown');

/** A block: its ledger `spec` prefix (`timestamping/`), the spec of its `deleted` lines, and an optional `after` step. */
export interface DevBlock {
    prefix: string;
    teardownSpec: string;
    /**
     * Removes what the block made outside the platform; runs after the ledger objects are gone, and also when the block
     * has no ledger line left. Returns a short report for the annotation.
     */
    after?: (env: NodeJS.ProcessEnv, runId: string) => Promise<string>;
}

/**
 * Every ledger line about an object the block created in this run: its `created` line (spec `<prefix>…`) and whatever
 * was written about the same uuid later (a `deleted` line, whoever wrote it), so the engine sees an object as deleted
 * already when it is. Objects the platform made for a block object belong to the block too: a `derived` line whose
 * `parents` name a block object (the certKey_ key of a block certificate, which the certificate handler's safety net
 * records under spec `runTeardown` while the block's teardown runs).
 */
export function blockLines(lines: LedgerLine[], runId: string, prefix: string): LedgerLine[] {
    const ofRun = lines.filter((l) => l.runId === runId);
    const own = new Set(ofRun.filter((l) => l.event === 'created' && l.spec.startsWith(prefix)).map((l) => l.uuid));
    for (const l of ofRun) {
        if (l.event === 'created' && l.derived && Object.values(l.parents ?? {}).flat().some((parent) => own.has(parent))) own.add(l.uuid);
    }
    return ofRun.filter((l) => own.has(l.uuid));
}

export type BlockTeardownOutcome =
    | { status: 'skipped'; reason: string }
    | { status: 'done'; deleted: number; kept: number; result?: ExecuteResult; after?: string };

export interface BlockTeardownDeps {
    readLines?: () => LedgerLine[];
    authenticate?: typeof authenticatedApi;
    env?: NodeJS.ProcessEnv;
    /** Unit-test seams of the delete engine (default: the run-end teardown's handlers, retry delay and poll interval). */
    handler?: ExecuteOptions['handler'];
    retryDelayMs?: number;
    pollMs?: number;
}

export async function teardownBlock(block: DevBlock, deps: BlockTeardownDeps = {}): Promise<BlockTeardownOutcome> {
    const env = deps.env ?? process.env;
    const runId = currentRunId(env);
    const readLines = () => blockLines((deps.readLines ?? readLedger)(), runId, block.prefix);
    const tier = tierIdentity(env) ?? null;
    const handler = deps.handler ?? handlerOf;
    const plan = planTeardown(readLines(), runId, handler, { tier });

    if (isDryRun(env)) {
        if (plan.length) logger.info(`API_TEARDOWN_DRY_RUN — the ${block.prefix} block's objects (nothing is deleted):\n${formatPlan(plan)}`);
        return plan.length || block.after ? { status: 'skipped', reason: 'API_TEARDOWN_DRY_RUN is on' } : { status: 'done', deleted: 0, kept: 0 };
    }
    if (!mayDeleteOwn(env)) {
        logger.info(`API_DELETE_OWN off — keeping the ${block.prefix} block's ${plan.length} object(s); the run-end teardown lists them`);
        return plan.length || block.after ? { status: 'skipped', reason: 'API_DELETE_OWN is off' } : { status: 'done', deleted: 0, kept: 0 };
    }
    if (!plan.length) {
        const after = block.after ? await block.after(env, runId) : undefined;
        return { status: 'done', deleted: 0, kept: 0, ...(after !== undefined ? { after } : {}) };
    }

    const authenticate = deps.authenticate ?? authenticatedApi;
    const disposers: Array<() => Promise<void>> = [];
    const newApi = async () => {
        const { api, dispose } = await authenticate();
        disposers.push(dispose);
        return api;
    };
    let result: ExecuteResult;
    try {
        // On a local stack prove the backend before the first delete, as the run-end teardown does (a shared tier has no such proof).
        if (isLocalTier(env)) await assertLocalBackend(await newApi(), env);
        logger.info(`deleting the ${block.prefix} block's ${plan.length} object(s) of run ${runId}`);
        result = await executeTeardown({
            runId,
            newApi,
            tier,
            readLines,
            handler,
            ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
            ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
            onDeleted: (item, note) => recordDeleted(item.type, { uuid: item.uuid, name: item.name }, block.teardownSpec, note),
        });
    } finally {
        for (const dispose of disposers) await dispose().catch(() => undefined);
    }
    if (result.warnings.length) logger.warn(`${block.prefix} block teardown warnings:\n  ${result.warnings.join('\n  ')}`);
    if (result.failed.length) {
        throw new Error(`The ${block.prefix} block's teardown could not delete ${result.failed.length} object(s) (the run-end teardown retries ` +
            `them${block.after ? '; what the block made outside the platform stays until then' : ''}): ${result.failed.map((f) => `${f.type} ${f.uuid}`).join(', ')}`);
    }
    if (block.after && result.kept.length) {
        // A kept object is still in the platform (e.g. a derived key that holds a token's key pair): removing what the block
        // made outside the platform now would leave the platform with a key whose token objects are gone.
        const skipped = `skipped: ${result.kept.length} object(s) kept (${result.kept.map((k) => `${k.type} ${k.uuid}`).join(', ')}); ` +
            'what the block made outside the platform stays until they are gone';
        logger.warn(`${block.prefix} block: ${skipped}`);
        return { status: 'done', deleted: result.deleted.length, kept: result.kept.length, result, after: skipped };
    }
    const after = block.after ? await block.after(env, runId) : undefined;
    return { status: 'done', deleted: result.deleted.length, kept: result.kept.length, result, ...(after !== undefined ? { after } : {}) };
}
