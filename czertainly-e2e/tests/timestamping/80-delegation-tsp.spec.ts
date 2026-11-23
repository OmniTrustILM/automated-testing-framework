/**
 * delegation on TSP — Epic ilm#486 scenario 8 of #118: the timestamping endpoint accepts, refuses and records delegation
 * tokens as the API does. In this block for its ready TSP profile and the mapped user that may timestamp on it.
 * Changes the audit settings and adds own OAuth2 providers (the block runs in one worker), all restored in afterAll.
 */
import { request as playwrightRequest, APIRequestContext } from '@playwright/test';
import { adminApi, Json } from '../../utils/epicOwnership';
import {
    DelegationRealm, enableFullAudit, expectAttributed, expectRefused, invokeTsp, newSigner, provisionDelegationRealm, providersStartingWith,
    putProvider, removeProvider, restoreLogging, Signer, sweepRealms, untilStatus,
} from '../../utils/epicDelegation';
import { loadEnv, TestEnv } from '../../utils/env';
import { uniqueName } from '../../utils/names';
import { timestampingConfig } from '../../utils/timestamping/config';
import { expect, test } from '../../utils/timestamping/fixtures';
import { primaryFamily, readSummary } from '../../utils/timestamping/provisioning';
import { devTests } from '../../utils/timestamping/tags';

const EPIC = { tag: [...devTests().tag, '@epic-486'] };
const PROVIDER_PREFIX = 'qa-e486-tsp-';
/** Settings spread waits (40 s) plus audit polls of up to 30 s, above the block's spec timeout. */
const TEST_TIMEOUT_MS = 300_000;
/** RFC 3161 PKIStatus granted (0) or grantedWithMods (1). */
const GRANTED = [0, 1];

test.describe.configure({ mode: 'serial', timeout: TEST_TIMEOUT_MS });

const run = uniqueName('e486tsp').toLowerCase();
const signedProvider = `${PROVIDER_PREFIX}${run}-signed`;
const kcProvider = `${PROVIDER_PREFIX}${run}-keycloak`;
const outer = `${run}-outer`;
const OUTER_SUBJECT = 'outer-service-account';

let env: TestEnv;
let grant: APIRequestContext;
let admin: APIRequestContext;
let originalLogging: Json | undefined;
let signer: Signer;
let signedSettings: Json;
let kc: DelegationRealm | undefined;
let user: { uuid: string; username: string };
let profileName: string;
const providers = new Set<string>();
const issued: string[] = [];

const tspBaseUrl = (): string => timestampingConfig().tspBaseUrl ?? env.baseUrl;
const stamp = (token: string) => invokeTsp(tspBaseUrl(), profileName, token);
const signed = (act?: unknown): string => {
    const token = signer.token(user.username, act);
    issued.push(token);
    return token;
};
const put = async (name: string, settings: Json): Promise<void> => {
    providers.add(name);
    await putProvider(admin, name, settings);
};

test.beforeAll(async () => {
    test.setTimeout(120_000);
    const summary = readSummary();
    test.skip(summary.status !== 'ready', summary.status === 'ready' ? '' : summary.reason);
    if (summary.status !== 'ready') return;
    user = summary.provisioning.mappedUser;
    profileName = primaryFamily().nonQualified.tspProfile.name;
    env = loadEnv();
    grant = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    // settings writes: the block's guarded admin refuses them, so these use the smoke user's plain context, as the Epic tests do
    admin = adminApi(grant, env);
    originalLogging = await enableFullAudit(admin);
    for (const stale of await providersStartingWith(admin, PROVIDER_PREFIX)) await removeProvider(admin, stale);
    const audience = `${run}-fixtures`;
    signer = newSigner(`https://${run}.example.test`, audience);
    signedSettings = { issuerUrl: signer.issuer, jwkSet: signer.jwkSet, audiences: [audience], allowedDelegates: [outer], delegateClaim: 'client_id' };

    const kcAdmin = process.env.KC_DELEGATION_ADMIN_USERNAME;
    const kcPassword = process.env.KC_DELEGATION_ADMIN_PASSWORD;
    if (kcAdmin && kcPassword && env.authBaseUrl) {
        const keycloak = { keycloakUrl: env.authBaseUrl, adminUsername: kcAdmin, adminPassword: kcPassword };
        await sweepRealms(keycloak, 'e486tsp-');
        kc = await provisionDelegationRealm({ ...keycloak, realm: `${run}-realm`, username: user.username });
        issued.push(kc.subjectToken, kc.delegateToken);
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
    if (admin && originalLogging) await attempt('logging settings', () => restoreLogging(admin, originalLogging!));
    await admin?.dispose();
    await grant?.dispose();
    if (failures.length) throw new Error(`Cleanup failed: ${failures.join('; ')}`);
});

test.describe('delegation on the timestamping endpoint (Epic ilm#486)', EPIC, () => {
    test('S8a: with a signed delegation token TSP grants a timestamp recorded with the delegate, refuses a removed delegate and a malformed act', EPIC, async ({ ts }) => {
        expect(ts.mappedUser.uuid, 'the mapped user of the block').toBe(user.uuid);
        await put(signedProvider, signedSettings);
        const granted = await untilStatus(() => stamp(signed({ client_id: outer, sub: OUTER_SUBJECT })), 200, 'a delegation token on TSP');
        expect(GRANTED, 'RFC 3161 status of the timestamp').toContain(granted.pkiStatus);
        await expectAttributed(admin, granted, user, issued, { identifier: outer, subject: OUTER_SUBJECT });
        expect((await stamp(signed('not-an-object'))).status, 'a malformed act').toBe(401);
        await put(signedProvider, { ...signedSettings, allowedDelegates: [] });
        await expectRefused(admin, () => stamp(signed({ client_id: outer, sub: OUTER_SUBJECT })), issued, signedProvider, outer);
    });

    test('S8b: a real Keycloak delegation token gets a timestamp as the user with the client as delegate; the own token none; a removed delegate 401', EPIC, async () => {
        test.skip(!kc, 'no Keycloak admin for the disposable realm (KC_DELEGATION_ADMIN_USERNAME / _PASSWORD not set)');
        await put(kcProvider, {
            issuerUrl: kc!.issuer, jwkSet: kc!.jwkSet, usernameClaim: 'preferred_username', audiences: [kc!.actorClientId],
            allowedDelegates: [kc!.actorClientId], delegateClaim: 'client_id',
        });
        const delegated = await untilStatus(() => stamp(kc!.delegateToken), 200, 'the Keycloak delegation token on TSP');
        expect(GRANTED, 'RFC 3161 status of the delegated timestamp').toContain(delegated.pkiStatus);
        await expectAttributed(admin, delegated, user, issued, { identifier: kc!.actorClientId, subject: kc!.actorSubject });
        const own = await stamp(kc!.subjectToken);
        expect(own.status, 'the user\'s own token').toBe(200);
        await expectAttributed(admin, own, user, issued);
        await put(kcProvider, {
            issuerUrl: kc!.issuer, jwkSet: kc!.jwkSet, usernameClaim: 'preferred_username', audiences: [kc!.actorClientId],
            allowedDelegates: [], delegateClaim: 'client_id',
        });
        await expectRefused(admin, () => stamp(kc!.delegateToken), issued, kcProvider, kc!.actorClientId);
    });
});
