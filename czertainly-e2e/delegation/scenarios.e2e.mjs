import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { claims, signer, requireDisposable, timestampStatus } from './helpers.mjs';
import { provisionKeycloak } from './keycloak.mjs';
import { product } from './product.mjs';

test('RFC8693 delegation release gate (issue 118)', { timeout: 300_000 }, async t => {
    requireDisposable(process.env);
    const required = ['DELEGATION_BASE_URL', 'DELEGATION_ADMIN_TOKEN', 'DELEGATION_USERNAME', 'DELEGATION_USER_UUID',
        'DELEGATION_API_PATH', 'DELEGATION_TSP_PATH', 'DELEGATION_KEYCLOAK_URL', 'DELEGATION_KEYCLOAK_ADMIN_USERNAME', 'DELEGATION_KEYCLOAK_ADMIN_PASSWORD'];
    for (const name of required) assert.ok(process.env[name], `Missing ${name}`);
    for (const name of ['DELEGATION_API_PATH', 'DELEGATION_TSP_PATH']) {
        assert.ok(process.env[name].startsWith('/api/v1/') && !process.env[name].includes('?'), `${name} must be a relative /api/v1/ path without a query`);
    }
    const env = process.env;
    const api = product(env.DELEGATION_BASE_URL, env.DELEGATION_ADMIN_TOKEN, env.DELEGATION_CSV_SEPARATOR || ',');
    const names = new Set(); let kc;
    // Cleanup is a gate even after failed assertions. Never use a global settings replacement.
    t.after(async () => {
        const failures = [];
        for (const name of names) {
            try { await api.removeProvider(name); } catch { failures.push(`Provider cleanup failed: ${name}`); }
        }
        if (kc) { try { await kc.dispose(); } catch { failures.push('Keycloak realm cleanup failed'); } }
        assert.ok(failures.length === 0, failures.join('; '));
    });
    kc = await provisionKeycloak({ url: env.DELEGATION_KEYCLOAK_URL, username: env.DELEGATION_USERNAME,
        adminUsername: env.DELEGATION_KEYCLOAK_ADMIN_USERNAME, adminPassword: env.DELEGATION_KEYCLOAK_ADMIN_PASSWORD });
    const subject = claims(kc.subjectToken); const delegated = claims(kc.delegateToken);
    assert.ok(subject.may_act?.client_id === kc.actorClientId && delegated.act?.sub === kc.actorSubject, 'Real Keycloak exchange must produce the provisioned actor');
    assert.ok(delegated.sub === subject.sub && delegated.sub === kc.subjectId, 'Exchange must retain the user subject');
    const prefix = `delegation-${randomUUID()}`;
    const kcName = `${prefix}-keycloak`; const signedName = `${prefix}-signed`;
    const audience = 'delegation-fixtures'; const outer = `${prefix}-outer`; const custom = `${prefix}-custom`;
    const signedIssuer = `https://${prefix}.example.test`;
    const issue = signer(signedIssuer, env.DELEGATION_USERNAME, audience);
    const secrets = [env.DELEGATION_ADMIN_TOKEN, kc.subjectToken, kc.delegateToken];
    const kcSettings = { issuerUrl: kc.issuer, jwkSetUrl: `${kc.issuer}/protocol/openid-connect/certs`, clientId: kc.actorClientId,
        usernameClaim: 'preferred_username', audiences: [kc.actorClientId], allowedDelegates: [kc.actorClientId], delegateClaim: 'client_id' };
    const signedSettings = { issuerUrl: signedIssuer, jwkSet: issue.jwkSet, clientId: audience, audiences: [audience],
        usernameClaim: 'preferred_username', allowedDelegates: [outer], delegateClaim: 'client_id' };
    const put = async (name, settings) => { names.add(name); await api.provider(name, settings); };
    const signed = act => { const token = issue.token(act); secrets.push(token); return token; };
    const noCredential = value => {
        const text = JSON.stringify(value);
        assert.ok(secrets.every(token => !text.includes(token) && (!token.split('.')[2] || !text.includes(token.split('.')[2]))), 'Audit/export must omit full bearer tokens and signatures');
    };
    const userRecorded = (logs, identifier, actorSubject) => {
        noCredential(logs);
        assert.ok(logs.some(log => log.actor?.type === 'user' && log.actor?.uuid === env.DELEGATION_USER_UUID
            && log.actor?.name === env.DELEGATION_USERNAME && log.operationResult === 'success'
            && (identifier === undefined ? log.actor.delegate == null : log.actor.delegate?.identifier === identifier
                && log.actor.delegate?.subject === actorSubject && log.actor.delegate?.act === undefined)), 'Audit must attribute the operation to the user and expected outer delegate');
    };
    const refusal = async (token, provider, identifier, path = env.DELEGATION_API_PATH, tsp = false) => {
        const watermark = await api.watermark();
        const response = await api.invoke(path, token, tsp);
        assert.ok(response.status === 401, 'Delegation refusal must affect the next request with HTTP 401');
        const logs = await api.auditFailure(watermark, provider, identifier); noCredential(logs);
        assert.ok(logs.some(log => log.operationResult === 'failure' && log.message?.includes(provider) && log.message?.includes(identifier)), 'Refusal audit must name the provider and delegate');
    };

    let delegatedAudit;
    await t.test('1: real Keycloak exchange succeeds as user and records client delegate', async () => {
        await put(kcName, kcSettings);
        const response = await api.invoke(env.DELEGATION_API_PATH, kc.delegateToken);
        assert.ok(response.status === 200, 'Delegated API operation must succeed');
        delegatedAudit = await api.audit(response.marker);
        userRecorded(delegatedAudit, kc.actorClientId, kc.actorSubject);
    });
    await t.test('3: own user token records no delegate after a delegated request', async () => {
        const response = await api.invoke(env.DELEGATION_API_PATH, kc.subjectToken);
        assert.ok(response.status === 200, 'Own user API operation must succeed');
        userRecorded(await api.audit(response.marker));
    });
    if (env.DELEGATION_DENIED_API_PATH) await t.test('2: manual permission evidence helper compares own and delegated denial', async () => {
        assert.ok(env.DELEGATION_DENIED_API_PATH.startsWith('/api/v1/') && !env.DELEGATION_DENIED_API_PATH.includes('?'), 'Denied operation must be a relative /api/v1/ path without a query');
        const own = await api.invoke(env.DELEGATION_DENIED_API_PATH, kc.subjectToken);
        const delegate = await api.invoke(env.DELEGATION_DENIED_API_PATH, kc.delegateToken);
        assert.ok(own.status === 403 && delegate.status === 403, 'Both tokens must receive HTTP 403 for the forbidden operation');
    });
    await t.test('4: removing allowlist entry immediately refuses token and audits provider/delegate', async () => {
        await put(kcName, { ...kcSettings, allowedDelegates: [] });
        await refusal(kc.delegateToken, kcName, kc.actorClientId);
    });
    await t.test('5: a newly created provider with no allowlist refuses delegation', async () => {
        const { allowedDelegates, ...withoutAllowlist } = signedSettings;
        await put(signedName, withoutAllowlist);
        await refusal(signed({ client_id: outer, sub: 'outer-service-account' }), signedName, outer);
    });
    await t.test('6: signed malformed actors are refused; only the outermost nested actor is recorded', async () => {
        await put(signedName, signedSettings);
        for (const act of ['not-an-object', [], null, {}, { sub: 'missing-client' }, { client_id: 7 }]) {
            const response = await api.invoke(env.DELEGATION_API_PATH, signed(act));
            assert.ok(response.status === 401, 'Signed malformed act must be rejected');
        }
        const response = await api.invoke(env.DELEGATION_API_PATH, signed({ client_id: outer, sub: 'outer-service-account', act: { client_id: 'unlisted-inner', sub: 'inner-service-account' } }));
        assert.ok(response.status === 200, 'Only outer actor controls delegation');
        userRecorded(await api.audit(response.marker), outer, 'outer-service-account');
    });
    await t.test('7: custom delegate claim determines the allowed and recorded identifier', async () => {
        await put(signedName, { ...signedSettings, allowedDelegates: [custom], delegateClaim: 'application_id' });
        const response = await api.invoke(env.DELEGATION_API_PATH, signed({ application_id: custom, client_id: 'unlisted-client', sub: 'custom-service-account' }));
        assert.ok(response.status === 200, 'Custom delegate claim must be used');
        userRecorded(await api.audit(response.marker), custom, 'custom-service-account');
    });
    await t.test('8: TSP accepts delegation, preserves ordinary attribution and refuses removed/malformed actors', async () => {
        await put(kcName, kcSettings);
        for (const [token, identifier, actorSubject] of [[kc.delegateToken, kc.actorClientId, kc.actorSubject], [kc.subjectToken, undefined, undefined]]) {
            const response = await api.invoke(env.DELEGATION_TSP_PATH, token, true);
            assert.ok(response.status === 200 && response.body.length > 20 && [0, 1].includes(timestampStatus(response.body)), 'TSP must return a granted RFC3161 timestamp');
            userRecorded(await api.audit(response.marker), identifier, actorSubject);
        }
        await put(kcName, { ...kcSettings, allowedDelegates: [] });
        await refusal(kc.delegateToken, kcName, kc.actorClientId, env.DELEGATION_TSP_PATH, true);
        await put(signedName, signedSettings);
        const malformed = await api.invoke(env.DELEGATION_TSP_PATH, signed('not-an-object'), true);
        assert.ok(malformed.status === 401, 'TSP must refuse malformed signed act');
    });
    await t.test('9: delegate filter and ZIP/CSV export select only matching delegates', async () => {
        const groups = await api.searchable();
        assert.ok(groups.some(group => group.searchFieldData?.some(field => field.fieldIdentifier === 'AUDIT_LOG_ACTOR_DELEGATE_IDENTIFIER')), 'Delegate must be searchable');
        const filtered = await api.filtered(kc.actorClientId); noCredential(filtered);
        assert.ok(filtered.items.length > 0 && filtered.items.every(log => log.actor?.delegate?.identifier === kc.actorClientId), 'Delegate filter must exclude ordinary and other delegate records');
        assert.ok(delegatedAudit?.some(original => filtered.items.some(log => log.id === original.id)), 'Filter must include the real Keycloak operation');
        const rows = await api.export(kc.actorClientId); noCredential(rows);
        assert.ok(rows.length > 0 && rows.every(row => row.actorDelegateIdentifier === kc.actorClientId && row.actorDelegateSubject === kc.actorSubject), 'Export must contain matching delegate identifier and subject columns');
    });
});
