/**
 * requireTool — the OpenSSL version parser refuses LibreSSL, requireTool names the variable that overrides a missing tool,
 * and under REG_UNIT_NO_DOCKER only an absolute fake inside the test output runs as docker (a logging fake first on
 * PATH must stay unused). No real tool is needed.
 */
import { test, expect } from '@playwright/test';
import { parseOpenSslVersion, requireTool, unitDockerBinProblem } from '../../utils/regression/requireTool';
import * as fs from 'fs';
import * as path from 'path';
import { dockerContainerProof } from '../../utils/regression/tier/docker';

test('OpenSSL 3 is parsed, LibreSSL and garbage are not', () => {
    expect(parseOpenSslVersion('OpenSSL 3.3.1 4 Jun 2024 (Library: OpenSSL 3.3.1 4 Jun 2024)')).toEqual({ major: 3, minor: 3 });
    expect(parseOpenSslVersion('OpenSSL 1.1.1w  11 Sep 2023')).toEqual({ major: 1, minor: 1 });
    expect(parseOpenSslVersion('LibreSSL 3.3.6')).toBeUndefined();
    expect(parseOpenSslVersion('')).toBeUndefined();
});

test('a missing tool is a skip reason naming its override variable', () => {
    expect(requireTool('sscep', '/nonexistent/qa-no-such-binary')).toBe('sscep not found on the runner (set REG_SSCEP_BIN or install it)');
    expect(requireTool('openssl', '/nonexistent/qa-no-such-openssl')).toMatch(/REG_OPENSSL_BIN/);
});

test('a binary that is not OpenSSL 3 is refused for the cmp rows', () => {
    // `node --version` prints "v22…", which is not "OpenSSL 3.x": the version check refuses it.
    expect(requireTool('openssl', process.execPath)).toMatch(/OpenSSL 3\.x required/);
});

// ------------------------------------------------------------------ docker gates: only an absolute fake inside the test output runs

// docker gates: under REG_UNIT_NO_DOCKER only an absolute fake inside the test output runs; requireTool too
test('docker gates: under REG_UNIT_NO_DOCKER only an absolute fake in the test output runs', ({}, testInfo) => {
    expect(process.env.REG_UNIT_NO_DOCKER, 'set by playwright.unit.config.ts').toBe('1');
    // A logging fake named `docker`, FIRST on PATH: if anything ran "docker" by name, its log would say so.
    const bin = testInfo.outputPath('bin');
    fs.mkdirSync(bin, { recursive: true });
    const log = testInfo.outputPath('docker-calls.log');
    fs.writeFileSync(log, '');
    const fake = path.join(bin, 'docker');
    fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\necho 'Docker version 0.0.0-fake'\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    const savedBin = process.env.REG_DOCKER_BIN;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    delete process.env.REG_DOCKER_BIN;
    try {
        const calls = () => fs.readFileSync(log, 'utf8').trim();
        // Refused without running anything: a bare name, a system path, a symlink that leaves the test output.
        expect(unitDockerBinProblem('docker')).toMatch(/absolute path/);
        expect(unitDockerBinProblem('/usr/local/bin/docker')).toMatch(/inside the test output/);
        const link = path.join(bin, 'docker-link');
        fs.symlinkSync('/usr/bin/true', link);
        expect(unitDockerBinProblem(link), 'a symlink is judged by its target').toMatch(/inside the test output/);
        expect(requireTool('docker'), 'requireTool with the default name').toMatch(/disabled under the unit tests/);
        expect(requireTool('docker', '/usr/local/bin/docker')).toMatch(/disabled under the unit tests/);
        expect(dockerContainerProof(8280, undefined, { REG_DOCKER_BIN: 'docker' })).toEqual({ ok: false, error: expect.stringMatching(/absolute path/) });
        expect(dockerContainerProof(8280, undefined, { REG_DOCKER_BIN: link })).toEqual({ ok: false, error: expect.stringMatching(/inside the test output/) });
        expect(dockerContainerProof(8280, undefined, {})).toEqual({ ok: false, error: expect.stringMatching(/disabled under the unit tests/) });
        expect(calls(), 'nothing named docker ran').toBe('');
        // The fake itself, named by its absolute path inside the test output, does run.
        expect(unitDockerBinProblem(fake)).toBeUndefined();
        expect(requireTool('docker', fake)).toBeUndefined();
        dockerContainerProof(8280, undefined, { REG_DOCKER_BIN: fake });
        expect(calls().split('\n')).toEqual(['--version', 'ps --format {{json .}}']);
    } finally {
        process.env.PATH = savedPath;
        if (savedBin === undefined) delete process.env.REG_DOCKER_BIN;
        else process.env.REG_DOCKER_BIN = savedBin;
    }
});
