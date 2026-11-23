/**
 * delegation — Epic ilm#486: RFC 8693 delegation tokens, the scenarios of automated-testing-framework#118 (ported from
 * the draft in automated-testing-framework#119). Scenario 8 (the timestamping endpoint) needs a TSP profile and is not
 * here yet; 10 (UI) and 11 (no token in logs) stay manual.
 *
 * Every test changes platform-wide state (the audit log settings and the run's own OAuth2 providers): @exclusive,
 * serial, everything restored or removed in afterAll. The real Keycloak exchange runs in a disposable realm of the
 * platform's Keycloak and needs KC_DELEGATION_ADMIN_USERNAME / KC_DELEGATION_ADMIN_PASSWORD (a master-realm user with
 * only the create-realm role); without them those scenarios skip. The other scenarios sign their own tokens.
 */
import { test, expect, request as playwrightRequest, APIRequestContext } from '@playwright/test';
import { loadEnv, TestEnv } from '../../../utils/env';
import { uniqueName } from '../../../utils/names';
import { requiredCustomAttributes } from '../../../utils/regression/customAttributes';
import { adminApi, Cleanup, Json, sendOk } from '../../../utils/epicOwnership';
import {
    auditFilteredByDelegate, auditOf, auditSearchFields, auditWatermark, claims, DELEGATE_FIELD, DelegationRealm, enableFullAudit,
    exportByDelegate, invoke, Invocation, leaksToken, newSigner, provisionDelegationRealm, providersStartingWith, putProvider,
    refusalAudit, removeProvider, restoreLogging, settingsSpread, Signer, untilStatus,
} from '../../../utils/epicDelegation';

const TAGS = ['@epic-486', '@exclusive', '@regression'];
const PROVIDER_PREFIX = 'qa-e486-';
/** A read the run's user may do (settings detail), audited when the audit log records every resource. */
const ALLOWED_PATH = '/api/v1/settings/platform';
/** A read the run's user may not do (no connector permission). */
const DENIED_PATH = '/api/v1/connectors';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const run = uniqueName('e486').toLowerCase();
const kcProvider = `${PROVIDER_PREFIX}${run}-keycloak`;
const signedProvider = `${PROVIDER_PREFIX}${run}-signed`;
const audience = `${run}-fixtures`;
const outer = `${run}-outer`;
const custom = `${run}-custom`;

let env: TestEnv;
let grant: APIRequestContext;
let admin: APIRequestContext;
let originalLogging: Json | undefined;
let user: { uuid: string; username: string };
let kc: DelegationRealm | undefined;
let signer: Signer;
let kcSettings: Json;
let signedSettings: Json;
/** A delegate that has a successful audit record in this run, for the filter and export scenario. */
let recorded: { identifier: string; subject: string; ids: string[] } | undefined;
const providers = new Set<string>();
const issued: string[] = [];
const cleanup = new Cleanup();

const call = async (path: string, token: string): Promise<Invocation> => invoke(env.baseUrl, path, token);
const signed = (act?: unknown): string => {
    const token = signer.token(user.username, act);
    issued.push(token);
    return token;
};
const put = async (name: string, settings: Json): Promise<void> => {
    providers.add(name);
    await putProvider(admin, name, settings);
};
const keycloakOnly = (): void => test.skip(!kc, 'no Keycloak admin for the disposable realm (KC_DELEGATION_ADMIN_USERNAME / _PASSWORD not set)');

/** The marked request's audit record shows the run's user as actor, with the given outermost delegate or none. */
async function expectAttributed(request: Invocation, delegate?: { identifier: string; subject: string }): Promise<Json[]> {
    const records = await auditOf(admin, request);
    expect(leaksToken(records, issued), 'the audit record holds no bearer token or signature').toBe(false);
    const mine = records.filter((r) => r.operationResult === 'success' && r.actor?.type === 'user' && r.actor?.uuid === user.uuid);
    expect(mine.length, `a successful record of request ${request.marker} names the user ${user.username}`).toBeGreaterThan(0);
    for (const r of mine) {
        if (delegate) {
            expect(r.actor.delegate?.identifier, 'the delegate identifier').toBe(delegate.identifier);
            expect(r.actor.delegate?.subject, 'the delegate subject').toBe(delegate.subject);
        } else {
            expect(r.actor.delegate ?? null, 'no delegate on the user\'s own request').toBeNull();
        }
    }
    return mine;
}

/** The token is refused with 401 on every Core instance, and a failure record names the provider and the delegate. */
async function expectRefused(token: string, provider: string, delegate: string): Promise<void> {
    await settingsSpread();
    const watermark = await auditWatermark(admin);
    await untilStatus(() => call(ALLOWED_PATH, token), 401, `delegate ${delegate} through ${provider}`);
    const records = await refusalAudit(admin, watermark, provider, delegate);
    expect(leaksToken(records, issued), 'the refusal record holds no bearer token or signature').toBe(false);
}

test.beforeAll(async () => {
    test.setTimeout(120_000);
    env = loadEnv();
    grant = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    admin = adminApi(grant, env);
    // read first: afterAll puts back only what was read
    originalLogging = await enableFullAudit(admin);
    for (const stale of await providersStartingWith(admin, PROVIDER_PREFIX)) await removeProvider(admin, stale);

    const role = (await sendOk(admin, 'POST', '/api/v1/roles', {
        name: `${run}-role`, description: 'Epic ilm#486: settings detail only',
        customAttributes: await requiredCustomAttributes(admin, 'roles', run),
    })).json as Json;
    cleanup.add('role', role.name, () => sendOk(admin, 'DELETE', `/api/v1/roles/${role.uuid}`));
    await sendOk(admin, 'POST', `/api/v1/roles/${role.uuid}/permissions`, {
        allowAllResources: false, resources: [{ name: 'settings', allowAllActions: false, actions: ['detail'] }],
    });
    const username = `${run}-user`;
    const created = (await sendOk(admin, 'POST', '/api/v1/users', {
        username, firstName: 'QA', lastName: 'Delegation', email: `${username}@example.test`, enabled: true,
        description: 'Epic ilm#486 test user', groupUuids: [], customAttributes: await requiredCustomAttributes(admin, 'users', username),
    })).json as Json;
    user = { uuid: created.uuid as string, username };
    cleanup.add('user', username, () => sendOk(admin, 'DELETE', `/api/v1/users/${user.uuid}`));
    await sendOk(admin, 'PATCH', `/api/v1/users/${user.uuid}/roles`, [role.uuid]);

    signer = newSigner(`https://${run}.example.test`, audience);
    signedSettings = { issuerUrl: signer.issuer, jwkSet: signer.jwkSet, audiences: [audience], allowedDelegates: [outer], delegateClaim: 'client_id' };

    const kcAdmin = process.env.KC_DELEGATION_ADMIN_USERNAME;
    const kcPassword = process.env.KC_DELEGATION_ADMIN_PASSWORD;
    if (kcAdmin && kcPassword) {
        if (!env.authBaseUrl) throw new Error('AUTH_BASE_URL is not set, so the platform\'s Keycloak is unknown');
        kc = await provisionDelegationRealm({ keycloakUrl: env.authBaseUrl, adminUsername: kcAdmin, adminPassword: kcPassword, realm: `${run}-realm`, username });
        issued.push(kc.subjectToken, kc.delegateToken);
        kcSettings = {
            issuerUrl: kc.issuer, jwkSet: kc.jwkSet, usernameClaim: 'preferred_username', audiences: [kc.actorClientId],
            allowedDelegates: [kc.actorClientId], delegateClaim: 'client_id',
        };
    }
});

test.afterAll(async () => {
    test.setTimeout(120_000);
    const failures: string[] = [];
    const attempt = async (what: string, step: () => Promise<unknown>): Promise<void> => {
        try {
            await step();
        } catch (e) {
            failures.push(`${what}: ${String(e)}`);
        }
    };
    if (admin) for (const name of providers) await attempt(`provider ${name}`, () => removeProvider(admin, name));
    if (kc) await attempt('Keycloak realm', () => kc!.dispose());
    if (admin) await attempt('users and roles', () => cleanup.run(admin));
    if (admin && originalLogging) await attempt('logging settings', () => restoreLogging(admin, originalLogging!));
    await admin?.dispose();
    await grant?.dispose();
    if (failures.length) throw new Error(`Cleanup failed: ${failures.join('; ')}`);
});

test.describe('RFC 8693 delegation tokens', { tag: TAGS }, () => {
    test('1: a real Keycloak delegation token is accepted as the user, and the audit names the client as delegate', async () => {
        keycloakOnly();
        const exchanged = claims(kc!.delegateToken);
        expect(exchanged.sub, 'the exchange keeps the user as subject').toBe(claims(kc!.subjectToken).sub);
        expect(exchanged.act?.sub, 'the exchange names the actor\'s service account').toBe(kc!.actorSubject);
        await put(kcProvider, kcSettings);
        const accepted = await untilStatus(() => call(ALLOWED_PATH, kc!.delegateToken), 200, 'the delegation token');
        const records = await expectAttributed(accepted, { identifier: kc!.actorClientId, subject: kc!.actorSubject });
        recorded = { identifier: kc!.actorClientId, subject: kc!.actorSubject, ids: records.map((r) => String(r.id)) };
    });

    test('3: after a delegated request, the user\'s own token records no delegate', async () => {
        keycloakOnly();
        const own = await call(ALLOWED_PATH, kc!.subjectToken);
        expect(own.status, 'the user\'s own token').toBe(200);
        await expectAttributed(own);
    });

    test('2: a delegation token has the user\'s permissions, no more: both tokens are denied a read the user may not do', async () => {
        keycloakOnly();
        expect((await call(DENIED_PATH, kc!.subjectToken)).status, 'the user\'s own token').toBe(403);
        expect((await call(DENIED_PATH, kc!.delegateToken)).status, 'the delegation token').toBe(403);
    });

    test('4: a delegate removed from the provider is refused with 401, and the refusal names provider and delegate', async () => {
        keycloakOnly();
        await put(kcProvider, { ...kcSettings, allowedDelegates: [] });
        await expectRefused(kc!.delegateToken, kcProvider, kc!.actorClientId);
    });

    test('5: a provider without allowed delegates refuses a delegation token', async () => {
        const { allowedDelegates: _none, ...withoutDelegates } = signedSettings;
        await put(signedProvider, withoutDelegates);
        await expectRefused(signed({ client_id: outer, sub: 'outer-service-account' }), signedProvider, outer);
    });

    test('6: a malformed act is refused; of nested actors only the outermost decides and is recorded', async () => {
        await put(signedProvider, signedSettings);
        const nested = await untilStatus(
            () => call(ALLOWED_PATH, signed({ client_id: outer, sub: 'outer-service-account', act: { client_id: 'unlisted-inner', sub: 'inner-service-account' } })),
            200, 'a nested act with an allowed outer delegate');
        const records = await expectAttributed(nested, { identifier: outer, subject: 'outer-service-account' });
        recorded ??= { identifier: outer, subject: 'outer-service-account', ids: records.map((r) => String(r.id)) };
        for (const act of ['not-an-object', [], null, {}, { sub: 'missing-client' }, { client_id: 7 }]) {
            expect((await call(ALLOWED_PATH, signed(act))).status, `act ${JSON.stringify(act)}`).toBe(401);
        }
    });

    test('7: a custom delegate claim decides which delegate is allowed and recorded', async () => {
        await put(signedProvider, { ...signedSettings, allowedDelegates: [custom], delegateClaim: 'application_id' });
        const accepted = await untilStatus(
            () => call(ALLOWED_PATH, signed({ application_id: custom, client_id: 'unlisted-client', sub: 'custom-service-account' })),
            200, 'the custom delegate claim');
        await expectAttributed(accepted, { identifier: custom, subject: 'custom-service-account' });
    });

    test('9: the audit log filters and exports by delegate', async () => {
        test.skip(!recorded, 'no delegated request was recorded earlier in this run');
        expect(await auditSearchFields(admin), 'the delegate is a search field').toContain(DELEGATE_FIELD);
        const filtered = await auditFilteredByDelegate(admin, recorded!.identifier);
        expect(leaksToken(filtered, issued), 'the filtered records hold no bearer token').toBe(false);
        expect(filtered.length, 'the filter finds records').toBeGreaterThan(0);
        expect(filtered.filter((r) => r.actor?.delegate?.identifier !== recorded!.identifier), 'only records of that delegate').toEqual([]);
        expect(filtered.map((r) => String(r.id)), 'the run\'s delegated request is among them').toEqual(expect.arrayContaining(recorded!.ids));
        const rows = await exportByDelegate(admin, recorded!.identifier);
        expect(leaksToken(rows, issued), 'the export holds no bearer token').toBe(false);
        expect(rows.length, 'the export has rows').toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.actorDelegateIdentifier, 'export column actorDelegateIdentifier').toBe(recorded!.identifier);
            expect(row.actorDelegateSubject, 'export column actorDelegateSubject').toBe(recorded!.subject);
        }
    });
});
