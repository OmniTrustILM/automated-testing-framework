/**
 * devBlocks — the registry of the developers' blocks, the project builder, the DEV_BLOCK choice of
 * playwright.devblock.config.ts and the block run's global teardown.
 *
 * WHAT: unknown or unset DEV_BLOCK is an error; each block yields proof → setup → block → teardown with the right
 * files; a shared tier selects nothing in any of them and a local one selects all four; the regression config holds no block.
 * WHY: a block reports on its own and must exit 0 with an empty report on a shared tier; the proof project must come first.
 * HOW: pure functions with an injected environment; the global teardown with injected seams.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import devBlockGlobalTeardown from '../../utils/devBlocks/globalTeardown';
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
