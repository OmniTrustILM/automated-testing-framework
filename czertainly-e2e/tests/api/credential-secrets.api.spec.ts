/**
 * Credentials keep their secret: the password is masked in detail and list and is in no body; PUT keeps the
 * name, connector and kind and needs the password again; enable / disable, delete and bulk delete of own credentials.
 * Shared tiers: create-only with run-prefixed names; every create is in the ledger before the first assertion.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { credentialConnectorOrSkip, deleteAndVerify, expectGoneWith404, refused422 } from '../../utils/regression/inventory/configProbes';
import { readProbe } from '../../utils/regression/inventory/searchApi';
import type { Json } from '../../utils/regression/inventory/searchApi';
import { attributeOf, basicAttributes, bulkDeleteObjects, containsSecret, contentWithData, ownCredential, putCredential, randomSecret, readCredential, findRowByUuid, setCredentialEnabled, valuesOf } from '../../utils/regression/inventory/credentialsApi';
import { labelOf } from '../../utils/regression/inventory/raProfileValidation';
import { requiredCustomAttributes } from '../../utils/regression/customAttributes';
import { rowsNamed } from '../../utils/regression/listReads';
import { uniqueStamp } from '../../utils/regression/text';
import { recordDeleted } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';

const SPEC = 'API-GEN-17';
const ISSUE = 'ilm#428';

// ================================================================== API-GEN-17

test.describe('credential secrets and immutability', { tag: tags.api }, () => {
    test('detail and list show the password as a secret without data',
        testMeta({ id: 'API-GEN-17', row: 'masking', prio: 'P1', issue: ISSUE, rule: ['SECRET content is serialised with data null: ResponseAttributeSerializer; docs content.md:180', 'core#202, interfaces#125 (secret masking)', 'the plain password is in no body'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'mask' });

            await test.step('the 201 answer does not carry the password', async () => {
                expect(containsSecret(own.createText, own.password), 'the plain password is not in the create answer').toBe(false);
            });

            await test.step('detail: the password attribute is a secret without data; the username is still readable (control)', async () => {
                const p = await readCredential(api, own.ref.uuid);
                expect(p.status, p.text.slice(0, 300)).toBe(200);
                const detail = p.json as Json;
                const password = attributeOf(detail, 'password');
                expect(password, 'the detail lists the password attribute').toBeTruthy();
                expect(String(password!.contentType), 'the password attribute has content type secret').toBe('secret');
                expect(contentWithData(password), 'no content item of the secret carries data').toEqual([]);
                expect(valuesOf(detail, 'attributes', 'username'), 'a non-secret attribute is returned in clear').toEqual([own.username]);
                expect(containsSecret(p.text, own.password), 'the plain password is nowhere in the detail body').toBe(false);
            });

            await test.step('list: the row of the credential carries no secret data; the plain password is nowhere in the list body', async () => {
                const p = await readProbe(api, '/api/v1/credentials');
                expect(p.status, p.text.slice(0, 300)).toBe(200);
                const row = (p.json as Json[]).find((r) => r.uuid === own.ref.uuid);
                expect(row, 'the own credential is listed').toBeTruthy();
                expect(row!.kind).toBe('Basic');
                for (const a of Array.isArray(row!.attributes) ? (row!.attributes as Json[]) : []) {
                    if (String(a.contentType) === 'secret') expect(contentWithData(a), `list attribute ${String(a.name)}: no secret data`).toEqual([]);
                }
                expect(containsSecret(p.text, own.password), 'the plain password is nowhere in the list body').toBe(false);
            });
        });

    test('PUT with a new username and password answers 200 and keeps name, connector and kind',
        testMeta({ id: 'API-GEN-17', row: 'put', prio: 'P1', issue: ISSUE, rule: ['edit = attributes and customAttributes only; name, connector and kind cannot change; CredentialServiceImpl.editCredential', 'PUT own credential: 200, name / kind / connector unchanged, secret still masked', 'a body name is ignored; the secret stays masked'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'put' });
            const username = runName(`cu-${uniqueStamp()}`);
            const password = randomSecret();
            const ignoredName = runName(`cred-ignored-${uniqueStamp()}`);

            const put = await putCredential(api, own.ref.uuid, basicAttributes(c, { username, password }), await requiredCustomAttributes(api, 'credentials', runName('ca')), { name: ignoredName });
            expect(put.status, put.text.slice(0, 300)).toBe(200);
            const answer = put.json as Json;
            expect(answer.name, 'the answer names the original credential').toBe(own.ref.name);
            expect(answer.kind).toBe('Basic');
            expect(answer.connectorUuid).toBe(c.uuid);
            expect(contentWithData(attributeOf(answer, 'password')), 'the secret is masked in the PUT answer').toEqual([]);
            expect(containsSecret(put.text, password) || containsSecret(put.text, own.password), 'neither password is in the PUT answer').toBe(false);

            const read = await readCredential(api, own.ref.uuid);
            expect(read.status, read.text.slice(0, 300)).toBe(200);
            const detail = read.json as Json;
            expect(detail.name, 'name unchanged').toBe(own.ref.name);
            expect(detail.kind, 'kind unchanged').toBe('Basic');
            expect(detail.connectorUuid, 'connector unchanged').toBe(c.uuid);
            expect(valuesOf(detail, 'attributes', 'username'), 'the new username is stored').toEqual([username]);
            expect(contentWithData(attributeOf(detail, 'password')), 'the secret is still masked').toEqual([]);
            expect(containsSecret(read.text, password) || containsSecret(read.text, own.password), 'neither password is in the detail body').toBe(false);
            expect(await rowsNamed(api, '/api/v1/credentials', ignoredName), 'the name in the PUT body created or renamed nothing').toEqual([]);
        });

    test('PUT without the password answers 422 and changes nothing',
        testMeta({ id: 'API-GEN-17', row: 'put-no-password', prio: 'P1', issue: ISSUE, rule: ['the content is replaced wholesale and re-validated: a required secret must be supplied again', 'PUT with the password omitted (AttributeDefinitionUtils:388)', 'the 422 text is ["Required attribute Password not found."]'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'putnopw' });

            const put = await putCredential(api, own.ref.uuid, basicAttributes(c, { username: runName(`cu-${uniqueStamp()}`) }), await requiredCustomAttributes(api, 'credentials', runName('ca')));
            expect(refused422(put), 'the connector refuses the missing required password').toEqual([`Required attribute ${labelOf(c.passwordDef)} not found.`]);

            const read = await readCredential(api, own.ref.uuid);
            expect(read.status, read.text.slice(0, 300)).toBe(200);
            const detail = read.json as Json;
            expect(valuesOf(detail, 'attributes', 'username'), 'the refused PUT changed nothing: the username is the original one').toEqual([own.username]);
            expect(detail.name).toBe(own.ref.name);
            expect(detail.enabled, 'still enabled').toBe(true);
        });

    test('disable and enable an own credential answer 204 and `enabled` toggles',
        testMeta({ id: 'API-GEN-17', row: 'enable-disable', prio: 'P1', issue: ISSUE, rule: ['PATCH /v1/credentials/{uuid}/enable | disable: 204; CredentialServiceImpl.enableCredential / disableCredential', '`enabled` toggles in detail and list'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'toggle' });
            const state = async (): Promise<[boolean, boolean]> => {
                const detail = (await readCredential(api, own.ref.uuid)).json as Json;
                const row = await findRowByUuid(api, '/api/v1/credentials', own.ref.uuid);
                return [detail.enabled as boolean, row?.enabled as boolean];
            };

            expect(await state(), 'a new credential is enabled (detail, list)').toEqual([true, true]);
            const off = await setCredentialEnabled(api, own.ref.uuid, false);
            expect(off.status, off.text.slice(0, 300)).toBe(204);
            expect(await state(), 'disabled').toEqual([false, false]);
            const on = await setCredentialEnabled(api, own.ref.uuid, true);
            expect(on.status, on.text.slice(0, 300)).toBe(204);
            expect(await state(), 'enabled again').toEqual([true, true]);
        });

    test('deleting an own credential answers 204, then 404',
        testMeta({ id: 'API-GEN-17', row: 'delete', prio: 'P1', issue: ISSUE, rule: 'delete never refuses; 204 (deleting an existing credential; GET of an unknown uuid)' }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'del' });
            await deleteAndVerify(api, 'credentials', own.ref, 'Credential', SPEC);
            expect(await findRowByUuid(api, '/api/v1/credentials', own.ref.uuid), 'the credential is not listed any more').toBeUndefined();
        });

    test('bulk delete [own, unknown] answers 204 and removes the own credential',
        testMeta({ id: 'API-GEN-17', row: 'bulk-delete', prio: 'P1', issue: ISSUE, rule: ['bulk DELETE /v1/credentials skips unknown uuids with a warning: CredentialServiceImpl.bulkDeleteCredential', 'the unknown one is skipped'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'bulk' });
            const bulk = await bulkDeleteObjects(api, 'credentials', [own.ref.uuid, api.probeUuid()]);
            expect(bulk.status, bulk.text.slice(0, 300)).toBe(204);
            expect(bulk.text, 'a 204 has no body').toBe('');
            await expectGoneWith404(api, 'credentials', own.ref.uuid, 'Credential');
            recordDeleted('credentials', own.ref, SPEC, 'bulk delete under test: 204, then 404 on read-back');
        });
});
