import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { product } from './product.mjs';

test('product boundary writes complete isolated provider settings and correlates audit by unique user agent', async () => {
    const calls = []; let lists = 0; let marker;
    const server = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: raw });
        if (req.url === '/api/v1/probe') { marker = req.headers['user-agent']; res.end('ok'); return; }
        if (req.url === '/api/v1/auditLogs/export') { res.end('actorDelegateIdentifier,actorName\nagent,alice\n'); return; }
        if (req.url === '/api/v1/auditLogs/search') { res.end('[{"filterFieldSource":"property","searchFieldData":[]}]'); return; }
        if (req.url === '/api/v1/auditLogs') {
            lists++;
            res.end(JSON.stringify({ items: lists === 1 ? [] : [{ source: { userAgent: marker }, actor: { name: 'alice' } }, { source: { userAgent: 'unrelated' } }] }));
            return;
        }
        // Core's void DELETE controller currently returns 200; OpenAPI's 204 annotation is descriptive.
        res.writeHead(req.method === 'DELETE' ? 200 : 204).end();
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const api = product(`http://127.0.0.1:${server.address().port}`, 'admin-test-token');
        await api.provider('fixture / name', { issuerUrl: 'https://issuer.example', allowedDelegates: ['agent'] });
        assert.equal(calls[0].path, '/api/v1/settings/authentication/oauth2Providers/fixture%20%2F%20name');
        assert.deepEqual(JSON.parse(calls[0].body), { issuerUrl: 'https://issuer.example', allowedDelegates: ['agent'] });
        const response = await api.invoke('/api/v1/probe', 'user-test-token');
        assert.equal(response.status, 200);
        assert.equal(calls[1].authorization, 'Bearer user-test-token');
        const logs = await api.audit(response.marker, 1000);
        assert.equal(logs.length, 1); assert.equal(logs[0].actor.name, 'alice');
        await api.filtered('agent');
        assert.deepEqual(JSON.parse(calls.at(-1).body).filters, [{ fieldSource: 'property', fieldIdentifier: 'AUDIT_LOG_ACTOR_DELEGATE_IDENTIFIER', condition: 'EQUALS', value: 'agent' }]);
        assert.deepEqual(await api.export('agent'), [{ actorDelegateIdentifier: 'agent', actorName: 'alice' }]);
        assert.equal((await api.searchable())[0].filterFieldSource, 'property');
        await api.removeProvider('fixture / name');
        assert.equal(calls.at(-1).method, 'DELETE');
        assert.equal(calls.at(-1).authorization, 'Bearer admin-test-token');
        await assert.rejects(api.audit('not-present', 1), { message: 'Audit record did not arrive for this request' });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('TSP call uses binary request with the supplied bearer and surfaces refusal status', async () => {
    const server = createServer(async (req, res) => {
        let size = 0; for await (const data of req) size += data.length;
        assert.equal(req.headers['content-type'], 'application/timestamp-query');
        assert.equal(req.headers.authorization, 'Bearer fixture');
        assert.equal(req.method, 'POST'); assert.equal(size, 59);
        res.writeHead(401).end();
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const api = product(`http://127.0.0.1:${server.address().port}`, 'admin');
        assert.equal((await api.invoke('/api/v1/protocols/tsp/profile', 'fixture', true)).status, 401);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('security-filter refusal audit without MVC source is correlated after a watermark, excluding stale and unrelated failures', async () => {
    let lists = 0;
    const server = createServer((req, res) => {
        lists++;
        res.end(JSON.stringify({ items: lists === 1 ? [{ id: 41 }] : [
            { id: 41, operationResult: 'failure', message: "provider 'fixture' refused delegate 'agent'" },
            { id: 42, operationResult: 'failure', message: "provider 'other' refused delegate 'agent'" },
            { id: 43, operationResult: 'failure', message: "provider 'fixture' refused delegate 'agent'", source: null },
        ] }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const api = product(`http://127.0.0.1:${server.address().port}`, 'admin');
        const watermark = await api.watermark(); assert.equal(watermark, 41);
        const records = await api.auditFailure(watermark, 'fixture', 'agent');
        assert.equal(records.length, 1); assert.equal(records[0].id, 43);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
