/**
 * exclusive — Epic ilm#364: who owns an uploaded or imported certificate, with the platform setting and upload triggers.
 * Every test changes platform-wide state: @exclusive, serial, the setting and the trigger list restored after each run.
 */

import { test, expect, request as playwrightRequest, APIRequestContext, Browser, Page } from '@playwright/test';
import { loadEnv, TestEnv } from '../../../utils/env';
import { uniqueName } from '../../../utils/names';
import { certificate, certificatesInOnePem, Identity, pkcs12Chain } from '../../../utils/regression/inventory/importFixtures';
import { csrFromKey, newKeyMaterial, newKeyPair } from '../../../utils/regression/pkiBuilders';
import { waitForCertificateState } from '../../../utils/certificateUtils';
import { SCP_ATTR } from '../../../utils/regression/platform/cryptoAlgorithmCases';
import { tokenAlias } from '../../../utils/regression/platform/tokens';
import { readSmokeState } from '../../../utils/smokeState';
import { pollUntil } from '../../../utils/regression/wait';
import { LoginPage } from '../../../pages/LoginPage';
import { CertificatePage } from '../../../pages/CertificatePage';
import { CertificateListPage } from '../../../pages/CertificateListPage';
import { PlatformSettingsPage } from '../../../pages/PlatformSettingsPage';
import { openHashRoute } from '../../../pages/ui/openHashRoute';
import {
    Account, Cleanup, Json, accountCredentials, envFor, adminApi, apiAs, attributeValue, commonNameIs, createCustomAttribute, createGroup, createTeamUser,
    createOwnerNotificationProfile, createSoftwareTokenProfile, createUploadTrigger, customValue, notificationsMentioning, detail, findByFingerprint, importEntries, importResults, inventoryRow, ownerChanges, waitUntil,
    readAutomaticOwnership, send, sendOk, setAutomaticOwnership, setOwner, subjectOf, upload, uploadAndFind, uploadAsync, userUuid, waitForCertificate,
} from '../../../utils/epicOwnership';

const TAGS = ['@epic-364', '@exclusive'];
const REGRESSION = ['@epic-364', '@exclusive', '@regression'];
const DISCARDED = 'Certificate was not uploaded. See Certificate Uploaded Event History for more details.';

// Every test waits for the setting (up to 30 s) and for its certificates (up to 60 s each): far above the 30-second default.
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let env: TestEnv;
let grant: APIRequestContext;
let admin: APIRequestContext;
let U: APIRequestContext;
let V: APIRequestContext;
let R: APIRequestContext;
let originalSetting: boolean;
let originalValidation: Json | undefined;
let keys: ReturnType<typeof newKeyMaterial>;
const run = uniqueName('e364').toLowerCase();
const nameOf = (account: Account) => accountCredentials(env, account).username;
let cleanup = new Cleanup();

/** A new self-signed certificate with a subject unique to this run and scenario; every certificate shares one key pair (faster to make). */
const newCertificate = (scenario: string): Identity => certificate(subjectOf(run, scenario), { keys });

/** A browser signed in as the account (the login form, as the smoke user does); the suite's trace setting records a failed test. */
async function signedIn(browser: Browser, account: Account | 'admin'): Promise<{ page: Page; close: () => Promise<void> }> {
    const context = await browser.newContext({ baseURL: env.baseUrl, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const login = new LoginPage(page, account === 'admin' ? env : envFor(env, account));
    await login.goto();
    await login.login();
    return {
        page,
        close: async () => {
            await context.close();
        },
    };
}


test.beforeAll(async () => {
    env = loadEnv();
    // the contexts renew their tokens through this one, so it stays open until the last restore
    grant = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    admin = adminApi(grant, env);
    U = apiAs(grant, env, 'U');
    V = apiAs(grant, env, 'V');
    R = apiAs(grant, env, 'R');
    originalSetting = (await readAutomaticOwnership(admin)) ?? false;
    originalValidation = ((await sendOk(admin, 'GET', '/api/v1/settings/platform')).json as Json).certificates?.validation;
    keys = newKeyMaterial();
});

test.afterEach(async () => {
    await cleanup.run(admin);
    cleanup = new Cleanup();
});

test.afterAll(async () => {
    test.setTimeout(90_000); // the setting's wait (30 s) and the restores, above the 30-second hook default
    try {
        await setAutomaticOwnership(admin, originalSetting);
        if (originalValidation) {
            await sendOk(admin, 'PUT', '/api/v1/settings/platform', { certificates: { validation: { enabled: originalValidation.enabled, frequency: originalValidation.frequency ?? 1, expiringThreshold: originalValidation.expiringThreshold ?? 30 } } });
        }
    } finally {
        await Promise.all([admin, U, V, R].map((api) => api?.dispose()));
        await grant?.dispose();
    }
});

test.describe('ownership by upload and import', () => {
    test('S1: upload through the API makes the uploader the owner', { tag: REGRESSION }, async () => {
        await setAutomaticOwnership(admin, true);
        const cert = newCertificate('s1');
        cleanup.certificate(cert.fingerprint);

        const uuid = await uploadAndFind(U, admin, cert.pem, cert.fingerprint);

        expect((await detail(admin, uuid)).owner, 'the owner in the detail').toBe(nameOf('U'));
        expect((await inventoryRow(admin, cert.fingerprint))?.owner, 'the owner in the inventory').toBe(nameOf('U'));
        expect(await ownerChanges(admin, uuid), 'exactly one owner change in the history').toEqual([`undefined -> ${nameOf('U')}`]);
    });

    // uploaded by the administrator: U's role may not set custom attributes
    test('S1: the custom attribute value of an upload is kept with the setting on', { tag: REGRESSION }, async () => {
        await setAutomaticOwnership(admin, true);
        const attribute = await createCustomAttribute(admin, cleanup, `${run}-s1-attr`);
        const cert = newCertificate('s1-attr');
        cleanup.certificate(cert.fingerprint);

        const uuid = await uploadAndFind(admin, admin, cert.pem, cert.fingerprint, [attributeValue(attribute, 'uploaded-value')]);

        expect(customValue(await detail(admin, uuid), attribute.name), 'the custom attribute value').toBe('uploaded-value');
    });

    test('S2: asynchronous upload through the API makes the uploader the owner', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, true);
        const cert = newCertificate('s2');

        const answer = await uploadAsync(U, cleanup, cert);
        expect(answer.status, answer.text).toBeLessThan(300);
        expect((answer.json as Json).fingerprint, 'the fingerprint the platform returns').toBe(cert.fingerprint);

        const uuid = await waitForCertificate(admin, cert.fingerprint);
        // The owner is set right after the certificate is stored, so the owner is awaited, not read once.
        await waitUntil(async () => (await detail(admin, uuid)).owner === nameOf('U'), `the owner of the asynchronously uploaded certificate is ${nameOf('U')}`);
    });

    test('S3: with the setting off, uploaded and imported certificates have no owner', { tag: REGRESSION }, async () => {
        await setAutomaticOwnership(admin, false);
        expect(await readAutomaticOwnership(admin), 'the setting reads off after it was turned off').toBe(false);
        const uploaded = newCertificate('s3-upload');
        const imported = newCertificate('s3-import');
        cleanup.certificate(uploaded.fingerprint);
        cleanup.certificate(imported.fingerprint);

        const uploadedUuid = await uploadAndFind(U, admin, uploaded.pem, uploaded.fingerprint);
        const answer = await importEntries(U, Buffer.from(imported.pem), [{ entryReference: imported.fingerprint }]);
        expect(answer.status, answer.text).toBe(200);
        expect(importResults(answer).map((r) => r.certificateOutcome), 'the import created the certificate').toEqual(['created']);
        const importedUuid = await waitForCertificate(admin, imported.fingerprint);

        expect((await detail(admin, uploadedUuid)).owner ?? null, 'the uploaded certificate has no owner').toBeNull();
        expect((await detail(admin, importedUuid)).owner ?? null, 'the imported certificate has no owner').toBeNull();
    });

    test('S4: file import makes the importing user the owner of every certificate it creates', { tag: REGRESSION }, async () => {
        await setAutomaticOwnership(admin, true);
        const { pem, certs } = certificatesInOnePem(3, `${run}-s4`);
        certs.forEach((c) => cleanup.certificate(c.fingerprint));

        const answer = await importEntries(U, Buffer.from(pem), certs.map((c) => ({ entryReference: c.fingerprint })));
        expect(answer.status, answer.text).toBe(200);
        const results = importResults(answer);
        expect(results.map((r) => r.certificateOutcome), 'every entry is created').toEqual(['created', 'created', 'created']);

        for (const c of certs) {
            const uuid = await waitForCertificate(admin, c.fingerprint);
            expect((await detail(admin, uuid)).owner, `the owner of ${c.cn}`).toBe(nameOf('U'));
            expect(await ownerChanges(admin, uuid), `the owner changes of ${c.cn}`).toEqual([`undefined -> ${nameOf('U')}`]);
        }
    });

    test('S5: a certificate already in the inventory keeps its owner on import', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, true);
        const existing = newCertificate('s5-existing');
        const added = newCertificate('s5-new');
        cleanup.certificate(existing.fingerprint);
        cleanup.certificate(added.fingerprint);
        const existingUuid = await uploadAndFind(V, admin, existing.pem, existing.fingerprint);

        const answer = await importEntries(U, Buffer.from(existing.pem + added.pem), [{ entryReference: existing.fingerprint }, { entryReference: added.fingerprint }]);
        expect(answer.status, answer.text).toBe(200);
        const outcomeOf = (c: Identity) => importResults(answer).find((r) => r.entryReference === c.fingerprint)?.certificateOutcome;
        expect([outcomeOf(existing), outcomeOf(added)], 'the existing certificate is reported as existing').toEqual(['existing', 'created']);

        expect((await detail(admin, existingUuid)).owner, 'the existing certificate keeps its owner').toBe(nameOf('V'));
        const addedUuid = await waitForCertificate(admin, added.fingerprint);
        expect((await detail(admin, addedUuid)).owner, 'the new certificate is owned by the importer').toBe(nameOf('U'));
    });

    test('S6: an owner set by an upload trigger wins, with one owner change in the history', { tag: REGRESSION }, async () => {
        await setAutomaticOwnership(admin, true);
        const team = await createTeamUser(admin, cleanup, `${run}-team-s6`);
        const cert = newCertificate('s6');
        cleanup.certificate(cert.fingerprint);
        await createUploadTrigger(admin, cleanup, { name: `${run}-s6-trigger`, conditions: [commonNameIs(cert.cn)], setFields: [setOwner(team.uuid)] });

        const uuid = await uploadAndFind(U, admin, cert.pem, cert.fingerprint);

        expect((await detail(admin, uuid)).owner, 'the trigger owner, not the uploader').toBe(team.username);
        expect(await ownerChanges(admin, uuid), 'one owner change').toHaveLength(1);
    });

    test('S7: an owner set by an upload trigger also wins on file import', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, true);
        const team = await createTeamUser(admin, cleanup, `${run}-team-s7`);
        const cert = newCertificate('s7');
        cleanup.certificate(cert.fingerprint);
        await createUploadTrigger(admin, cleanup, { name: `${run}-s7-trigger`, conditions: [commonNameIs(cert.cn)], setFields: [setOwner(team.uuid)] });

        const answer = await importEntries(U, Buffer.from(cert.pem), [{ entryReference: cert.fingerprint }]);
        expect(answer.status, answer.text).toBe(200);
        const uuid = await waitForCertificate(admin, cert.fingerprint);

        expect((await detail(admin, uuid)).owner, 'the trigger owner, not the importer').toBe(team.username);
        expect(await ownerChanges(admin, uuid), 'one owner change').toHaveLength(1);
    });

    test('S8: a trigger that sets other fields but not the owner does not stop automatic ownership', { tag: TAGS }, async () => {
        // possibly the test, not the product: the RA profile switch asks the authority to identify a self-signed upload it never issued
        test.fail(true, 'an upload fails with 500 when a platform upload trigger sets an RA profile');
        await setAutomaticOwnership(admin, true);
        const state = readSmokeState();
        if (!state) throw new Error('The RA profile of the global setup is missing (.smoke-state.json)');
        const group = await createGroup(admin, cleanup, `${run}-s8-group`);
        const attribute = await createCustomAttribute(admin, cleanup, `${run}-s8-attr`);
        const cert = newCertificate('s8');
        cleanup.certificate(cert.fingerprint);
        await createUploadTrigger(admin, cleanup, {
            name: `${run}-s8-trigger`,
            conditions: [commonNameIs(cert.cn)],
            setFields: [
                { fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', data: [group.uuid] },
                { fieldSource: 'property', fieldIdentifier: 'RA_PROFILE_NAME', data: state.raProfileUuid },
                { fieldSource: 'custom', fieldIdentifier: `${attribute.name}|STRING`, data: 'set-by-trigger' },
            ],
        });

        const uuid = await uploadAndFind(U, admin, cert.pem, cert.fingerprint);

        const certificateDetail = await detail(admin, uuid);
        expect((certificateDetail.groups as Json[]).map((g) => g.uuid), 'the group set by the trigger').toEqual([group.uuid]);
        expect(certificateDetail.raProfile?.uuid, 'the RA profile set by the trigger').toBe(state.raProfileUuid);
        expect(customValue(certificateDetail, attribute.name), 'the custom attribute set by the trigger').toBe('set-by-trigger');
        expect(certificateDetail.owner, 'the uploader is the owner').toBe(nameOf('U'));
    });

    test('S8: a trigger that sets a group and a custom attribute but not the owner does not stop automatic ownership', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, true);
        const group = await createGroup(admin, cleanup, `${run}-s8b-group`);
        const attribute = await createCustomAttribute(admin, cleanup, `${run}-s8b-attr`);
        const cert = newCertificate('s8b');
        cleanup.certificate(cert.fingerprint);
        await createUploadTrigger(admin, cleanup, {
            name: `${run}-s8b-trigger`,
            conditions: [commonNameIs(cert.cn)],
            setFields: [
                { fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', data: [group.uuid] },
                { fieldSource: 'custom', fieldIdentifier: `${attribute.name}|STRING`, data: 'set-by-trigger' },
            ],
        });

        const uuid = await uploadAndFind(U, admin, cert.pem, cert.fingerprint);

        const certificateDetail = await detail(admin, uuid);
        expect((certificateDetail.groups as Json[]).map((g) => g.uuid), 'the group set by the trigger').toEqual([group.uuid]);
        expect(customValue(certificateDetail, attribute.name), 'the custom attribute set by the trigger').toBe('set-by-trigger');
        expect(certificateDetail.owner, 'the uploader is the owner').toBe(nameOf('U'));
    });

    test('S9: a discarded upload is refused with a pointer to the event history', { tag: REGRESSION }, async () => {
        test.fail(true, 'an upload discarded by an ignore trigger answers 500 instead of a client error');
        await setAutomaticOwnership(admin, true);
        const cert = newCertificate('s9');
        cleanup.certificate(cert.fingerprint);
        await createUploadTrigger(admin, cleanup, { name: `${run}-s9-trigger`, conditions: [commonNameIs(cert.cn)], ignore: true });

        const answer = await upload(U, cert.pem);

        expect(answer.status, `a client error, not a server error: ${answer.text}`).toBeGreaterThanOrEqual(400);
        expect(answer.status, `a client error, not a server error: ${answer.text}`).toBeLessThan(500);
        expect(answer.text, 'the message points to the event history').toContain(DISCARDED);
        expect(((await findByFingerprint(admin, cert.fingerprint)).json as Json).certificates, 'no certificate with that fingerprint exists').toHaveLength(0);
    });

    test('S24: a trigger that clears the owner keeps the certificate without an owner', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, true);
        const cert = newCertificate('s24');
        cleanup.certificate(cert.fingerprint);
        await createUploadTrigger(admin, cleanup, { name: `${run}-s24-trigger`, conditions: [commonNameIs(cert.cn)], setFields: [setOwner(null)] });

        const uuid = await uploadAndFind(U, admin, cert.pem, cert.fingerprint);

        expect((await detail(admin, uuid)).owner ?? null, 'no owner').toBeNull();
        expect(await ownerChanges(admin, uuid), 'no owner change in the history').toEqual([]);
    });

    test('S25: an owner trigger whose condition does not match has no say', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, true);
        const matching = newCertificate('s25-trigger-subject');
        const other = newCertificate('s25-other-subject');
        cleanup.certificate(other.fingerprint);
        await createUploadTrigger(admin, cleanup, { name: `${run}-s25-trigger`, conditions: [commonNameIs(matching.cn)], setFields: [setOwner(null)] });

        const uuid = await uploadAndFind(U, admin, other.pem, other.fingerprint);

        expect((await detail(admin, uuid)).owner, 'the uploader is the owner').toBe(nameOf('U'));
        expect(await ownerChanges(admin, uuid), 'one owner change').toEqual([`undefined -> ${nameOf('U')}`]);
    });
});

test.describe('key import', () => {
    test('S26: a key import makes the importer the owner of the chain it brings in', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, true);
        const tokenProfileUuid = await createSoftwareTokenProfile(admin, cleanup, `${run}-s26-token`);
        const root = certificate(`${run}-s26-root.example.com`, { ca: true });
        const intermediate = certificate(`${run}-s26-intermediate.example.com`, { ca: true, issuer: root });
        const first = pkcs12Chain(`${run}-s26-first.example.com`, intermediate, root, 'epic-pass');
        const second = pkcs12Chain(`${run}-s26-second.example.com`, intermediate, root, 'epic-pass');
        [first.identity, intermediate, root, second.identity].forEach((c) => cleanup.certificate(c.fingerprint));

        const importAs = async (as: APIRequestContext, file: { bytes: Buffer }, keyName: string) => {
            const inspection = await send(as, 'POST', '/api/v1/inspections', { file: Buffer.from(file.bytes).toString('base64'), passphrase: 'epic-pass', tokenProfileUuid });
            expect(inspection.status, inspection.text).toBe(200);
            const entries = ((inspection.json as Json).entries as Json[]).filter((e) => e.importable !== false);
            expect(entries.length, 'the file has an entry to import').toBeGreaterThan(0);
            const answer = await importEntries(as, file.bytes, entries.map((e) => ({ entryReference: e.entryReference, keyDestination: { tokenProfileUuid, keyName, importAttributes: [{ name: SCP_ATTR.keyAlias.name, uuid: SCP_ATTR.keyAlias.uuid, version: 'v2', contentType: 'string', content: [{ data: tokenAlias(keyName) }] }] } })), { passphrase: 'epic-pass' });
            expect(answer.status, answer.text).toBe(200);
            expect(importResults(answer).map((r) => r.imported), `every entry is imported: ${answer.text.slice(0, 1500)}`).not.toContain(false);
            return answer;
        };

        // imported by the administrator (U's role cannot use token profiles); V then owns the intermediate, which the second import must keep
        const importer = env.username;
        await importAs(admin, first, `${run}-s26-key-1`);
        for (const c of [first.identity, intermediate, root]) {
            const certificateDetail = await detail(admin, await waitForCertificate(admin, c.fingerprint));
            if (certificateDetail.key?.uuid) cleanup.key(certificateDetail.key.uuid);
            expect(certificateDetail.owner, `the importer owns ${c.cn}`).toBe(importer);
        }
        const intermediateUuid = await waitForCertificate(admin, intermediate.fingerprint);
        await sendOk(admin, 'PATCH', `/api/v1/certificates/${intermediateUuid}`, { ownerUuid: await userUuid(admin, nameOf('V')) });

        await importAs(admin, second, `${run}-s26-key-2`);
        const secondUuid = await waitForCertificate(admin, second.identity.fingerprint);
        const secondDetail = await detail(admin, secondUuid);
        if (secondDetail.key?.uuid) cleanup.key(secondDetail.key.uuid);
        expect(secondDetail.owner, 'the importer owns the new end-entity certificate').toBe(importer);
        expect((await inventoryRow(admin, intermediate.fingerprint))?.owner, 'the intermediate certificate, already in the inventory, keeps its owner').toBe(nameOf('V'));
        expect((await inventoryRow(admin, root.fingerprint))?.owner, 'the root certificate, already in the inventory, keeps its owner').toBe(importer);
    });
});

test.describe('notification to the owner', () => {
    test('S22: a trigger notification to the owner reaches the uploader', { tag: TAGS }, async () => {
        const profile = await createOwnerNotificationProfile(admin, cleanup, `${run}-s22-profile`);
        const withSetting = newCertificate('s22-on');
        const withoutSetting = newCertificate('s22-off');
        cleanup.certificate(withSetting.fingerprint);
        cleanup.certificate(withoutSetting.fingerprint);
        await createUploadTrigger(admin, cleanup, {
            name: `${run}-s22-trigger`,
            conditions: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'STARTS_WITH', value: `${run}-s22-` }],
            notificationProfileUuid: profile,
        });

        await setAutomaticOwnership(admin, true);
        const started = Date.now();
        await uploadAndFind(U, admin, withSetting.pem, withSetting.fingerprint);
        await waitUntil(async () => (await notificationsMentioning(U, withSetting.cn)).length > 0, `U has a notification for ${withSetting.cn}`, 90_000);
        const deliveryMs = Date.now() - started;

        await setAutomaticOwnership(admin, false);
        await uploadAndFind(U, admin, withoutSetting.pem, withoutSetting.fingerprint);
        // An absence can only be shown over a window: three times what the delivery took above, at least ten seconds, on top of the budget.
        const windowMs = Math.max(10_000, 3 * deliveryMs);
        test.setTimeout(test.info().timeout + windowMs);
        const seen = await pollUntil(() => notificationsMentioning(U, withoutSetting.cn), (found) => found.length > 0,
            { timeoutMs: windowMs, intervalMs: 2_000, tolerateErrors: 0, onTimeout: 'return' });
        expect(seen, `U has no notification for ${withoutSetting.cn} within ${Math.round(windowMs / 1000)} s`).toHaveLength(0);
    });
});

test.describe('access and security', () => {
    test('S14: the restricted user cannot read another user\'s certificate by its UUID', { tag: REGRESSION }, async () => {
        await setAutomaticOwnership(admin, true);
        const cert = newCertificate('s14');
        cleanup.certificate(cert.fingerprint);
        const uuid = await uploadAndFind(V, admin, cert.pem, cert.fingerprint);

        const direct = await send(R, 'GET', `/api/v1/certificates/${uuid}`);
        expect(direct.status, 'the detail of V\'s certificate is refused').toBe(403);

        const search = await findByFingerprint(R, cert.fingerprint);
        expect(search.status, search.text).toBe(200);
        expect((search.json as Json).certificates, 'no rows').toHaveLength(0);
        expect((search.json as Json).totalItems, 'a total of 0').toBe(0);
    });

    test('S27: the owner rights of a create-only uploader stop at their own certificates', { tag: REGRESSION }, async () => {
        await setAutomaticOwnership(admin, true);
        const group = await createGroup(admin, cleanup, `${run}-s27-group`);
        const own = newCertificate('s27-own');
        const foreign = newCertificate('s27-foreign');
        cleanup.certificate(own.fingerprint);
        cleanup.certificate(foreign.fingerprint);
        const ownUuid = await uploadAndFind(R, admin, own.pem, own.fingerprint);
        const foreignUuid = await uploadAndFind(V, admin, foreign.pem, foreign.fingerprint);

        const regroup = await send(R, 'PATCH', `/api/v1/certificates/${ownUuid}`, { groupUuids: [group.uuid] });
        expect(regroup.status, `R changes the group of G: ${regroup.text}`).toBeLessThan(300);
        const archive = await send(R, 'PATCH', `/api/v1/certificates/${ownUuid}/archive`);
        expect(archive.status, `R archives G: ${archive.text}`).toBeLessThan(300);

        const changed = await detail(admin, ownUuid);
        expect((changed.groups as Json[]).map((g) => g.uuid), 'G has the group R set').toEqual([group.uuid]);
        expect(changed.archived, 'G is archived').toBe(true);

        const foreignRegroup = await send(R, 'PATCH', `/api/v1/certificates/${foreignUuid}`, { groupUuids: [group.uuid] });
        expect(foreignRegroup.status, 'the group change on V\'s certificate is refused').toBe(403);
        const foreignArchive = await send(R, 'PATCH', `/api/v1/certificates/${foreignUuid}/archive`);
        expect(foreignArchive.status, 'archiving V\'s certificate is refused').toBe(403);

        const unchanged = await detail(admin, foreignUuid);
        expect(unchanged.groups ?? [], 'V\'s certificate has no group').toEqual([]);
        expect(unchanged.archived, 'V\'s certificate is not archived').toBeFalsy();
        expect(unchanged.owner, 'V still owns it').toBe(nameOf('V'));
    });

    test('S15: re-importing an existing certificate neither reveals it nor takes it over', { tag: REGRESSION }, async () => {
        await setAutomaticOwnership(admin, false);
        const owned = newCertificate('s15-owned');
        const ownerless = newCertificate('s15-ownerless');
        const fresh = newCertificate('s15-new');
        [owned, ownerless, fresh].forEach((c) => cleanup.certificate(c.fingerprint));
        const ownerlessUuid = await uploadAndFind(admin, admin, ownerless.pem, ownerless.fingerprint);
        await setAutomaticOwnership(admin, true);
        const ownedUuid = await uploadAndFind(V, admin, owned.pem, owned.fingerprint);

        const answer = await importEntries(R, Buffer.from(owned.pem + ownerless.pem + fresh.pem), [owned, ownerless, fresh].map((c) => ({ entryReference: c.fingerprint })));
        expect(answer.status, answer.text).toBe(200);
        const resultOf = (c: Identity) => importResults(answer).find((r) => r.entryReference === c.fingerprint) ?? { entryReference: c.fingerprint, imported: false };
        const [ownedResult, ownerlessResult, freshResult] = [owned, ownerless, fresh].map(resultOf);
        expect(ownedResult.certificateOutcome, 'V\'s certificate is reported as existing').toBe('existing');
        expect(ownedResult.certificateUuid, 'without its UUID').toBeUndefined();
        expect(ownerlessResult.certificateOutcome, 'N is reported as existing').toBe('existing');
        expect(ownerlessResult.certificateUuid, 'without its UUID').toBeUndefined();
        expect(freshResult.certificateOutcome, 'E is created').toBe('created');
        expect(freshResult.certificateUuid, 'with its UUID').toBeTruthy();

        expect((await detail(admin, ownedUuid)).owner, 'V\'s certificate is still owned by V').toBe(nameOf('V'));
        expect((await detail(admin, ownerlessUuid)).owner ?? null, 'N still has no owner').toBeNull();
        expect((await send(R, 'GET', `/api/v1/certificates/${ownerlessUuid}`)).status, 'R gets 403 on N').toBe(403);
        expect((await detail(admin, freshResult.certificateUuid!)).owner, 'E is owned by R').toBe(nameOf('R'));
    });

    test('S16: with the setting off, the restricted user still cannot open what they upload', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, false);
        const cert = newCertificate('s16');
        cleanup.certificate(cert.fingerprint);

        const answer = await importEntries(R, Buffer.from(cert.pem), [{ entryReference: cert.fingerprint }]);
        expect(answer.status, answer.text).toBe(200);
        const [result] = importResults(answer);
        expect(result.certificateOutcome, 'F is created').toBe('created');
        expect(result.certificateUuid, 'the import result has no UUID for F').toBeUndefined();

        const uuid = await waitForCertificate(admin, cert.fingerprint);
        expect((await detail(admin, uuid)).owner ?? null, 'F has no owner').toBeNull();
        const search = await findByFingerprint(R, cert.fingerprint);
        expect(search.status, search.text).toBe(200);
        expect((search.json as Json).certificates, 'no rows').toHaveLength(0);
    });
});

test.describe('unchanged behaviour', () => {
    // issued by the administrator: U's role cannot use authorities; the owner rule is compared with the setting off and on
    test('S20: issued certificates keep their ownership with the setting on', { tag: REGRESSION }, async () => {
        const state = readSmokeState();
        if (!state) throw new Error('The RA profile of the global setup is missing (.smoke-state.json)');
        const issue = async (name: string): Promise<{ uuid: string; owner: unknown }> => {
            const cn = subjectOf(run, name);
            const csr = csrFromKey(newKeyPair(), cn, { dns: [cn], ip: [] });
            const answer = await send(admin, 'POST', `/api/v2/operations/authorities/${state.authorityUuid}/raProfiles/${state.raProfileUuid}/certificates`, {
                request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [],
            });
            expect(answer.status, `issue: ${answer.text}`).toBe(200);
            const uuid = (answer.json as Json).uuid as string;
            cleanup.add('issued certificate', cn, async () => {
                const keyUuid = (await detail(admin, uuid)).key?.uuid;
                await sendOk(admin, 'DELETE', `/api/v1/certificates/${uuid}`);
                if (keyUuid) await sendOk(admin, 'DELETE', '/api/v1/keys', [keyUuid]);
            });
            await waitForCertificateState(admin, uuid, 'issued', 120_000);
            return { uuid, owner: (await detail(admin, uuid)).owner ?? null };
        };

        await setAutomaticOwnership(admin, false);
        const before = await issue('s20-off');
        await setAutomaticOwnership(admin, true);
        const after = await issue('s20-on');

        expect(after.owner, 'the same owner rule with the setting on as with it off').toBe(before.owner);
    });
});

test.describe('platform setting', () => {
    test('S19: a settings update without the upload part leaves the setting as it is', { tag: TAGS }, async () => {
        await setAutomaticOwnership(admin, true);
        const before = originalValidation ?? { enabled: true, frequency: 1, expiringThreshold: 30 };
        const threshold = (before.expiringThreshold ?? 30) === 29 ? 28 : 29;

        const withoutUpload = await send(admin, 'PUT', '/api/v1/settings/platform', { certificates: { validation: { enabled: before.enabled ?? true, frequency: before.frequency ?? 1, expiringThreshold: threshold } } });
        expect(withoutUpload.status, withoutUpload.text).toBeLessThan(300);
        const after = (await sendOk(admin, 'GET', '/api/v1/settings/platform')).json as Json;
        expect(after.certificates.validation.expiringThreshold, 'the validation settings are saved').toBe(threshold);
        expect(after.certificates.upload.automaticOwnership, 'the automatic ownership setting is still on').toBe(true);

        const emptyUpload = await send(admin, 'PUT', '/api/v1/settings/platform', { certificates: { upload: {} } });
        expect(emptyUpload.status, emptyUpload.text).toBeLessThan(300);
        await waitUntil(async () => (await readAutomaticOwnership(admin)) === false, 'the setting reads off after an empty upload part');
    });
});

test.describe('import wizard (UI)', () => {
    test('S10: import one certificate in the UI, open it in one click, see yourself as owner', { tag: REGRESSION }, async ({ browser }) => {
        test.fail(true, 'the import wizard keeps Import disabled for a user without custom attribute access');
        await setAutomaticOwnership(admin, true);
        const cert = newCertificate('s10');
        cleanup.certificate(cert.fingerprint);
        const { page, close } = await signedIn(browser, 'U');
        try {
            const certificates = new CertificatePage(page);
            await certificates.openImportFromList();
            await certificates.pasteCertificatePem(cert.pem);
            await certificates.importPastedCertificate();

            await certificates.importOpenCertificateLinks.click();

            await expect(page, 'the detail opens in one click').toHaveURL(/\/certificates\/detail\//);
            await expect(certificates.commonNameRow).toContainText(cert.cn);
            await expect(certificates.ownerRow, 'the detail shows U as owner').toContainText(nameOf('U'));

            const list = new CertificateListPage(page);
            await openHashRoute(page, 'certificates');
            await page.reload();
            await list.waitForTableLoaded();
            await expect(await list.rowByCommonName(cert.cn), 'the inventory row shows U as owner').toContainText(nameOf('U'));
        } finally {
            await close();
        }
    });

    test('S11: a discarded certificate in the import wizard is reported as not added', { tag: TAGS }, async ({ browser }) => {
        test.fail(true, 'the import wizard keeps Import disabled for a user without custom attribute access');
        await setAutomaticOwnership(admin, true);
        const cert = newCertificate('s11');
        cleanup.certificate(cert.fingerprint);
        await createUploadTrigger(admin, cleanup, { name: `${run}-s11-trigger`, conditions: [commonNameIs(cert.cn)], ignore: true });
        const { page, close } = await signedIn(browser, 'U');
        try {
            const certificates = new CertificatePage(page);
            await certificates.openImportFromList();
            await certificates.pasteCertificatePem(cert.pem);
            await certificates.submitImport();

            await certificates.assertImportResult('Not imported');
            await expect(certificates.importOpenCertificateLinks, 'no Open certificate link').toHaveCount(0);
            await expect(certificates.importResults, 'the message says it was not uploaded').toContainText('was not uploaded');
            await expect(certificates.importResults, 'the message points to the event history').toContainText('Certificate Uploaded Event History');
        } finally {
            await close();
        }
    });

    test('S12: the import result lets the user open each created certificate', { tag: TAGS }, async ({ browser }) => {
        test.fail(true, 'the import wizard keeps Import disabled for a user without custom attribute access');
        await setAutomaticOwnership(admin, true);
        const { pem, certs } = certificatesInOnePem(3, `${run}-s12`);
        certs.forEach((c) => cleanup.certificate(c.fingerprint));
        const { page, close } = await signedIn(browser, 'U');
        try {
            const certificates = new CertificatePage(page);
            await certificates.openImportFromList();
            await certificates.pasteCertificatePem(pem, 3);
            await certificates.submitImport();

            const links = certificates.importOpenCertificateLinks;
            await expect(links, 'each of the three entries has its own link').toHaveCount(3);
            const hrefs = await links.evaluateAll((all) => all.map((a) => a.getAttribute('href') ?? ''));
            expect(new Set(hrefs).size, 'three different details').toBe(3);

            const shownNames = [];
            for (const href of hrefs) {
                await page.goto(`/administrator/${href}`);
                await expect(page).toHaveURL(/\/certificates\/detail\//);
                await expect(certificates.ownerRow, `the detail ${href} shows U as owner`).toContainText(nameOf('U'));
                shownNames.push(await certificates.commonNameRow.innerText());
            }
            for (const c of certs) expect(shownNames.join('\n'), `the three details show ${c.cn}`).toContain(c.cn);
        } finally {
            await close();
        }
    });

    test('S13: a user who may only upload opens the certificate they imported; others stay hidden', { tag: REGRESSION }, async ({ browser }) => {
        test.fail(true, 'the import wizard keeps Import disabled for a user without custom attribute access');
        await setAutomaticOwnership(admin, true);
        const ofU = newCertificate('s13-u');
        const ofV = newCertificate('s13-v');
        const ofR = newCertificate('s13-r');
        [ofU, ofV, ofR].forEach((c) => cleanup.certificate(c.fingerprint));
        await uploadAndFind(U, admin, ofU.pem, ofU.fingerprint);
        await uploadAndFind(V, admin, ofV.pem, ofV.fingerprint);
        const { page, close } = await signedIn(browser, 'R');
        try {
            const certificates = new CertificatePage(page);
            await certificates.openImportFromList();
            await certificates.pasteCertificatePem(ofR.pem);
            await certificates.importPastedCertificate();
            await certificates.importOpenCertificateLinks.click();

            await expect(page).toHaveURL(/\/certificates\/detail\//);
            await expect(certificates.commonNameRow, 'the detail opens without an access error').toContainText(ofR.cn);

            const list = new CertificateListPage(page);
            await openHashRoute(page, 'certificates');
            await page.reload();
            await list.waitForTableLoaded();
            await expect(await list.rowByCommonName(ofR.cn), 'R\'s certificate is in the inventory').toHaveCount(1);
            await expect(await list.rowByCommonName(ofU.cn), 'U\'s certificate is not shown').toHaveCount(0);
            await expect(await list.rowByCommonName(ofV.cn), 'V\'s certificate is not shown').toHaveCount(0);
        } finally {
            await close();
        }
    });
});

test.describe('platform setting (UI)', () => {
    test('S18: the Automatic Ownership switch shows the saved value; turning it off keeps existing owners', { tag: TAGS }, async ({ browser }) => {
        await setAutomaticOwnership(admin, false);
        const cert = newCertificate('s18');
        cleanup.certificate(cert.fingerprint);
        const { page, close } = await signedIn(browser, 'admin');
        const settings = new PlatformSettingsPage(page);
        const saveAs = async (on: boolean): Promise<void> => {
            await settings.saveAutomaticOwnership(on);
            await waitUntil(async () => (await readAutomaticOwnership(admin)) === on, `the platform setting reads ${on ? 'on' : 'off'}`);
        };
        try {
            await saveAs(true);
            await settings.goToCertificates();
            await expect(settings.automaticOwnershipSwitch, 'after saving and reloading the switch shows on').toBeChecked();
            expect(await readAutomaticOwnership(admin), 'the API returns on').toBe(true);

            const uuid = await uploadAndFind(U, admin, cert.pem, cert.fingerprint);

            await saveAs(false);
            // Core may answer from its cache on another instance for up to 30 seconds after a change
            await expect(async () => {
                await settings.goToCertificates();
                await expect(settings.automaticOwnershipSwitch, 'after the second save the read-only view shows off').not.toBeChecked({ timeout: 3_000 });
            }).toPass({ timeout: 40_000 });
            expect(await readAutomaticOwnership(admin), 'the API returns off').toBe(false);
            expect((await detail(admin, uuid)).owner, 'the certificate uploaded while the setting was on still has U as owner').toBe(nameOf('U'));
        } finally {
            await close();
        }
    });
});
