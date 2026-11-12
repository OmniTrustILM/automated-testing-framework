/**
 * exclusive — Epic ilm#364, the scenarios that change platform-wide state: automatic ownership of an uploaded or imported certificate.
 *
 * WHAT: who owns a certificate after an upload, an asynchronous upload or a file import, with the platform setting on and off, with
 *       platform triggers on "Certificate uploaded" that do and do not set the owner, and the access of a user who may only create.
 * WHY:  the setting is platform-wide and the platform triggers are platform-wide, so every test here changes global state: all of them are
 *       @exclusive, in this one file, serial, and run in their own execution. The setting and the validation settings are read first and
 *       restored in afterAll, also when a test failed.
 * HOW:  users U and V (create, list, detail) and R (create only) are prepared accounts (EPIC_USER_<letter>_*), never changed here. A test
 *       acts as the account the scenario names, reads the result as the administrator, and registers everything it creates in a Cleanup.
 *       Each certificate has a subject unique to the run; trigger conditions match that subject only.
 */

import { test, expect, request as playwrightRequest, APIRequestContext } from '@playwright/test';
import { loadEnv, TestEnv } from '../../../utils/env';
import { uniqueName } from '../../../utils/names';
import { certificate, certificatesInOnePem, Identity } from '../../../utils/regression/inventory/importFixtures';
import { newKeyMaterial } from '../../../utils/regression/pkiBuilders';
import { readSmokeState } from '../../../utils/smokeState';
import {
    Cleanup, Json, accountCredentials, adminApi, apiAs, attributeValue, commonNameIs, createCustomAttribute, createGroup, createTeamUser,
    createUploadTrigger, customValue, detail, findByFingerprint, importEntries, importResults, inventoryRow, ownerChanges, pollUntil,
    readAutomaticOwnership, send, sendOk, setAutomaticOwnership, setOwner, subjectOf, upload, uploadAndFind, waitForCertificate,
} from '../../../utils/epicOwnership';

const TAGS = ['@epic-364', '@exclusive'];
const REGRESSION = ['@epic-364', '@exclusive', '@regression'];
const DISCARDED = 'Certificate was not uploaded. See Certificate Uploaded Event History for more details.';

test.describe.configure({ mode: 'serial' });

let env: TestEnv;
let admin: APIRequestContext;
let U: APIRequestContext;
let V: APIRequestContext;
let R: APIRequestContext;
let originalSetting: boolean;
let originalValidation: Json | undefined;
let keys: ReturnType<typeof newKeyMaterial>;
const run = uniqueName('e364').toLowerCase();
const nameOf = (account: 'U' | 'V' | 'R') => accountCredentials(account).username;
let cleanup = new Cleanup();

/** A new self-signed certificate with a subject unique to this run and scenario; every certificate shares one key pair (faster to make). */
const newCertificate = (scenario: string): Identity => certificate(subjectOf(run, scenario), { keys });

test.beforeAll(async () => {
    env = loadEnv();
    const bootstrap = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    try {
        admin = await adminApi(bootstrap, env);
        U = await apiAs(bootstrap, env, 'U');
        V = await apiAs(bootstrap, env, 'V');
        R = await apiAs(bootstrap, env, 'R');
    } finally {
        await bootstrap.dispose();
    }
    originalSetting = await readAutomaticOwnership(admin);
    originalValidation = ((await sendOk(admin, 'GET', '/api/v1/settings/platform')).json as Json).certificates?.validation;
    keys = newKeyMaterial();
});

test.afterEach(async () => {
    await cleanup.run(admin);
    cleanup = new Cleanup();
});

test.afterAll(async () => {
    try {
        await setAutomaticOwnership(admin, originalSetting);
        if (originalValidation) {
            await sendOk(admin, 'PUT', '/api/v1/settings/platform', { certificates: { validation: { enabled: originalValidation.enabled, frequency: originalValidation.frequency ?? 1, expiringThreshold: originalValidation.expiringThreshold ?? 30 } } });
        }
    } finally {
        await Promise.all([admin, U, V, R].map((api) => api?.dispose()));
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

    // Needs a human: the role of U has no access to custom attributes, so U's upload with an attribute value is refused (422 "Not
    // allowed to set custom attributes"). The value is therefore uploaded by the administrator, who becomes the owner; this still
    // shows that the attribute value is kept while the setting is on.
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
        cleanup.certificate(cert.fingerprint);

        const answer = await upload(U, cert.pem, [], 'upload/async');
        expect(answer.status, answer.text).toBeLessThan(300);
        expect((answer.json as Json).fingerprint, 'the fingerprint the platform returns').toBe(cert.fingerprint);

        const uuid = await waitForCertificate(admin, cert.fingerprint);
        // The owner is set right after the certificate is stored, so the owner is awaited, not read once.
        await pollUntil(async () => (await detail(admin, uuid)).owner === nameOf('U'), `the owner of the asynchronously uploaded certificate is ${nameOf('U')}`);
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
        expect(importResults(answer).map((r) => r.certificateOutcome), 'the existing certificate is reported as existing').toEqual(['existing', 'created']);

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
        // bug draft: Upload by a user without RA profile access fails with 500 when a platform "Certificate uploaded" trigger sets an RA profile
        test.fail();
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
        const [ownedResult, ownerlessResult, freshResult] = importResults(answer);
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
        await pollUntil(async () => (await readAutomaticOwnership(admin)) === false, 'the setting reads off after an empty upload part');
    });
});
