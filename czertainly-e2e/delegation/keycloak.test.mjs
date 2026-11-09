import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { provisionKeycloak } from './keycloak.mjs';

test('realm provisioning binds may_act to the real service account and exchanges both tokens; cleanup removes realm', async () => {
    let realm; let mapper; let deleted = 0; let exchange;
    const server = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/admin/serverinfo') { res.end('{"systemInfo":{"version":"26.8.1"}}'); return; }
        if (req.url === '/admin/realms') { realm = JSON.parse(raw); res.writeHead(201).end(); return; }
        if (req.method === 'DELETE') { deleted++; res.writeHead(204).end(); return; }
        if (req.url.endsWith('/service-account-user')) { res.end('{"id":"service-account-uuid"}'); return; }
        if (req.url.endsWith('/protocol-mappers/models')) { mapper = JSON.parse(raw); res.writeHead(201).end(); return; }
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:token-exchange') {
            exchange = form; res.end('{"access_token":"delegated"}'); return;
        }
        res.end(JSON.stringify({ access_token: form.get('grant_type') === 'client_credentials' ? 'actor' : 'subject' }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const fixture = await provisionKeycloak({ url: `http://127.0.0.1:${server.address().port}`, username: 'alice', adminUsername: 'admin', adminPassword: 'test-only' });
        assert.equal(realm.users[0].username, 'alice');
        assert.equal(realm.clients[0].serviceAccountsEnabled, true);
        assert.equal(realm.clients[0].attributes['standard.token.exchange.enabled'], 'true');
        assert.deepEqual(JSON.parse(mapper.config['claim.value']), { sub: 'service-account-uuid', client_id: fixture.actorClientId });
        assert.equal(mapper.config['jsonType.label'], 'JSON');
        assert.equal(exchange.get('subject_token'), 'subject');
        assert.equal(exchange.get('actor_token'), 'actor');
        assert.equal(exchange.get('actor_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
        assert.equal(fixture.delegateToken, 'delegated');
        assert.equal(fixture.subjectToken, 'subject');
        assert.equal(fixture.actorSubject, 'service-account-uuid');
        await fixture.dispose(); assert.equal(deleted, 1);
        const subsequent = await provisionKeycloak({ url: `http://127.0.0.1:${server.address().port}`, username: 'alice', adminUsername: 'admin', adminPassword: 'test-only' });
        try { assert.notEqual(subsequent.actorClientId, fixture.actorClientId, 'Repeated runs must not share a delegate audit filter'); }
        finally { await subsequent.dispose(); }
        assert.equal(deleted, 2);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('wrong Keycloak version fails before mutation; partial provisioning failure removes its realm', async () => {
    let wrongVersion = true; let deletes = 0;
    const server = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/token')) res.end('{"access_token":"admin"}');
        else if (req.url === '/admin/serverinfo') res.end(JSON.stringify({ systemInfo: { version: wrongVersion ? '26.7.0' : '26.8.1' } }));
        else if (req.url === '/admin/realms') res.writeHead(201).end();
        else if (req.method === 'DELETE') { deletes++; res.writeHead(204).end(); }
        else res.writeHead(500).end('credential that must never surface');
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const options = { url: `http://127.0.0.1:${server.address().port}`, username: 'alice', adminUsername: 'admin', adminPassword: 'test-only' };
    try {
        await assert.rejects(provisionKeycloak(options), { message: 'Delegation fixture requires Keycloak 26.8.1' });
        assert.equal(deletes, 0); wrongVersion = false;
        await assert.rejects(provisionKeycloak(options), /status 500; contents withheld/);
        assert.equal(deletes, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('missing tokens are refused and failed partial-realm cleanup fails the gate', async () => {
    let missingToken = true;
    const server = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/token')) res.end(missingToken ? '{}' : '{"access_token":"admin"}');
        else if (req.url === '/admin/serverinfo') res.end('{"systemInfo":{"version":"26.8.1"}}');
        else if (req.url === '/admin/realms') res.writeHead(201).end();
        else res.writeHead(500).end('secret-body');
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const options = { url: `http://127.0.0.1:${server.address().port}`, username: 'alice', adminUsername: 'admin', adminPassword: 'test-only' };
    try {
        await assert.rejects(provisionKeycloak(options), { message: 'Missing access token (contents withheld)' });
        missingToken = false;
        await assert.rejects(provisionKeycloak(options), { message: 'Keycloak provisioning and realm cleanup failed (contents withheld)' });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
