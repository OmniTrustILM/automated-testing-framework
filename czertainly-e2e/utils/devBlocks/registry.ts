/**
 * registry — the developers' test blocks (`@dev-tests`) as data, and the Playwright projects of one block.
 *
 * One entry per block (timestamping, key-onboarding): its folder, setup and teardown files, JUnit report name and timeouts.
 * `devBlockProjects()` turns an entry into four projects: `<block>-proof` → `<block>-setup` → `<block>` → `<block>-teardown`.
 *
 * A block reports on its own and has no snapshot, run-setup or non-interference check; it takes only the local-backend proof.
 * On a shared tier the `@local` rows are left out: all four projects of `key-onboarding` stay empty.
 */
import type { PlaywrightTestProject } from '@playwright/test';
import { withTierFilters } from '../regression/projectFilters';

export const DEV_BLOCK_NAMES = ['timestamping', 'key-onboarding'] as const;
export type DevBlockName = (typeof DEV_BLOCK_NAMES)[number];

export interface DevBlockEntry {
    name: DevBlockName;
    /** The block's folder under the clone, `./tests/<dir>`. */
    dir: string;
    setup: RegExp;
    teardown: RegExp;
    /** The name of the reporters: test-results/<junit>-junit.xml and playwright-report/<junit>. */
    junit: string;
    /** Per-test timeouts (ms) of the setup, the specs and the teardown. */
    timeouts: { setup: number; spec: number; teardown: number };
}

/** The shared local-proof file and its folder (the `<block>-proof` project of every block). */
export const LOCAL_PROOF_DIR = './tests/dev-blocks';
export const LOCAL_PROOF_FILE = /(^|[\\/])local-proof\.setup\.ts$/;
export const LOCAL_PROOF_TIMEOUT_MS = 180_000;

export const DEV_BLOCKS: Record<DevBlockName, DevBlockEntry> = {
    timestamping: {
        name: 'timestamping',
        dir: './tests/timestamping',
        setup: /(^|[\\/])timestamping\.setup\.ts$/,
        teardown: /(^|[\\/])timestamping\.teardown\.ts$/,
        junit: 'dev-timestamping',
        timeouts: { setup: 900_000, spec: 240_000, teardown: 600_000 },
    },
    'key-onboarding': {
        name: 'key-onboarding',
        dir: './tests/key-onboarding',
        setup: /(^|[\\/])key-onboarding\.setup\.ts$/,
        teardown: /(^|[\\/])key-onboarding\.teardown\.ts$/,
        junit: 'dev-key-onboarding',
        timeouts: { setup: 600_000, spec: 120_000, teardown: 600_000 },
    },
};

/** The block named by DEV_BLOCK; unset or unknown is an error that names the choices (thrown before anything is listed). */
export function selectedDevBlock(env: NodeJS.ProcessEnv = process.env): DevBlockEntry {
    const wanted = (env.DEV_BLOCK ?? '').trim();
    const entry = (DEV_BLOCK_NAMES as readonly string[]).includes(wanted) ? DEV_BLOCKS[wanted as DevBlockName] : undefined;
    if (!entry) {
        throw new Error(`DEV_BLOCK must name the block to run (${DEV_BLOCK_NAMES.join(' | ')}); got ${wanted ? `"${wanted}"` : 'nothing'}.`);
    }
    return entry;
}

/** The four projects of one block run, with the tier rules folded in. */
export function devBlockProjects(block: DevBlockEntry | DevBlockName, env: NodeJS.ProcessEnv = process.env): PlaywrightTestProject[] {
    const b = typeof block === 'string' ? DEV_BLOCKS[block] : block;
    return withTierFilters<PlaywrightTestProject>(
        [
            // The local-backend proof every `@local` row needs (what the snapshot setup takes in the main flow).
            { name: `${b.name}-proof`, testDir: LOCAL_PROOF_DIR, testMatch: LOCAL_PROOF_FILE, timeout: LOCAL_PROOF_TIMEOUT_MS },
            {
                name: `${b.name}-setup`,
                testDir: b.dir,
                testMatch: b.setup,
                dependencies: [`${b.name}-proof`],
                teardown: `${b.name}-teardown`,
                timeout: b.timeouts.setup,
            },
            { name: b.name, testDir: b.dir, testIgnore: [b.setup, b.teardown], dependencies: [`${b.name}-setup`], timeout: b.timeouts.spec },
            { name: `${b.name}-teardown`, testDir: b.dir, testMatch: b.teardown, timeout: b.timeouts.teardown },
        ],
        { env },
    );
}
