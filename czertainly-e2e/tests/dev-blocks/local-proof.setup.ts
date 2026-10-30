/**
 * local-proof.setup — the local-backend proof a developers' block run takes first (the `<block>-proof` project).
 *
 * On a local stack, proves that BASE_URL is served by the local core itself: the build marker, and an own role created
 * through BASE_URL and read back through the core's own URL and from inside its container. Then writes the run's proof file.
 * `describeLocalOnly` and the guard's `localStack` option honour only a run that holds this proof.
 * A shared tier never gets here. The proof role is recorded in the ledger (spec `<block>/proof`), so the block's teardown
 * removes it; the config's global teardown removes the proof file.
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
