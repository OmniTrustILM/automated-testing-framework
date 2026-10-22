/**
 * API-GEN-17 — Credentials keep their secret. ilm#428.
 *
 * WHAT: 1. A new Basic credential: the 201 answer, the detail and the list show the password as a secret attribute without data, the username
 *          stays readable, and the plain password is in no body.
 *       2. PUT with a new username and password → 200; name, connector and kind are unchanged (a name in the body is ignored and creates or
 *          renames nothing), the new username is stored and the secret is still masked.
 *       3. PUT without the password → 422 ["Required attribute <Password label> not found."] and nothing changes.
 *       4. Disable and enable → 204 and `enabled` toggles in detail and list; delete → 204, then 404 and the row is gone; bulk delete
 *          [own, unknown uuid] → 204 with no body and the own credential is gone.
 * WHY: a SECRET attribute is serialised with data null (ResponseAttributeSerializer; core#202, interfaces#125). An edit changes attributes and
 *      custom attributes only; the content is replaced wholesale and re-validated, so a required secret must be supplied again. Bulk delete
 *      skips unknown uuids with a warning.
 * HOW: create-only on shared tiers with run-prefixed names and random generated secrets; every create is recorded in the ledger before the
 *      first assertion; the test skips with the named reason when the tier has no credential connector. Deletes under test record the
 *      ledger deletion after the 404 read-back.
 */
import { expect, test } from '../../../fixtures/testFixtures';
import { credentialConnectorOrSkip, deleteOwnAndProveGone, expectGoneWith404, refused422 } from '../../../utils/regression/inventory/configProbes';
import { attributeOf, basicAttributes, bulkDeleteObjects, containsSecret, contentWithData, createOwnBasicCredential, putCredential, randomSecret, readCredential, findRowByUuid, setCredentialEnabled, valuesOf } from '../../../utils/regression/inventory/credentialsApi';
import { labelOf } from '../../../utils/regression/inventory/raProfileValidation';
import { requiredCustomAttributes } from '../../../utils/regression/customAttributes';
import { rowsNamed } from '../../../utils/regression/listReads';
import { recordDeleted } from '../../../utils/regression/ledger/ledger';
import { runName, ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { readAnswer } from '../../../utils/regression/inventory/searchApi';
import { JsonObject } from '../../../utils/regression/json';

const SPEC = 'API-GEN-17';
const ISSUE = 'ilm#428';

// ================================================================== API-GEN-17

test.describe('credential secrets and immutability', { tag: tags.api }, () => {
    test('detail and list show the password as a secret without data',
        testMeta({ id: 'API-GEN-17', row: 'masking', prio: 'P1', issue: ISSUE, rule: ['SECRET content is serialised with data null: ResponseAttributeSerializer', 'core#202, interfaces#125 (secret masking)', 'the plain password is in no body'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await createOwnBasicCredential(api, SPEC, 'mask', { connector: c });

            await test.step('the 201 answer does not carry the password', async () => {
                expect(containsSecret(own.createText, own.password), 'the plain password is not in the create answer').toBe(false);
            });

            await test.step('detail: the password attribute is a secret without data; the username is still readable (control)', async () => {
                const p = await readCredential(api, own.uuid);
                expect(p.status, p.text.slice(0, 300)).toBe(200);
                const detail = p.json as JsonObject;
                const password = attributeOf(detail, 'password');
                expect(password, 'the detail lists the password attribute').toBeTruthy();
                expect(String(password!.contentType), 'the password attribute has content type secret').toBe('secret');
                expect(contentWithData(password), 'no content item of the secret carries data').toEqual([]);
                expect(valuesOf(detail, 'attributes', 'username'), 'a non-secret attribute is returned in clear').toEqual([own.username]);
                expect(containsSecret(p.text, own.password), 'the plain password is nowhere in the detail body').toBe(false);
            });

            await test.step('list: the row of the credential carries no secret data; the plain password is nowhere in the list body', async () => {
                const p = await readAnswer(api, '/api/v1/credentials');
                expect(p.status, p.text.slice(0, 300)).toBe(200);
                const row = (p.json as JsonObject[]).find((r) => r.uuid === own.uuid);
                expect(row, 'the own credential is listed').toBeTruthy();
                expect(row!.kind).toBe('Basic');
                for (const a of Array.isArray(row!.attributes) ? (row!.attributes as JsonObject[]) : []) {
                    if (String(a.contentType) === 'secret') expect(contentWithData(a), `list attribute ${String(a.name)}: no secret data`).toEqual([]);
                }
                expect(containsSecret(p.text, own.password), 'the plain password is nowhere in the list body').toBe(false);
            });
        });

    test('PUT with a new username and password answers 200 and keeps name, connector and kind',
        testMeta({ id: 'API-GEN-17', row: 'put', prio: 'P1', issue: ISSUE, rule: ['edit = attributes and customAttributes only; name, connector and kind cannot change; CredentialServiceImpl.editCredential', 'PUT own credential: 200, name / kind / connector unchanged, secret still masked', 'a body name is ignored; the secret stays masked'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await createOwnBasicCredential(api, SPEC, 'put', { connector: c });
            const username = ownName('cu');
            const password = randomSecret();
            const ignoredName = ownName('cred-ignored');

            const put = await putCredential(api, own.uuid, basicAttributes(c, { username, password }), await requiredCustomAttributes(api, 'credentials', runName('ca')), { name: ignoredName });
            expect(put.status, put.text.slice(0, 300)).toBe(200);
            const answer = put.json as JsonObject;
            expect(answer.name, 'the answer names the original credential').toBe(own.name);
            expect(answer.kind).toBe('Basic');
            expect(answer.connectorUuid).toBe(c.uuid);
            expect(contentWithData(attributeOf(answer, 'password')), 'the secret is masked in the PUT answer').toEqual([]);
            expect(containsSecret(put.text, password) || containsSecret(put.text, own.password), 'neither password is in the PUT answer').toBe(false);

            const read = await readCredential(api, own.uuid);
            expect(read.status, read.text.slice(0, 300)).toBe(200);
            const detail = read.json as JsonObject;
            expect(detail.name, 'name unchanged').toBe(own.name);
            expect(detail.kind, 'kind unchanged').toBe('Basic');
            expect(detail.connectorUuid, 'connector unchanged').toBe(c.uuid);
            expect(valuesOf(detail, 'attributes', 'username'), 'the new username is stored').toEqual([username]);
            expect(contentWithData(attributeOf(detail, 'password')), 'the secret is still masked').toEqual([]);
            expect(containsSecret(read.text, password) || containsSecret(read.text, own.password), 'neither password is in the detail body').toBe(false);
            expect(await rowsNamed(api, '/api/v1/credentials', ignoredName), 'the name in the PUT body created or renamed nothing').toEqual([]);
        });

    test('PUT without the password answers 422 and changes nothing',
        testMeta({ id: 'API-GEN-17', row: 'put-no-password', prio: 'P1', issue: ISSUE, rule: ['the content is replaced wholesale and re-validated: a required secret must be supplied again', 'PUT with the password omitted (AttributeDefinitionUtils)', 'the 422 text is ["Required attribute Password not found."]'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await createOwnBasicCredential(api, SPEC, 'putnopw', { connector: c });

            const put = await putCredential(api, own.uuid, basicAttributes(c, { username: ownName('cu') }), await requiredCustomAttributes(api, 'credentials', runName('ca')));
            expect(refused422(put), 'the connector refuses the missing required password').toEqual([`Required attribute ${labelOf(c.passwordDef)} not found.`]);

            const read = await readCredential(api, own.uuid);
            expect(read.status, read.text.slice(0, 300)).toBe(200);
            const detail = read.json as JsonObject;
            expect(valuesOf(detail, 'attributes', 'username'), 'the refused PUT changed nothing: the username is the original one').toEqual([own.username]);
            expect(detail.name).toBe(own.name);
            expect(detail.enabled, 'still enabled').toBe(true);
        });

    test('disable and enable an own credential answer 204 and `enabled` toggles',
        testMeta({ id: 'API-GEN-17', row: 'enable-disable', prio: 'P1', issue: ISSUE, rule: ['PATCH /v1/credentials/{uuid}/enable | disable: 204; CredentialServiceImpl.enableCredential / disableCredential', '`enabled` toggles in detail and list'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await createOwnBasicCredential(api, SPEC, 'toggle', { connector: c });
            const state = async (): Promise<[boolean, boolean]> => {
                const detail = (await readCredential(api, own.uuid)).json as JsonObject;
                const row = await findRowByUuid(api, '/api/v1/credentials', own.uuid);
                return [detail.enabled as boolean, row?.enabled as boolean];
            };

            expect(await state(), 'a new credential is enabled (detail, list)').toEqual([true, true]);
            const off = await setCredentialEnabled(api, own.uuid, false);
            expect(off.status, off.text.slice(0, 300)).toBe(204);
            expect(await state(), 'disabled').toEqual([false, false]);
            const on = await setCredentialEnabled(api, own.uuid, true);
            expect(on.status, on.text.slice(0, 300)).toBe(204);
            expect(await state(), 'enabled again').toEqual([true, true]);
        });

    test('deleting an own credential answers 204, then 404',
        testMeta({ id: 'API-GEN-17', row: 'delete', prio: 'P1', issue: ISSUE, rule: 'delete never refuses; 204 (deleting an existing credential; GET of an unknown uuid)' }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await createOwnBasicCredential(api, SPEC, 'del', { connector: c });
            await deleteOwnAndProveGone(api, 'credentials', own, 'Credential', SPEC);
            expect(await findRowByUuid(api, '/api/v1/credentials', own.uuid), 'the credential is not listed any more').toBeUndefined();
        });

    test('bulk delete [own, unknown] answers 204 and removes the own credential',
        testMeta({ id: 'API-GEN-17', row: 'bulk-delete', prio: 'P1', issue: ISSUE, rule: ['bulk DELETE /v1/credentials skips unknown uuids with a warning: CredentialServiceImpl.bulkDeleteCredential', 'the unknown one is skipped'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await createOwnBasicCredential(api, SPEC, 'bulk', { connector: c });
            const bulk = await bulkDeleteObjects(api, 'credentials', [own.uuid, api.probeUuid()]);
            expect(bulk.status, bulk.text.slice(0, 300)).toBe(204);
            expect(bulk.text, 'a 204 has no body').toBe('');
            await expectGoneWith404(api, 'credentials', own.uuid, 'Credential');
            recordDeleted('credentials', own, SPEC, 'bulk delete under test: 204, then 404 on read-back');
        });
});
