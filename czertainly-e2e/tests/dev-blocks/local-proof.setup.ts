/**
 * local-proof.setup — the local-backend proof a developers' block run takes first (the `<block>-proof` project).
 *
 * WHAT: on a local stack, proves that BASE_URL is served by the local core itself (build marker, an own role created
 * through BASE_URL and read back through the core's own URL and from inside its container) and writes the run's proof file.
 * WHY: `describeLocalOnly` and the guard's `localStack` option honour only a run that holds this proof; the block runs
 * have no snapshot setup, which takes it in the main flow. A shared tier never gets here (`@local`, and the second guard).
 * HOW: the same steps as the guard proof of the snapshot setup, nothing else: no snapshot, no run objects. The proof role
 * is recorded in the ledger under spec `<block>/proof`, so the block's tear-down removes it; the proof file is removed
 * by the config's global teardown.
 */
import { test } from '../../fixtures/testFixtures';
import { getAuthenticatedApiContext } from '../../utils/auth/apiContext';
import { selectedDevBlock } from '../../utils/devBlocks/registry';
import { guardApi } from '../../utils/regression/guard/createGuard';
import { createOwnRole } from '../../utils/regression/ownRoles';
import { isLocalTier } from '../../utils/regression/tier/kind';
import { assertRunTierLive, proveLocalInstance } from '../../utils/regression/tier/localProof';

// The second guard is the tier kind only: this test makes the proof, so it cannot wait for it.
test.skip(!isLocalTier(), 'local stack only (TIER_KIND=local)');

test('the local backend is proven for this block run', { tag: ['@dev-tests', '@local'] }, async ({ request, env }) => {
    const block = selectedDevBlock();
    const raw = await getAuthenticatedApiContext(request, env);
    try {
        await assertRunTierLive(raw);
        const own = guardApi(raw);
        await proveLocalInstance(raw, process.env, {
            createRole: async () => createOwnRole(own, `${block.name}/proof`, 'instance', { note: 'local instance proof' }),
        });
    } finally {
        await raw.dispose();
    }
});
