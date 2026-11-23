/**
 * delegation — Epic ilm#486, the RFC 8693 scenarios of #118 (ported from #119); S8 (TSP) is not here yet, S10–S11 are manual.
 * @exclusive: changes the audit settings and adds own OAuth2 providers, all restored in afterAll. The real exchange needs
 * KC_DELEGATION_ADMIN_USERNAME / _PASSWORD (a master-realm user with only create-realm); without them S1–S4 skip.
 */
import { test, expect, request as playwrightRequest, APIRequestContext } from '@playwright/test';
import { loadEnv, TestEnv } from '../../../utils/env';
import { uniqueName } from '../../../utils/names';
import { requiredCustomAttributes } from '../../../utils/regression/customAttributes';
import { adminApi, Cleanup, Json, sendOk } from '../../../utils/epicOwnership';
import {
    auditFilteredByDelegate, auditSearchFields, claims, DELEGATE_FIELD, DelegationRealm, enableFullAudit, expectAttributed, expectRefused,
    exportByDelegate, invoke, Invocation, leaksToken, newSigner, provisionDelegationRealm, providersStartingWith, putProvider,
    removeProvider, restoreLogging, Signer, sweepRealms, untilStatus,
} from '../../../utils/epicDelegation';

const TAGS = ['@epic-486', '@exclusive', '@regression'];
const PROVIDER_PREFIX = 'qa-e486-';
/** A read the run's user may do (Core asks for settings list), audited as CORE / SETTINGS / DETAIL. */
const ALLOWED_PATH = '/api/v1/settings/platform';
/** A read the run's user may not do (no connector permission). */
const DENIED_PATH = '/api/v1/connectors';

/** Two waits for the settings spread (40 s each) plus audit polls of up to 30 s, above the 30-second default. */
const TEST_TIMEOUT_MS = 300_000;
test.describe.configure({ mode: 'serial', timeout: TEST_TIMEOUT_MS });

const run = uniqueName('e486').toLowerCase();
const kcProvider = `${PROVIDER_PREFIX}${run}-keycloak`;
const signedProvider = `${PROVIDER_PREFIX}${run}-signed`;
const audience = `${run}-fixtures`;
const outer = `${run}-outer`;
const custom = `${run}-custom`;
const OUTER_SUBJECT = 'outer-service-account';

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

const attributed = (request: Invocation, delegate?: { identifier: string; subject: string }): Promise<Json[]> =>
    expectAttributed(admin, request, user, issued, delegate);
const refused = (token: string, provider: string, delegate: string): Promise<void> =>
    expectRefused(admin, () => call(ALLOWED_PATH, token), issued, provider, delegate);

test.beforeAll(async () => {
    test.setTimeout(120_000);
    env = loadEnv();
    grant = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    admin = adminApi(grant, env);
    // read first: afterAll puts back only what was read
    originalLogging = await enableFullAudit(admin);
    for (const stale of await providersStartingWith(admin, PROVIDER_PREFIX)) await removeProvider(admin, stale);

    const role = (await sendOk(admin, 'POST', '/api/v1/roles', {
        name: `${run}-role`, description: 'Epic ilm#486: settings list only',
        customAttributes: await requiredCustomAttributes(admin, 'roles', run),
    })).json as Json;
    cleanup.add('role', role.name, () => sendOk(admin, 'DELETE', `/api/v1/roles/${role.uuid}`));
    await sendOk(admin, 'POST', `/api/v1/roles/${role.uuid}/permissions`, {
        allowAllResources: false, resources: [{ name: 'settings', allowAllActions: false, actions: ['list'] }],
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
        const keycloak = { keycloakUrl: env.authBaseUrl, adminUsername: kcAdmin, adminPassword: kcPassword };
        const swept = await sweepRealms(keycloak, 'e486-');
        if (swept.length) console.log(`removed ${swept.length} realm(s) an earlier run left: ${swept.join(', ')}`);
        kc = await provisionDelegationRealm({ ...keycloak, realm: `${run}-realm`, username });
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
    test('S1: a real Keycloak delegation token is accepted as the user, and the audit names the client as delegate', async () => {
        keycloakOnly();
        const exchanged = claims(kc!.delegateToken);
        expect(exchanged.sub, 'the exchange keeps the user as subject').toBe(claims(kc!.subjectToken).sub);
        expect(exchanged.act?.sub, 'the exchange names the actor\'s service account').toBe(kc!.actorSubject);
        await put(kcProvider, kcSettings);
        const accepted = await untilStatus(() => call(ALLOWED_PATH, kc!.delegateToken), 200, 'the delegation token');
        const records = await attributed(accepted, { identifier: kc!.actorClientId, subject: kc!.actorSubject });
        recorded = { identifier: kc!.actorClientId, subject: kc!.actorSubject, ids: records.map((r) => String(r.id)) };
    });

    test('S3: after a delegated request, the user\'s own token records no delegate', async () => {
        keycloakOnly();
        const own = await call(ALLOWED_PATH, kc!.subjectToken);
        expect(own.status, 'the user\'s own token').toBe(200);
        await attributed(own);
    });

    test('S2: a delegation token has the user\'s permissions, no more: both tokens are denied a read the user may not do', async () => {
        keycloakOnly();
        expect((await call(DENIED_PATH, kc!.subjectToken)).status, 'the user\'s own token').toBe(403);
        expect((await call(DENIED_PATH, kc!.delegateToken)).status, 'the delegation token').toBe(403);
    });

    test('S4: a delegate removed from the provider is refused with 401, and the refusal names provider and delegate', async () => {
        keycloakOnly();
        await put(kcProvider, { ...kcSettings, allowedDelegates: [] });
        await refused(kc!.delegateToken, kcProvider, kc!.actorClientId);
    });

    test('S5: a provider without allowed delegates refuses a delegation token', async () => {
        const { allowedDelegates: _none, ...withoutDelegates } = signedSettings;
        await put(signedProvider, withoutDelegates);
        await refused(signed({ client_id: outer, sub: OUTER_SUBJECT }), signedProvider, outer);
    });

    test('S6: a malformed act is refused; of nested actors only the outermost decides and is recorded', async () => {
        await put(signedProvider, signedSettings);
        const nested = await untilStatus(
            () => call(ALLOWED_PATH, signed({ client_id: outer, sub: OUTER_SUBJECT, act: { client_id: 'unlisted-inner', sub: 'inner-service-account' } })),
            200, 'a nested act with an allowed outer delegate');
        const records = await attributed(nested, { identifier: outer, subject: OUTER_SUBJECT });
        recorded ??= { identifier: outer, subject: OUTER_SUBJECT, ids: records.map((r) => String(r.id)) };
        for (const act of ['not-an-object', [], null, {}, { sub: 'missing-client' }, { client_id: 7 }]) {
            expect((await call(ALLOWED_PATH, signed(act))).status, `act ${JSON.stringify(act)}`).toBe(401);
        }
    });

    test('S7: a custom delegate claim decides which delegate is allowed and recorded', async () => {
        await put(signedProvider, { ...signedSettings, allowedDelegates: [custom], delegateClaim: 'application_id' });
        const accepted = await untilStatus(
            () => call(ALLOWED_PATH, signed({ application_id: custom, client_id: 'unlisted-client', sub: 'custom-service-account' })),
            200, 'the custom delegate claim');
        await attributed(accepted, { identifier: custom, subject: 'custom-service-account' });
    });

    test('S9: the audit log filters and exports by delegate', async () => {
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
