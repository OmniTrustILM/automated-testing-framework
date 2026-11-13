/**
 * Unit tests for the log-scan matcher: fixed and run-specific needles, hit locations without the
 * matched text, base64 prefixes and the scan window.
 */
import { test, expect } from '@playwright/test';
import { base64Prefix, FIXED_NEEDLES, scanLogs, secondsSince } from '../../utils/estLogScan';

test('a clean log has no hits', () => {
    const logs = { 'core/p1': 'GET /.well-known/est/cacerts 200\nPOST /.well-known/est/simpleenroll 200' };
    expect(scanLogs(logs, FIXED_NEEDLES)).toEqual([]);
});

test('a logged Basic Authorization value is found in any header spelling', () => {
    const logs = {
        'kong/p1': 'ok\nauthorization: Basic dXNlcjpwYXNzd29yZA==',
        'ingress/p2': '"Authorization":"Basic dXNlcjpwYXNzd29yZA=="',
    };
    expect(scanLogs(logs, FIXED_NEEDLES)).toEqual([
        { source: 'kong/p1', label: 'Authorization: Basic value', line: 2 },
        { source: 'ingress/p2', label: 'Authorization: Basic value', line: 1 },
    ]);
});

test('a spaced JSON, key=value or header-list Authorization value is found', () => {
    const logs = {
        'a/p1': '{"Authorization": "Basic dXNlcjpwYXNzd29yZA=="}',
        'b/p2': 'authorization=Basic dXNlcjpwYXNzd29yZA==',
        'c/p3': 'headers=["Authorization", "Basic dXNlcjpwYXNzd29yZA=="]',
    };
    expect(scanLogs(logs, FIXED_NEEDLES).map((hit) => hit.source)).toEqual(['a/p1', 'b/p2', 'c/p3']);
});

test('the bare word Authorization or a Basic realm is not a hit', () => {
    const logs = { 'core/p1': 'missing Authorization header\nWWW-Authenticate: Basic realm="est"' };
    expect(scanLogs(logs, FIXED_NEEDLES)).toEqual([]);
});

test('a PEM private key is found', () => {
    const logs = { 'core/p1': 'a\nb\n-----BEGIN PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----' };
    expect(scanLogs(logs, FIXED_NEEDLES).map((hit) => hit.line)).toEqual([3, 4]);
});

test('a literal run value is found, and the hit does not carry the line', () => {
    const logs = { 'core/p1': 'user est-e2e-1 password s3cr3t-value' };
    const hits = scanLogs(logs, [{ label: 'Basic password', pattern: 's3cr3t-value' }]);
    expect(hits).toEqual([{ source: 'core/p1', label: 'Basic password', line: 1 }]);
    expect(JSON.stringify(hits)).not.toContain('s3cr3t');
});

test('base64Prefix is the start of the base64 of the DER', () => {
    const der = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    expect(base64Prefix(der)).toBe(der.toString('base64').slice(0, 64));
    expect(base64Prefix(der, 8)).toHaveLength(8);
});

test('secondsSince rounds up and adds the margin', () => {
    const now = new Date('2026-11-12T12:00:10.200Z');
    expect(secondsSince('2026-11-12T12:00:00.000Z', now, 600)).toBe(41);
    expect(secondsSince('2026-11-12T12:00:00.000Z', now, 600, 0)).toBe(11);
});

test('secondsSince falls back when the start is unknown', () => {
    expect(secondsSince(undefined, new Date(), 600)).toBe(600);
    expect(secondsSince('not a date', new Date(), 600)).toBe(600);
});
