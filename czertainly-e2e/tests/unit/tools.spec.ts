/**
 * Unit tests for tools.ts (direct tests asked by review R18): the OpenSSL version parser refuses LibreSSL, and
 * requireTool reports a missing binary with the variable that overrides it (no real tool is needed).
 */
import { test, expect } from '@playwright/test';
import { parseOpenSslVersion, requireTool } from '../../utils/regression/tools';

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
