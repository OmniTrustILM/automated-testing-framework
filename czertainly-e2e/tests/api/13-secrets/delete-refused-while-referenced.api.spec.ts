/**
 * API-SEC-01 — A secret that another object still references cannot be deleted. core#2510 (fix core#2584), ilm#436.
 *
 * WHAT: 1. Token PIN (row `token-pin`, needs `pkcs11`): an own PKCS#11 v2 token whose `pin` attribute references an own secret.
 *          DELETE of the secret → 422 ["Cannot delete Secret '<secret>': it is still used by Token '<token>' (attribute '<PIN label>')."];
 *          the secret still reads 200; the token's profile attributes and reload answer 200 before and after the refusal. Once the
 *          token is deleted, the secret deletes (204, then 404).
 *       2. Missing referenced secret (row `missing-secret`, needs `pkcs11`): an own token whose `pin` names a secret uuid that does not
 *          exist. GET …/tokenProfiles/attributes and the reload (PATCH) answer 422 ["Attribute '<PIN label>' refers to Secret '<name>',
 *          which does not exist. Select another one."], never a 5xx.
 *       3. ACME EAB (row `acme-eab`): an own ACME profile with an own EAB secret. DELETE of the secret → 422 naming the ACME profile
 *          ("… still used by ACME Profile '<profile>' (External Account Binding key)."); the secret still reads 200. Once the profile is
 *          deleted, the secret deletes (204, then 404).
 *       4. TSP Basic credential (rows `tsp-owned`, `tsp-release`): the secret core creates for an own TSP profile's Basic credential is
 *          removed with the credential (404 after the credential's delete). The refusal of a direct delete of that secret through the
 *          Secrets API is parked (test.fixme): core names that secret `tsp-basic-<profile uuid>-<username>-<suffix>`, without the run
 *          prefix, so the guard cannot prove it own and refuses to send the DELETE. Verified by hand on 2026-10-29 (422 naming the
 *          credential and the TSP profile).
 *       5. Control (row `unreferenced`): an own secret nothing references deletes (204, then 404).
 * WHY: core#2510: a secret referenced by a token attribute could be deleted, and the token's profile calls then failed with 500. The
 *      fix (core#2584 + interfaces#1073) adds one delete guard for every reference source (connector RESOURCE attributes, ACME EAB
 *      keys, TSP Basic credentials) answering 422 that names the user, and turns a missing referenced secret into a readable 422.
 *      Out of scope of the fix, NOT asserted: core#2510 AC4 (the token detail still shows the reference to a missing secret; GET
 *      /v1/tokens/{uuid} answers 200 with the dangling `pin`), and the OTPKI authority `oauthClient` reference (needs a live OTPKI
 *      server). A software cryptography token cannot reference a Secret (its activation code is an inline secret value), so the
 *      token rows use the PKCS#11 provider; its token label names no existing HSM token, so no HSM token is touched.
 * HOW: create-only. The run's own vault profile (ensureOwnVaultProfile) holds own generic secrets with random content; every create is
 *      recorded in the ledger before the first assertion. The missing secret is a guard probe uuid (names no object). The release
 *      deletes and the control run only while deleting own objects is on (`API_DELETE_OWN`, default on); with it off the refusals are
 *      the result and the objects stay for the run-end teardown (the row passes with an `own deletes off` annotation, not skipped).
 *      The secret core makes for the TSP credential is found by a name filter (SECRET_NAME STARTS_WITH tsp-basic-<profile>-<username>)
 *      and recorded at once as a DERIVED secret (server-clock `createdAfter` read before the credential create), so it is in the
 *      ledger even when the credential delete does not remove it.
 */
import * as crypto from 'crypto';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwn, recordIfAccepted } from '../../../utils/regression/ownCrud';
import { mayDeleteOwn } from '../../../utils/regression/ledger/ownership';
import type { OwnRef, Ref } from '../../../utils/regression/ledger/ledger';
import { ownName, runId, runName } from '../../../utils/regression/ledger/runState';
import { apiJson, serverCreatedAfter, type ApiAnswer } from '../../../utils/regression/apiReads';
import { recordDerived } from '../../../utils/regression/ledger/ledger';
import { readAnswer, send } from '../../../utils/regression/inventory/searchApi';
import { refused422 } from '../../../utils/regression/inventory/configProbes';
import { labelOf } from '../../../utils/regression/inventory/raProfileValidation';
import { requestAttributesFrom, requiredCustomAttributes } from '../../../utils/regression/customAttributes';
import { createOwnSecret, enableOwnSecret, enableOwnVaultProfile, ensureOwnVaultProfile, waitForSecretState } from '../../../utils/regression/platform/secretsAndVaults';
import type { AttributeDefinition } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { settings } from '../../../utils/regression/run/settings';
import { pollUntil } from '../../../utils/regression/wait';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { JsonObject } from '../../../utils/regression/json';
import { testMeta, tags } from '../../../utils/regression/tags';
import { CONNECTOR_WRITE_TEST_MS, SECRET_ACTIVE_MS } from '../../../utils/regression/timeouts';

const ISSUE = ['core#2510', 'ilm#436'];
const FIX = 'core#2510 fix core#2584 (+ interfaces#1073): one delete guard for every secret reference, 422 naming the user';
const SECRET_WAIT = { timeoutMs: 30_000, intervalMs: 500, tolerateErrors: 0, onTimeout: 'return' as const };

type Own = { spec: string; deleted(type: 'secrets' | 'tokens' | 'acmeProfiles' | 'tspBasicCredentials', ref: OwnRef, note?: string): void };

/** The run's vault profile (enabled), or the test skips with the named reason. */
async function vaultProfileOrSkip(api: GuardedApi, spec: string): Promise<{ vault: Ref; profile: OwnRef }> {
    const chain = await ensureOwnVaultProfile(api, spec);
    test.skip('skip' in chain, 'skip' in chain ? chain.skip : '');
    const { vault, profile } = chain as { vault: Ref; profile: OwnRef };
    const enabled = await enableOwnVaultProfile(api, vault, profile);
    expect(enabled.status(), await enabled.text()).toBeLessThan(300);
    return { vault, profile };
}

/** An own generic secret with random content, active and enabled. */
async function ownActiveSecret(api: GuardedApi, spec: string, chain: { vault: Ref; profile: OwnRef }, suffix: string): Promise<OwnRef> {
    const value = crypto.randomBytes(24).toString('base64url');
    const { detail: _detail, ...secret } = await createOwnSecret(api, spec, suffix, { ...chain, type: 'generic', value });
    await waitForSecretState(api, secret.uuid, 'active', SECRET_ACTIVE_MS);
    await enableOwnSecret(api, secret);
    return secret;
}

const deleteSecret = (api: GuardedApi, secret: OwnRef): Promise<ApiAnswer> => send(api, 'DELETE', `/api/v1/secrets/${secret.uuid}`);

/** A refused delete: 422 with exactly the expected message, and the secret still reads 200. */
async function expectDeleteRefused(api: GuardedApi, secret: OwnRef, message: string): Promise<void> {
    const sent = await deleteSecret(api, secret);
    expect(refused422(sent), 'the 422 names the object that still uses the secret').toEqual([message]);
    const after = await readAnswer(api, `/api/v1/secrets/${secret.uuid}`);
    expect(after.status, `the secret still exists after the refused delete: ${after.text.slice(0, 200)}`).toBe(200);
    expect((after.json as JsonObject).name).toBe(secret.name);
}

/** Own deletes are off: the passed refusal is the result. Annotates the row and returns true (the caller returns; the row stays green). */
function ownDeletesOff(what: string): boolean {
    if (mayDeleteOwn()) return false;
    test.info().annotations.push({ type: 'own deletes off', description: `API_DELETE_OWN=0: ${what}` });
    return true;
}

/** The detail of `url` answers 404 within the wait (an accepted delete may finish asynchronously). */
async function expectGone(api: GuardedApi, url: string, what: string): Promise<void> {
    const last = await pollUntil(() => readAnswer(api, url), (a) => a.status === 404, SECRET_WAIT);
    expect(last.status, `${what} reads 404 after its delete: ${last.text.slice(0, 200)}`).toBe(404);
}

/** DELETE of an own secret that nothing references any more: 204, then 404, then the `deleted` ledger line. */
async function expectSecretDeletes(api: GuardedApi, own: Own, secret: OwnRef, note: string): Promise<void> {
    const sent = await deleteSecret(api, secret);
    expect(sent.status, `DELETE secret: ${sent.text.slice(0, 300)}`).toBe(204);
    await expectGone(api, `/api/v1/secrets/${secret.uuid}`, 'the secret');
    own.deleted('secrets', secret, note);
}

// ------------------------------------------------------------------ PKCS#11 token whose PIN references a secret

interface Pkcs11 { connector: { uuid: string; name: string }; defs: AttributeDefinition[]; pinLabel: string }

/** The connected PKCS#11 cryptography connector (the `pkcs11` need resolved it) with its token form and the PIN label. */
async function pkcs11(api: GuardedApi): Promise<Pkcs11> {
    const wanted = settings().pkcs11Connector;
    const rows = await apiJson<JsonObject[]>(api, 'GET', '/api/v1/connectors');
    const row = rows.find((r) => r.name === wanted && r.status === 'connected');
    expect(row, `the connected PKCS#11 cryptography connector (${wanted}) that the pkcs11 need resolved`).toBeTruthy();
    const connector = { uuid: String(row!.uuid), name: String(row!.name) };
    const defs = await apiJson<AttributeDefinition[]>(api, 'GET', `/api/v1/tokens/${connector.uuid}/attributes`);
    const pin = defs.find((d) => d.name === 'pin');
    expect(pin, 'the PKCS#11 token form has a `pin` attribute').toBeTruthy();
    expect(String(pin!.contentType), 'the PIN is a RESOURCE reference to a Secret').toBe('resource');
    return { connector, defs, pinLabel: labelOf(pin as unknown as JsonObject) };
}

/** POST /v1/tokens: an own PKCS#11 v2 token on a token label that does not exist, its `pin` naming `secret` (recorded first). */
async function createOwnPinToken(api: GuardedApi, spec: string, p: Pkcs11, suffix: string, secret: { uuid: string; name: string }): Promise<OwnRef> {
    const name = ownName(suffix);
    const profileDef = p.defs.find((d) => d.name === 'profile');
    const offered = (profileDef?.content ?? []).map((c) => String(c.data));
    const { answer: _answer, ...ref } = await createOwn(api, spec, {
        type: 'tokens',
        path: '/api/v1/tokens',
        name,
        note: `own PKCS#11 token (no HSM token behind its label), pin → secret ${secret.name}`,
        body: {
            description: `REG run ${runId()}`,
            connectorUuid: p.connector.uuid,
            attributes: requestAttributesFrom(p.defs, {
                profile: offered.includes('softhsm') || !offered.length ? 'softhsm' : offered[0],
                // A label no HSM token carries; at most the 32 bytes CK_TOKEN_INFO holds (the run-prefixed name is longer).
                token: `pkcs11:token=qa-none-${crypto.randomBytes(6).toString('hex')}`,
                pin: { uuid: secret.uuid, name: secret.name, resource: 'secrets' },
            }),
            customAttributes: await requiredCustomAttributes(api, 'tokens', runName('ca')),
        },
    });
    return ref;
}

const tokenProfileAttributes = (api: GuardedApi, token: OwnRef): Promise<ApiAnswer> => readAnswer(api, `/api/v1/tokens/${token.uuid}/tokenProfiles/attributes`);
const reloadToken = (api: GuardedApi, token: OwnRef): Promise<ApiAnswer> => send(api, 'PATCH', `/api/v1/tokens/${token.uuid}`);

// ------------------------------------------------------------------ tests

test.describe('Secret delete refused while referenced', { tag: tags.api }, () => {
    test('a secret a token PIN references refuses its delete with 422 and deletes once the token is gone',
        testMeta({
            id: 'API-SEC-01', row: 'token-pin', prio: 'P1', issue: ISSUE, needs: 'pkcs11',
            rule: [FIX, 'core#2510 AC1 / AC3: deleting a secret referenced by a token attribute is refused with 422 naming the token and the attribute', 'core#2510: the token calls keep working (no 500)'],
        }),
        async ({ api, own }) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            const p = await pkcs11(api);
            const chain = await vaultProfileOrSkip(api, own.spec);
            const pin = await ownActiveSecret(api, own.spec, chain, 'pin');
            const token = await createOwnPinToken(api, own.spec, p, 'tok', pin);

            await test.step('Control: the token profile attributes and the reload answer 200 while the secret exists', async () => {
                const attrs = await tokenProfileAttributes(api, token);
                expect(attrs.status, attrs.text.slice(0, 300)).toBe(200);
                const reload = await reloadToken(api, token);
                expect(reload.status, reload.text.slice(0, 300)).toBe(200);
            });

            await test.step('DELETE the PIN secret: 422 naming the token and the PIN attribute, the secret still exists', async () => {
                await expectDeleteRefused(api, pin, `Cannot delete Secret '${pin.name}': it is still used by Token '${token.name}' (attribute '${p.pinLabel}').`);
            });

            await test.step('After the refusal the token calls still answer 200 (core#2510: they answered 500)', async () => {
                const attrs = await tokenProfileAttributes(api, token);
                expect(attrs.status, attrs.text.slice(0, 300)).toBe(200);
                const reload = await reloadToken(api, token);
                expect(reload.status, reload.text.slice(0, 300)).toBe(200);
            });

            if (ownDeletesOff('the refusal above is the result; the objects stay for the teardown')) return;

            await test.step('Release: delete the token (204), then the secret deletes (204, then 404)', async () => {
                const del = await send(api, 'DELETE', `/api/v1/tokens/${token.uuid}`);
                expect(del.status, `DELETE token: ${del.text.slice(0, 300)}`).toBe(204);
                own.deleted('tokens', token, 'deleted to release the PIN secret (core#2510)');
                await expectSecretDeletes(api, own, pin, 'deleted once its token was gone (core#2510)');
            });
        });

    test('a token whose PIN names a missing secret answers 422, not 500, on its profile attributes and reload',
        testMeta({
            id: 'API-SEC-01', row: 'missing-secret', prio: 'P1', issue: ISSUE, needs: 'pkcs11',
            rule: [FIX, 'core#2510 AC2: a missing referenced secret gives a readable 4xx on the token-profile calls, never 500'],
        }),
        async ({ api, own }) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            const p = await pkcs11(api);
            // A guard probe uuid: names no object on the tier, so the reference dangles from the start (nothing is deleted).
            const missing = { uuid: api.probeUuid(), name: ownName('missing') };
            const token = await createOwnPinToken(api, own.spec, p, 'tok-missing', missing);
            const message = `Attribute '${p.pinLabel}' refers to Secret '${missing.name}', which does not exist. Select another one.`;

            const attrs = await tokenProfileAttributes(api, token);
            expect(refused422(attrs), 'GET …/tokenProfiles/attributes names the missing secret').toEqual([message]);
            const reload = await reloadToken(api, token);
            expect(refused422(reload), 'the reload names the missing secret').toEqual([message]);
            // core#2510 AC4 (the token detail still shows the dangling `pin`) is out of scope of core#2584: not asserted.
        });

    test('the EAB secret of an ACME profile refuses its delete with 422 and deletes once the profile is gone',
        testMeta({
            id: 'API-SEC-01', row: 'acme-eab', prio: 'P1', issue: ISSUE,
            rule: [FIX, 'AcmeEabKeyReferenceSource: an ACME profile EAB key blocks the delete of its secret'],
        }),
        async ({ api, own }) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            const chain = await vaultProfileOrSkip(api, own.spec);
            const eab = await ownActiveSecret(api, own.spec, chain, 'eab');
            const { answer: _answer, ...acme } = await createOwn(api, own.spec, {
                type: 'acmeProfiles',
                path: '/api/v1/acmeProfiles',
                name: ownName('acme-eab'),
                note: `own ACME profile, EAB key → secret ${eab.name}`,
                body: {
                    description: `REG run ${runId()}`,
                    eabSecretUuids: [eab.uuid],
                    customAttributes: await requiredCustomAttributes(api, 'acmeProfiles', runName('ca')),
                    issueCertificateAttributes: [],
                    revokeCertificateAttributes: [],
                },
            });

            await test.step('DELETE the EAB secret: 422 naming the ACME profile, the secret still exists', async () => {
                await expectDeleteRefused(api, eab, `Cannot delete Secret '${eab.name}': it is still used by ACME Profile '${acme.name}' (External Account Binding key).`);
            });

            if (ownDeletesOff('the refusal above is the result; the objects stay for the teardown')) return;

            await test.step('Release: delete the ACME profile (created disabled), then the secret deletes (204, then 404)', async () => {
                const del = await send(api, 'DELETE', `/api/v1/acmeProfiles/${acme.uuid}`);
                expect(del.status, `DELETE ACME profile: ${del.text.slice(0, 300)}`).toBe(204);
                await expectGone(api, `/api/v1/acmeProfiles/${acme.uuid}`, 'the ACME profile');
                own.deleted('acmeProfiles', acme, 'deleted to release the EAB secret (core#2510)');
                await expectSecretDeletes(api, own, eab, 'deleted once its ACME profile was gone (core#2510)');
            });
        });

    // The reason is the `parked` annotation of the declaration: it reaches the report (a fixme body never runs).
    test.fixme('the secret a TSP Basic credential owns refuses a direct delete with 422 naming the credential',
        testMeta({
            id: 'API-SEC-01', row: 'tsp-owned', prio: 'P1', issue: ISSUE,
            rule: [FIX, 'TspBasicCredentialReferenceSource: 422 "… still used by TSP Profile Basic Credential <username> (owns this secret; delete the credential from TSP Profile <profile>)."'],
            parked: 'core names the credential secret tsp-basic-<profile uuid>-<username>-<suffix>, without the run prefix: the guard cannot prove it own and refuses the DELETE (verified by hand 2026-10-29: 422)',
        }),
        async () => {});

    test('deleting a TSP Basic credential also removes the secret it owns',
        testMeta({
            id: 'API-SEC-01', row: 'tsp-release', prio: 'P1', issue: ISSUE,
            rule: [FIX, 'a TSP Basic credential owns its secret: deleting the credential deletes the secret (TspProfile basicCredentials, deleteSecretsForProfile)'],
        }),
        async ({ api, own }) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            const chain = await vaultProfileOrSkip(api, own.spec);
            const user = await own.user('tsp-user');
            const { answer: _answer, ...tsp } = await createOwn(api, own.spec, {
                type: 'tspProfiles',
                path: '/api/v1/tspProfiles',
                name: ownName('tsp'),
                note: 'own TSP profile on the run vault profile (core#2510)',
                body: { description: `REG run ${runId()}`, vaultProfileUuid: chain.profile.uuid, allowedAuthenticationMethods: ['basicPassword'], customAttributes: [] },
            });
            const username = ownName('tsp-u');
            // Server clock before the credential create: the bound of the derived secret core makes for it.
            const createdAfter = await serverCreatedAfter(api);
            const created = await send(api, 'POST', `/api/v1/tspProfiles/${tsp.uuid}/basicCredentials`, {
                data: { username, password: crypto.randomBytes(16).toString('hex'), mappedUserUuid: user.uuid },
            });
            const credential = recordIfAccepted('tspBasicCredentials', created, username, own.spec, 'own TSP Basic credential (core#2510)', { tspProfile: tsp.uuid });
            expect(created.status, created.text.slice(0, 300)).toBe(201);
            expect(credential, 'the credential answer carries its uuid').toBeTruthy();

            const owned = await test.step('The credential owns a new secret in the run vault profile', async () => {
                // Core names it `tsp-basic-<profile>-<username>-<8 hex>`; the `-` after the username keeps `a` from matching `a-b`.
                const prefix = `tsp-basic-${tsp.uuid}-${username}-`;
                const found = await pollUntil(async () => {
                    const list = await apiJson<JsonObject>(api, 'POST', '/api/v1/secrets', {
                        itemsPerPage: 100, pageNumber: 1,
                        filters: [{ fieldSource: 'property', fieldIdentifier: 'SECRET_NAME', condition: 'STARTS_WITH', value: prefix }],
                    });
                    return ((list.items ?? []) as JsonObject[]).find((s) => String(s.name).startsWith(prefix));
                }, (s) => !!s, { ...SECRET_WAIT, what: 'the secret of the TSP credential' });
                expect(found, `a secret named ${prefix}… is listed`).toBeTruthy();
                const ref = { uuid: String(found!.uuid), name: String(found!.name) };
                // Ledger before the next assertion: platform-made (no run prefix), deleted by the teardown only when made during the run.
                recordDerived('secrets', ref, { spec: own.spec, createdAfter, note: 'secret core made for an own TSP Basic credential (core#2510)', parents: { tspProfile: tsp.uuid } });
                return ref;
            });

            if (ownDeletesOff('the objects stay for the teardown')) return;

            await test.step('Delete the credential (204): its secret reads 404', async () => {
                const del = await send(api, 'DELETE', `/api/v1/tspProfiles/${tsp.uuid}/basicCredentials/${credential!.uuid}`);
                expect(del.status, `DELETE credential: ${del.text.slice(0, 300)}`).toBe(204);
                own.deleted('tspBasicCredentials', credential!, 'deleted with its owned secret (core#2510)');
                await expectGone(api, `/api/v1/secrets/${owned.uuid}`, 'the secret the credential owned');
                own.deleted('secrets', { ...owned, kind: 'own' }, 'removed with its TSP Basic credential (core#2510)');
            });
        });

    test('an unreferenced secret deletes with 204 and then reads 404',
        testMeta({
            id: 'API-SEC-01', row: 'unreferenced', prio: 'P1', issue: ISSUE,
            rule: [FIX, 'control: the delete guard refuses only referenced secrets'],
        }),
        async ({ api, own }) => {
            test.setTimeout(CONNECTOR_WRITE_TEST_MS);
            const chain = await vaultProfileOrSkip(api, own.spec);
            const secret = await ownActiveSecret(api, own.spec, chain, 'ctl');
            if (ownDeletesOff('the control secret stays for the teardown')) return;
            await expectSecretDeletes(api, own, secret, 'control: an unreferenced secret deletes (core#2510)');
        });
});
