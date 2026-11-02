import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPublicKey, verify } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { claims, signer, http, json, timestampRequest, timestampStatus, exportRows, requireDisposable, containsFullJwt } from './helpers.mjs';

test('signed fixture uses a public-only JWK, real RS256 signature, subject, times and outer actor', () => {
    const issue = signer('https://signed.example.test/issuer', 'alice', 'platform');
    const token = issue.token({ client_id: 'outer', sub: 'service-account', act: { client_id: 'inner' } });
    const [header, payload, signature] = token.split('.');
    const jwk = JSON.parse(Buffer.from(issue.jwkSet, 'base64')).keys[0];
    assert.equal(jwk.d, undefined);
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url')), true);
    const decoded = claims(token);
    assert.equal(decoded.iss, 'https://signed.example.test/issuer');
    assert.equal(decoded.preferred_username, 'alice');
    assert.equal(decoded.aud, 'platform');
    assert.equal(decoded.act.client_id, 'outer');
    assert.equal(decoded.act.act.client_id, 'inner');
    assert.equal(decoded.exp - decoded.iat, 300);
    assert.equal(claims(issue.token()).act, undefined);
    assert.equal(claims(issue.token(null)).act, null);
    assert.throws(() => claims('private-value'), { message: 'Invalid token response (contents withheld)' });
});

test('HTTP boundary withholds response bodies, credentials and transport errors', async () => {
    const server = createServer((req, res) => {
        if (req.url === '/redirect') { res.writeHead(302, { location: '/secret' }).end(); return; }
        res.writeHead(req.url === '/fail' ? 401 : 200).end(req.url === '/json' ? '{"ok":true}' : 'secret-token');
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.deepEqual(await json(`${base}/json`), { ok: true });
        assert.equal((await http(`${base}/fail`, {}, [401])).status, 401);
        await assert.rejects(http(`${base}/fail`), { message: 'HTTP request failed (status 401; contents withheld)' });
        await assert.rejects(http(`${base}/redirect`), { message: 'HTTP request failed (status 302; contents withheld)' });
        await assert.rejects(json(`${base}/secret`), { message: 'Invalid JSON response (contents withheld)' });
        await assert.rejects(http('http://127.0.0.1:1/private-secret'), { message: 'HTTP transport failed (details withheld)' });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('RFC3161 request is SHA256 with a 32-byte imprint; granted and rejection decode independently', () => {
    assert.equal(timestampRequest().toString('hex'), '30390201013031300d060960864801650304020105000420' + '00'.repeat(32) + '0101ff');
    assert.equal(timestampStatus(Buffer.from('30053003020100', 'hex')), 0);
    assert.equal(timestampStatus(Buffer.from('30053003020101', 'hex')), 1);
    assert.equal(timestampStatus(Buffer.from('30053003020102', 'hex')), 2);
    assert.equal(timestampStatus(Buffer.from('3081053003020100', 'hex')), 0);
    assert.throws(() => timestampStatus(Buffer.from('300530030201', 'hex')), /Invalid timestamp response/);
    assert.throws(() => timestampStatus(Buffer.from('30053003040100', 'hex')), /Invalid timestamp response/);
});

function zip(csv, method = 8) {
    const raw = Buffer.from(csv);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(5, 26);
    return Buffer.concat([header, Buffer.from('a.csv'), data]);
}

test('CSV export handles raw and default zipped CSV, escaped quotes, multiline cells and semicolon', () => {
    const csv = 'actorName,actorDelegate,message\r\nalice,agent,"line one\nline ""two"""\r\n';
    for (const body of [Buffer.from(csv), zip(csv), zip(csv, 0)]) {
        assert.deepEqual(exportRows(body), [{ actorName: 'alice', actorDelegate: 'agent', message: 'line one\nline "two"' }]);
    }
    assert.deepEqual(exportRows(Buffer.from('\ufeffactorName;actorDelegate\nalice;agent\n'), ';'), [{ actorName: 'alice', actorDelegate: 'agent' }]);
    assert.throws(() => exportRows(zip(csv, 99)), /Unsupported ZIP compression/);
    assert.throws(() => exportRows(Buffer.from('a,b\n"unterminated')), /Invalid CSV/);
    assert.throws(() => exportRows(Buffer.from('a,b\nonly-one\n')), /Invalid CSV/);
    // Independent fixture from Java 21 ZipOutputStream + Jackson CSV, including a data descriptor.
    const javaZip = Buffer.from('UEsDBBQACAgIAAt4WF0AAAAAAAAAAAAAAAAJAAAAYXVkaXQuY3N2S0wuyS/yS8xN1UkEsVxSc1LTE0tSPVNS80oy0zJTi3RyU4uLE9NTuRJzMpOBqtKBEjpKOZl5qQr5ealcYIaSUkl5vpKSEhcAUEsHCEuD09FIAAAATgAAAFBLAQIUABQACAgIAAt4WF1Lg9PRSAAAAE4AAAAJAAAAAAAAAAAAAAAAAAAAAABhdWRpdC5jc3ZQSwUGAAAAAAEAAQA3AAAAfwAAAAAA', 'base64');
    assert.deepEqual(exportRows(javaZip), [{ actorName: 'alice', actorDelegateIdentifier: 'agent', message: 'line one\nline "two"' }]);
    // Core also enables ESCAPE_QUOTE_CHAR_WITH_ESCAPE_CHAR with a backslash escape.
    const coreZip = Buffer.from('UEsDBBQACAgIAFF4WF0AAAAAAAAAAAAAAAAJAAAAYXVkaXQuY3N2Hco7DoAgEEXRnlWQqWcFttrYuAKaCT6RhF9gErcv2p3kXvFa+yEZLJ82JARR7CeKxiuic8YYEmAkRT+vMANTigW2FpgfjvSpjtg20duui3OK3Mi8UEsHCDJzY5JUAAAAXQAAAFBLAQIUABQACAgIAFF4WF0yc2OSVAAAAF0AAAAJAAAAAAAAAAAAAAAAAAAAAABhdWRpdC5jc3ZQSwUGAAAAAAEAAQA3AAAAiwAAAAAA', 'base64');
    assert.deepEqual(exportRows(coreZip), [{ actorName: 'alice', actorDelegateIdentifier: 'agent', message: 'line one\nline "two", path C:\\temp' }]);
});

test('disposable guard fails closed, without echoing environment values', () => {
    assert.throws(() => requireDisposable({ DELEGATION_DISPOSABLE: 'secret' }), { message: 'Set DELEGATION_DISPOSABLE=true for an isolated test deployment' });
    assert.doesNotThrow(() => requireDisposable({ DELEGATION_DISPOSABLE: 'true' }));
});

test('artifact scan catches full JWTs while permitting header/payload audit redaction', () => {
    const prefix = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9';
    assert.equal(containsFullJwt(`failure token=${prefix}.abcdefghijklmnopqrs`), true);
    assert.equal(containsFullJwt(`{"access_token":"${prefix}.abcdefghijklmnopqrs"}`), true);
    assert.equal(containsFullJwt(`redacted token=${prefix}`), false);
    assert.equal(containsFullJwt('status 401; credentials withheld'), false);
});

test('artifact CLI fails closed and never prints matched credentials or file contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'delegation-scan-'));
    const cli = fileURLToPath(new URL('./scan-artifacts.mjs', import.meta.url));
    const leaked = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.abcdefghijklmnopqrs';
    try {
        const clean = join(directory, 'clean.txt'); const unsafe = join(directory, 'unsafe.txt');
        writeFileSync(clean, 'status 401; token contents withheld'); writeFileSync(unsafe, leaked);
        const run = files => spawnSync(process.execPath, [cli, ...files], { encoding: 'utf8' });
        assert.equal(run([clean]).status, 0);
        const failure = run([unsafe]); assert.equal(failure.status, 1);
        assert.ok(failure.stderr.includes('values withheld'));
        assert.ok(!failure.stderr.includes(leaked));
        assert.equal(run([]).status, 1);
        assert.equal(run([join(directory, 'missing.txt')]).status, 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
