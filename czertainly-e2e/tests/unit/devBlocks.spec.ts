/**
 * devBlocks — the registry of the developers' blocks, the project builder, the DEV_BLOCK choice of
 * playwright.devblock.config.ts and the block run's global teardown.
 *
 * Checks that unknown or unset DEV_BLOCK is an error, each block yields proof, setup, block, teardown, a shared tier selects
 * nothing and a local one all four, and the regression config holds no block. A block must exit 0 with an empty report on a
 * shared tier. Pure functions with an injected environment.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import devBlockGlobalTeardown from '../../utils/devBlocks/globalTeardown';
import { basicPassword, ensureRunSecret } from '../../utils/timestamping/secrets';
import { DEV_BLOCKS, DEV_BLOCK_NAMES, devBlockProjects, LOCAL_PROOF_FILE, selectedDevBlock } from '../../utils/devBlocks/registry';
import { resolveProjectFilters, selectsTest } from '../../utils/regression/projectFilters';
import { projectsSelectingFile, regressionProjects } from '../../utils/regression/regressionProjects';

const TITLE = 'a block test @dev-tests @local';

test('DEV_BLOCK: unknown or unset is a clear error, a known name selects its entry', () => {
    expect(() => selectedDevBlock({})).toThrow(/DEV_BLOCK must name the block/);
    expect(() => selectedDevBlock({ DEV_BLOCK: 'nope' })).toThrow(/"nope"/);
    expect(() => selectedDevBlock({ DEV_BLOCK: '' })).toThrow(/timestamping \| key-onboarding/);
    for (const name of DEV_BLOCK_NAMES) expect(selectedDevBlock({ DEV_BLOCK: name }).junit).toBe(`dev-${name}`);
});

for (const name of DEV_BLOCK_NAMES) {
    test(`${name}: proof, then setup, then the specs, then the teardown project of the setup`, () => {
        const b = DEV_BLOCKS[name];
        const projects = devBlockProjects(name, {});
        expect(projects.map((p) => p.name)).toEqual([`${name}-proof`, `${name}-setup`, name, `${name}-teardown`]);
        const by = (n: string) => projects.find((p) => p.name === n)!;
        expect(by(`${name}-proof`).dependencies, 'the proof is the first project').toBeUndefined();
        expect(by(`${name}-setup`).dependencies).toEqual([`${name}-proof`]);
        expect(by(`${name}-setup`).teardown).toBe(`${name}-teardown`);
        expect(by(name).dependencies).toEqual([`${name}-setup`]);
        expect(by(`${name}-teardown`).dependencies, 'a teardown project may not have dependencies').toBeUndefined();
        const files = [`${b.dir.slice(2)}/${name}.setup.ts`, `${b.dir.slice(2)}/20-a.spec.ts`, `${b.dir.slice(2)}/${name}.teardown.ts`];
        const sel = (p: string, f: string) => projectsSelectingFile(projects.filter((x) => x.name === p), f, './tests');
        expect(files.map((f) => sel(`${name}-setup`, f))).toEqual([[`${name}-setup`], [], []]);
        expect(files.map((f) => sel(name, f))).toEqual([[], [name], []]);
        expect(files.map((f) => sel(`${name}-teardown`, f))).toEqual([[], [], [`${name}-teardown`]]);
        expect(sel(`${name}-proof`, 'tests/dev-blocks/local-proof.setup.ts')).toEqual([`${name}-proof`]);
        expect(LOCAL_PROOF_FILE.test('tests/dev-blocks/local-proof.setup.ts')).toBe(true);
        expect(b.junit).toBe(`dev-${name}`);
    });

    test(`${name}: a shared tier selects nothing in the four projects, a local tier selects all four`, () => {
        const shared = resolveProjectFilters({ projects: devBlockProjects(name, {}) });
        expect(shared.map((p) => selectsTest(p, TITLE))).toEqual([false, false, false, false]);
        const local = resolveProjectFilters({ projects: devBlockProjects(name, { TIER_KIND: 'local' }) });
        expect(local.map((p) => selectsTest(p, TITLE))).toEqual([true, true, true, true]);
    });
}

test('the blocks do not select each other\'s files, and the regression config holds none of them', () => {
    const ts = devBlockProjects('timestamping', {});
    const ko = devBlockProjects('key-onboarding', {});
    expect(projectsSelectingFile(ts, 'tests/key-onboarding/20-onboarding.spec.ts', './tests')).toEqual([]);
    expect(projectsSelectingFile(ko, 'tests/timestamping/40-tsp-errors.spec.ts', './tests')).toEqual([]);
    const names = regressionProjects({ TIER_KIND: 'local' }).map((p) => p.name);
    expect(names.filter((n) => /timestamping|key-onboarding/.test(n!))).toEqual([]);
});

test('the global teardown retries the block, then removes the proof, whatever happens', async () => {
    const calls: string[] = [];
    const env = { DEV_BLOCK: 'timestamping', TIER_KIND: 'local', REG_RUN_ID: 'qa-reg-20260101-000000-abcd' };
    await devBlockGlobalTeardown(undefined, { env, teardown: async () => { calls.push('teardown'); }, liveLines: () => 0, removeProof: () => { calls.push('proof'); } });
    expect(calls).toEqual(['teardown', 'proof']);
    calls.length = 0;
    await expect(devBlockGlobalTeardown(undefined, {
        env, teardown: async () => { throw new Error('could not delete'); }, liveLines: () => 1, removeProof: () => { calls.push('proof'); },
    })).rejects.toThrow('could not delete');
    expect(calls, 'the proof is removed although the teardown failed').toEqual(['proof']);
});

test('the global teardown does nothing on a shared tier without a ledger line of the block, and still removes the proof', async () => {
    const calls: string[] = [];
    const env = { DEV_BLOCK: 'key-onboarding', REG_RUN_ID: 'qa-reg-20260101-000000-abcd' };
    await devBlockGlobalTeardown(undefined, { env, teardown: async () => { calls.push('teardown'); }, liveLines: () => 0, removeProof: () => { calls.push('proof'); } });
    expect(calls).toEqual(['proof']);
    await expect(devBlockGlobalTeardown(undefined, { env: {}, teardown: async () => undefined, removeProof: () => undefined })).rejects.toThrow(/DEV_BLOCK/);
});

test('the proof file and the configs are where the README says', () => {
    const root = path.resolve(__dirname, '..', '..');
    for (const f of ['playwright.devblock.config.ts', 'tests/dev-blocks/local-proof.setup.ts', 'utils/devBlocks/globalTeardown.ts']) {
        expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    }
});

// ------------------------------------------------------------------ one run secret per run, across the config's loads

/**
 * Playwright evaluates the config in the runner AND again in every worker process (a worker inherits the runner's environment). The timestamping
 * block derives its Basic-credential passwords from TSA_RUN_SECRET: a config that made a new secret on every load gave the setup worker one value
 * and the spec workers another (every TSP request answered 401). Loads the real config afresh, the run's other variables cleared like a new process
 * would see them, TSA_RUN_SECRET as the previous load left it.
 */
function loadDevBlockConfig(stateDir: string): string | undefined {
    const keys = ['TIER_KIND', 'BASE_URL', 'REG_STATE_DIR', 'REG_ENV_FILE', 'REG_ENV_FILE_PINNED', 'REG_RUN_ID', 'API_RUN_ID', 'DEV_BLOCK', 'AUTH_MODE', 'REG_RA_PROFILE_NAME', 'REG_RUN_ID_REUSE'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'empty.env'), '');
    Object.assign(process.env, { REG_ENV_FILE: path.join(stateDir, 'empty.env'), REG_STATE_DIR: stateDir, DEV_BLOCK: 'timestamping' });
    try {
        const abs = path.resolve(__dirname, '..', '..', 'playwright.devblock.config.ts');
        delete require.cache[require.resolve(abs)];
        require(abs);
        return process.env.TSA_RUN_SECRET;
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('the config makes the run secret once: a second load (a worker) keeps it, a preset value is kept, an empty one is replaced', ({}, testInfo) => {
    const before = process.env.TSA_RUN_SECRET;
    try {
        delete process.env.TSA_RUN_SECRET;
        const first = loadDevBlockConfig(testInfo.outputPath('a'));
        expect(first, 'the runner makes one').toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(loadDevBlockConfig(testInfo.outputPath('b')), 'a worker loading the config again finds it set and keeps it').toBe(first);
        expect(loadDevBlockConfig(testInfo.outputPath('c')), 'and a third load').toBe(first);

        process.env.TSA_RUN_SECRET = 'preset-by-the-caller-0123456789abcdef-xyz';
        expect(loadDevBlockConfig(testInfo.outputPath('d')), 'a preset value is kept').toBe('preset-by-the-caller-0123456789abcdef-xyz');

        process.env.TSA_RUN_SECRET = '';
        expect(loadDevBlockConfig(testInfo.outputPath('e')), 'an empty value counts as none').toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
        if (before === undefined) delete process.env.TSA_RUN_SECRET;
        else process.env.TSA_RUN_SECRET = before;
    }
});

test('ensureRunSecret: set once, never replaced; the passwords of one secret agree across "processes"', () => {
    const env: NodeJS.ProcessEnv = {};
    const a = ensureRunSecret(env);
    expect(ensureRunSecret(env)).toBe(a);
    expect(env.TSA_RUN_SECRET).toBe(a);
    const worker: NodeJS.ProcessEnv = { ...env };
    expect(ensureRunSecret(worker), 'a worker inherits the runner\'s environment').toBe(a);
    expect(basicPassword('00000000-0000-4000-8000-000000000001', 'user', worker)).toBe(basicPassword('00000000-0000-4000-8000-000000000001', 'user', env));
});
