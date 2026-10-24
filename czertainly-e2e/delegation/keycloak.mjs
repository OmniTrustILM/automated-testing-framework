import { randomUUID } from 'node:crypto';
import { http, json } from './helpers.mjs';

export const KEYCLOAK_VERSION = '26.8.1';

/** Only a disposable realm: the hardcoded may_act mapper deliberately bypasses production consent/FGAP setup. */
export async function provisionKeycloak({ url, username, adminUsername, adminPassword }) {
    url = url.replace(/\/$/, '');
    const token = async (realm, form) => {
        const data = await json(`${url}/realms/${realm}/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams(form) });
        if (typeof data.access_token !== 'string') throw new Error('Missing access token (contents withheld)');
        return data.access_token;
    };
    const admin = await token('master', { grant_type: 'password', client_id: 'admin-cli', username: adminUsername, password: adminPassword });
    const headers = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
    const info = await json(`${url}/admin/serverinfo`, { headers });
    if (info.systemInfo?.version !== KEYCLOAK_VERSION) throw new Error(`Delegation fixture requires Keycloak ${KEYCLOAK_VERSION}`);
    const realm = `delegation-${randomUUID()}`;
    // Audit records intentionally survive cleanup, so the identifier must isolate repeated runs too.
    const actorClientId = `${realm}-actor`; const subjectClientId = `${realm}-subject`;
    const actorId = randomUUID(); const subjectId = randomUUID(); const userId = randomUUID();
    const actorSecret = randomUUID(); const subjectSecret = randomUUID(); const password = randomUUID();
    const issuer = `${url}/realms/${realm}`;
    const base = `${url}/admin/realms/${realm}`;
    const dispose = async () => { await http(base, { method: 'DELETE', headers }, [204, 404]); };
    const audienceMapper = {
        name: 'actor-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
        config: { 'included.client.audience': actorClientId, 'access.token.claim': 'true' },
    };
    await http(`${url}/admin/realms`, { method: 'POST', headers, body: JSON.stringify({
        realm, enabled: true, sslRequired: 'none',
        clients: [
            { id: actorId, clientId: actorClientId, secret: actorSecret, protocol: 'openid-connect', publicClient: false,
                serviceAccountsEnabled: true, standardFlowEnabled: false, attributes: { 'standard.token.exchange.enabled': 'true' }, protocolMappers: [audienceMapper] },
            { id: subjectId, clientId: subjectClientId, secret: subjectSecret, protocol: 'openid-connect', publicClient: false,
                directAccessGrantsEnabled: true, standardFlowEnabled: false, protocolMappers: [audienceMapper] },
        ],
        users: [{ id: userId, username, enabled: true, emailVerified: true, firstName: 'Delegation', lastName: 'Fixture',
            email: 'delegation@example.test', credentials: [{ type: 'password', value: password, temporary: false }] }],
    }) });
    try {
        const actor = await json(`${base}/clients/${actorId}/service-account-user`, { headers });
        await http(`${base}/clients/${subjectId}/protocol-mappers/models`, { method: 'POST', headers, body: JSON.stringify({
            name: 'disposable-may-act', protocol: 'openid-connect', protocolMapper: 'oidc-hardcoded-claim-mapper',
            config: { 'claim.name': 'may_act', 'claim.value': JSON.stringify({ sub: actor.id, client_id: actorClientId }),
                'jsonType.label': 'JSON', 'access.token.claim': 'true' },
        }) });
        const subjectToken = await token(realm, { grant_type: 'password', client_id: subjectClientId, client_secret: subjectSecret, username, password, scope: 'openid' });
        const actorToken = await token(realm, { grant_type: 'client_credentials', client_id: actorClientId, client_secret: actorSecret });
        const delegateToken = await token(realm, { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            client_id: actorClientId, client_secret: actorSecret, subject_token: subjectToken, actor_token: actorToken,
            subject_token_type: 'urn:ietf:params:oauth:token-type:access_token', actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token' });
        return { issuer, actorClientId, actorSubject: actor.id, subjectId: userId, subjectToken, delegateToken, dispose };
    } catch (error) {
        try { await dispose(); }
        catch { throw new Error('Keycloak provisioning and realm cleanup failed (contents withheld)'); }
        throw error;
    }
}
