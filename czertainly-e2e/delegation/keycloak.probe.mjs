import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionKeycloak } from './keycloak.mjs';
import { claims, requireDisposable } from './helpers.mjs';

test('Keycloak 26.8.1 issues a real RFC8693 client delegation token', async t => {
    requireDisposable(process.env);
    for (const name of ['DELEGATION_KEYCLOAK_URL', 'DELEGATION_KEYCLOAK_ADMIN_USERNAME', 'DELEGATION_KEYCLOAK_ADMIN_PASSWORD']) {
        assert.ok(process.env[name], `Missing ${name}`);
    }
    const fixture = await provisionKeycloak({
        url: process.env.DELEGATION_KEYCLOAK_URL, username: 'delegation-probe',
        adminUsername: process.env.DELEGATION_KEYCLOAK_ADMIN_USERNAME, adminPassword: process.env.DELEGATION_KEYCLOAK_ADMIN_PASSWORD,
    });
    t.after(() => fixture.dispose());
    const subject = claims(fixture.subjectToken); const delegated = claims(fixture.delegateToken);
    assert.ok(subject.act === undefined, 'Own access token has no actor');
    assert.ok(subject.may_act?.sub === fixture.actorSubject, 'may_act binds the provisioned service account');
    assert.ok(delegated.sub === fixture.subjectId, 'Exchange retains the user as subject');
    assert.ok(subject.preferred_username === 'delegation-probe' && delegated.preferred_username === 'delegation-probe', 'Both tokens expose the configured product username claim');
    assert.ok(delegated.act?.client_id === fixture.actorClientId, 'Exchange identifies the delegate client');
    assert.ok(delegated.act?.sub === fixture.actorSubject, 'Exchange identifies the service account');
    assert.ok(delegated.iss === fixture.issuer, 'Exchange uses the real issuer');
    assert.ok([delegated.aud].flat().includes(fixture.actorClientId), 'Exchange includes the configured audience');
});
