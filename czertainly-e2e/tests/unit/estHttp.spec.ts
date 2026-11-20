/**
 * Unit tests for the raw EST client: how a request is built, and one real round trip against a
 * local TLS server to cover the send path, including a client certificate and an edge verified against its CA.
 */
import { test, expect } from '@playwright/test';
import * as https from 'https';
import { AddressInfo } from 'net';
import { buildEstRequest, decodeBase64Body, estPath, estRequest } from '../../utils/estHttp';
import { certToPem, createCa, issueCert, keyToPem } from '../../utils/estPki';

const BASE = 'https://ilm.example.com:8443';

test('the path has an optional label', () => {
    expect(estPath(undefined, 'cacerts')).toBe('/.well-known/est/cacerts');
    expect(estPath('lab', 'simpleenroll')).toBe('/.well-known/est/lab/simpleenroll');
});

test('a bodyless request is a GET on the operation, SNI set to the host', () => {
    const { options, body } = buildEstRequest({ baseUrl: BASE, op: 'cacerts' });
    expect(options.method).toBe('GET');
    expect(options.hostname).toBe('ilm.example.com');
    expect(options.port).toBe('8443');
    expect(options.path).toBe('/.well-known/est/cacerts');
    expect(options.servername).toBe('ilm.example.com');
    expect(options.rejectUnauthorized).toBeUndefined();
    expect(options.cert).toBeUndefined();
    expect(body.length).toBe(0);
});

test('label, query, body, Basic auth and extra headers are all carried', () => {
    const { options, body } = buildEstRequest({
        baseUrl: 'https://ilm.example.com',
        op: 'simpleenroll',
        label: 'lab',
        query: { a: '1', b: 'x y' },
        contentType: 'application/pkcs10',
        body: 'QUJD',
        basicAuth: { username: 'u', password: 'p' },
        headers: { 'ssl-client-cert': 'forged' },
    });
    expect(options.method).toBe('POST');
    expect(options.port).toBe(443);
    expect(options.path).toBe('/.well-known/est/lab/simpleenroll?a=1&b=x+y');
    const headers = options.headers as Record<string, string | number>;
    expect(headers['Content-Type']).toBe('application/pkcs10');
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(headers['ssl-client-cert']).toBe('forged');
    expect(headers['Content-Length']).toBe(4);
    expect(body.toString()).toBe('QUJD');
});

test('an explicit method wins and a client certificate is passed on', () => {
    const { options } = buildEstRequest({
        baseUrl: BASE,
        op: 'csrattrs',
        method: 'POST',
        clientCert: { cert: 'CERT', key: 'KEY' },
    });
    expect(options.method).toBe('POST');
    expect(options.cert).toBe('CERT');
    expect(options.key).toBe('KEY');
});

test('the edge CA given is the one the connection trusts', () => {
    const { options } = buildEstRequest({ baseUrl: BASE, op: 'cacerts', ca: 'EDGE CA' });
    expect(options.ca).toBe('EDGE CA');
    expect(options.rejectUnauthorized).toBeUndefined();
});

test('base64 bodies decode across CRLF and whitespace', () => {
    expect(decodeBase64Body(Buffer.from('QUJD\r\nREVG\r\n')).toString()).toBe('ABCDEF');
    expect(decodeBase64Body(' QU JD ').toString()).toBe('ABC');
    expect(decodeBase64Body('QQ==').toString()).toBe('A');
    expect(decodeBase64Body('').length).toBe(0);
});

test('base64 bodies with a foreign character or bad padding are rejected without echoing the text', () => {
    for (const bad of ['QU!JD', 'QUJ', 'QQ=', 'Q===', 'QQ==QUJD', 'QU-_', 'caf\u00e9']) {
        expect(() => decodeBase64Body(bad), bad).toThrow(/^Invalid base64: \d+ characters$/);
    }
});

test('the brackets of an IPv6 literal are not part of the host name, and no SNI is sent for it', () => {
    const { options } = buildEstRequest({ baseUrl: 'https://[::1]:8443', op: 'cacerts' });
    expect(options.hostname).toBe('::1');
    expect(options.servername).toBeUndefined();
});

test('a request that outlives its deadline is destroyed and rejects', async () => {
    const ca = createCa({ cn: 'http-test-ca' });
    const server = issueCert(ca, { subject: 'localhost', sans: ['localhost'] });
    const srv = https.createServer({ cert: certToPem(server.cert), key: keyToPem(server.key) }, () => {
        // never answers
    });
    await new Promise<void>((resolve) => srv.listen(0, 'localhost', resolve));
    try {
        const { port } = srv.address() as AddressInfo;
        await expect(
            estRequest({ baseUrl: `https://localhost:${port}`, op: 'cacerts', ca: certToPem(ca.cert), timeoutMs: 200 }),
        ).rejects.toThrow(/timed out after 200 ms/);
    } finally {
        srv.closeAllConnections();
        srv.close();
    }
});

test('a request round-trips to a TLS server that asks for a client certificate', async () => {
    const ca = createCa({ cn: 'http-test-ca' });
    const server = issueCert(ca, { subject: 'localhost', sans: ['localhost'] });
    const client = issueCert(ca, { subject: 'client' });

    const srv = https.createServer(
        { cert: certToPem(server.cert), key: keyToPem(server.key), ca: certToPem(ca.cert), requestCert: true },
        (req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                const peer = (req.socket as import('tls').TLSSocket).getPeerCertificate();
                res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Multi': ['a', 'b'] });
                res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()} peer=${peer.subject?.CN}`);
            });
        },
    );
    await new Promise<void>((resolve) => srv.listen(0, 'localhost', resolve));
    try {
        const { port } = srv.address() as AddressInfo;
        const resp = await estRequest({
            baseUrl: `https://localhost:${port}`,
            op: 'simpleenroll',
            body: 'hello',
            clientCert: { cert: certToPem(client.cert), key: keyToPem(client.key) },
            ca: certToPem(ca.cert),
        });
        expect(resp.status).toBe(200);
        expect(resp.headers['content-type']).toBe('text/plain');
        expect(resp.headers['x-multi']).toBe('a, b');
        expect(resp.body.toString()).toBe('POST /.well-known/est/simpleenroll hello peer=client');
    } finally {
        srv.close();
    }
});

test('a connection failure rejects', async () => {
    await expect(estRequest({ baseUrl: 'https://127.0.0.1:1', op: 'cacerts' })).rejects.toThrow();
});

test('a response cut off mid-body rejects', async () => {
    const ca = createCa({ cn: 'http-test-ca' });
    const server = issueCert(ca, { subject: 'localhost', sans: ['localhost'] });

    const srv = https.createServer({ cert: certToPem(server.cert), key: keyToPem(server.key) }, (req, res) => {
        res.writeHead(200, { 'Content-Length': 100 });
        res.write('partial', () => req.socket.destroy());
    });
    await new Promise<void>((resolve) => srv.listen(0, 'localhost', resolve));
    try {
        const { port } = srv.address() as AddressInfo;
        await expect(estRequest({ baseUrl: `https://localhost:${port}`, op: 'cacerts', ca: certToPem(ca.cert) })).rejects.toThrow(
            /aborted|socket hang up|ECONNRESET|premature/i,
        );
    } finally {
        srv.close();
    }
});
