/**
 * API-GEN-17 … 20 and 28 — configuration resources of the inventory-api area (ilm#428, T4 step 15 and the credential /
 * group analogues; rules `assets/rules/inventory-api.md` §9 credentials, §10 groups, §1.3 / §1.4 the 422 relay):
 *
 *   API-GEN-17 (S-own)  credentials, secrets and immutability: the secret is masked in detail and list and the plain password
 *                       is in no body; PUT keeps name / connector / kind and needs the password again; enable / disable;
 *                       delete own, bulk delete [own, unknown]
 *   API-GEN-18 (S)      credential validation matrix, one test per row `API-GEN-18[<row>]` (names, duplicate, connector
 *                       uuid, function group, kind, Basic attributes, core#2512 orphan, missing connector uuid, empty password)
 *   API-GEN-19 (S-own)  groups: name, duplicate, PUT semantics, unknown / malformed uuid, accepted-but-UI-blocked values
 *                       (P2 pin Q8), delete own, bulk delete, members, list vs detail
 *   API-GEN-20 (S-own)  group assignment REPLACES the set (state transitions, history "old -> new", no-op for an identical
 *                       set, 400 / 422 refusals); the unknown-group arm is a `@local` row until triaged
 *   API-GEN-28 (S)      RA profile with a required attribute empty, API leg: the connector's 422 is relayed as 422 by the
 *                       validate endpoint and by the create, and no RA profile is created
 * (API-GEN-21 / 22 / 30 are P2 / blocked rows of the same file in the ledger: not in this batch.)
 *
 * Shared-tier safety: create-only with run-prefixed names. Every object a test creates is recorded in the ledger right after
 * the create call and before any assertion (also a create that was expected to be refused: `createCredentialProbe`,
 * `createGroupProbe`, `createRaProfileProbe`; an orphan a refused create left behind is adopted by its unique name). Own
 * objects only are changed or deleted (credentials, groups, certificates, their custom attribute and owner user); a delete is
 * made only as the behaviour under test and is followed by `recordDeleted` after the 204 + 404 read-back; everything else is
 * removed by the run-end teardown. The authority of API-GEN-28 is a scope parent only (a pre-existing, connected one: read,
 * never changed; none -> the rows skip with the named reason, no authority is created). Requests go through the guarded `api`
 * fixture; the password a test sends is a per-call random string (node:crypto), never a literal.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expect422Messages, expectMessageObject } from '../../utils/regression/errorContract';
import { readProbe } from '../../utils/regression/inventoryApi';
import type { Json, Probe } from '../../utils/regression/inventoryApi';
import {
    adoptByName, archiveOwnCertificate, attributeOf, authorityWithRequiredAttribute, basicAttributes, bulkDeleteObjects, certificateDetail,
    certificateHistory, changeKey, connectorWithoutCredentialGroup, containsSecret, contentWithData, createCredentialProbe, createGroupProbe,
    createRaProfileProbe, credentialBody, credentialSetup, customValue, deleteOwnObject, emptyArm, groupBody, groupChanges, groupEventCount,
    groupUuidsOf, labelOf, missingArm, ownCertificate, ownCredential, ownGroup, ownGroupAttribute, patchCertificate, putCredential, putGroup,
    raProfileBody, randomSecret, readCredential, readGroup, readObject, requiredCustomFor, requiredNotFound, requiredNotSet, rowOf, rowsNamed,
    setCredentialEnabled, setGroups, stamp, validRaAttributes, validateRaAttributes, valuesOf,
} from '../../utils/regression/inventoryConfigApi';
import type { BasicValues, CredentialConnector } from '../../utils/regression/inventoryConfigApi';
import { createOwnUser } from '../../utils/regression/regressionApi';
import { recordDeleted, regName } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import { describeLocal } from '../../utils/regression/tier';
import type { GuardedApi } from '../../utils/regression/guardedApi';

const SPEC = 'API-GEN-17';
const ISSUE = 'ilm#428';
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ shared steps

/** A refusal that must be a 422: JSON array of non-empty strings (the messages are returned). */
function refused422(p: Probe): string[] {
    expect(p.status, p.text.slice(0, 300)).toBe(422);
    expect(p.contentType, 'a 422 is application/json').toMatch(/application\/json/);
    return expect422Messages(p.text);
}

/** A refusal that is not a 422: `{ "message": "<text>" }` and nothing else (the message is returned). */
function refusedWith(p: Probe, status: number): string {
    expect(p.status, p.text.slice(0, 300)).toBe(status);
    expect(p.contentType, `a ${status} is application/json`).toMatch(/application\/json/);
    return expectMessageObject(p.text);
}

/** The Common Credential connector with its Basic definitions, or the rows skip with the named reason. */
async function credentialConnectorOrSkip(api: GuardedApi): Promise<CredentialConnector> {
    const setup = await credentialSetup(api);
    test.skip(!setup.ok, setup.skip ?? 'no credential connector');
    return setup.ok!;
}

/** A Basic credential body for a validation row: valid attributes (random username and password) unless the row changes them. */
async function basicBody(api: GuardedApi, c: CredentialConnector, name: unknown, over: Json = {}, values?: BasicValues, opts?: { withUuid?: boolean }): Promise<Json> {
    const given = values ?? { username: regName(`cu-${stamp()}`), password: randomSecret() };
    return credentialBody(c, name, basicAttributes(c, given, opts), await requiredCustomFor(api, 'credentials', regName('ca')), over);
}

/** DELETE own, expect 204 and an empty body, read it back as 404 (message per the error contract), then record the delete. */
async function deleteVerified(api: GuardedApi, kind: 'credentials' | 'groups', ref: { uuid: string; name: string }, type: string): Promise<void> {
    const del = await deleteOwnObject(api, kind, ref.uuid);
    expect(del.status, del.text.slice(0, 300)).toBe(204);
    expect(del.text, 'a 204 has no body').toBe('');
    await readBack404(api, kind, ref.uuid, type);
    recordDeleted(kind, ref, SPEC, 'delete under test: 204, then 404 on read-back');
}

/** The object is gone: its detail answers 404 `Object of type '<type>' identified by <uuid> is not found.`. */
async function readBack404(api: GuardedApi, kind: 'credentials' | 'groups', uuid: string, type: string): Promise<void> {
    const gone = await readObject(api, kind, uuid);
    expect(refusedWith(gone, 404)).toBe(`Object of type '${type}' identified by ${uuid} is not found.`);
}

// ================================================================== API-GEN-17

test.describe('API-GEN-17 credentials: secrets and immutability', { tag: tags.api }, () => {
    test('API-GEN-17[masking]: detail and list show the password as a secret without data; the plain password is in no body',
        meta({ id: 'API-GEN-17', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.2 r4 (SECRET content is serialised with data null: ResponseAttributeSerializer; docs content.md:180)', 'core#202, interfaces#125 (secret masking)'] }),
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

    test('API-GEN-17[put]: PUT with a new username and password answers 200; name, connector and kind stay (a body name is ignored); the secret stays masked',
        meta({ id: 'API-GEN-17', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.2 r5 (edit = attributes and customAttributes only; name, connector and kind cannot change; CredentialServiceImpl.editCredential)', 'inventory-api §9.4 (PUT own credential: 200, name / kind / connector unchanged, secret still masked)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'put' });
            const username = regName(`cu-${stamp()}`);
            const password = randomSecret();
            const ignoredName = regName(`cred-ignored-${stamp()}`);

            const put = await putCredential(api, own.ref.uuid, basicAttributes(c, { username, password }), await requiredCustomFor(api, 'credentials', regName('ca')), { name: ignoredName });
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

    test('API-GEN-17[put-no-password]: PUT without the password answers 422 ["Required attribute Password not found."] and changes nothing',
        meta({ id: 'API-GEN-17', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.2 r5 (the content is replaced wholesale and re-validated: a required secret must be supplied again)', 'inventory-api §9.3 row "PUT with password omitted" (AttributeDefinitionUtils:388)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'putnopw' });

            const put = await putCredential(api, own.ref.uuid, basicAttributes(c, { username: regName(`cu-${stamp()}`) }), await requiredCustomFor(api, 'credentials', regName('ca')));
            expect(refused422(put), 'the connector refuses the missing required password').toEqual([`Required attribute ${labelOf(c.passwordDef)} not found.`]);

            const read = await readCredential(api, own.ref.uuid);
            expect(read.status, read.text.slice(0, 300)).toBe(200);
            const detail = read.json as Json;
            expect(valuesOf(detail, 'attributes', 'username'), 'the refused PUT changed nothing: the username is the original one').toEqual([own.username]);
            expect(detail.name).toBe(own.ref.name);
            expect(detail.enabled, 'still enabled').toBe(true);
        });

    test('API-GEN-17[enable-disable]: disable and enable an own credential answer 204 and `enabled` toggles in detail and list',
        meta({ id: 'API-GEN-17', prio: 'P1', issue: ISSUE, rule: 'inventory-api §9.2 r10 (PATCH /v1/credentials/{uuid}/enable | disable: 204; CredentialServiceImpl.enableCredential / disableCredential)' }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'toggle' });
            const state = async (): Promise<[boolean, boolean]> => {
                const detail = (await readCredential(api, own.ref.uuid)).json as Json;
                const row = await rowOf(api, '/api/v1/credentials', own.ref.uuid);
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

    test('API-GEN-17[delete]: deleting an own credential answers 204, then 404',
        meta({ id: 'API-GEN-17', prio: 'P1', issue: ISSUE, rule: 'inventory-api §9.2 r9 (delete never refuses; 204) and §9.3 rows "DELETE existing" / "GET unknown uuid"' }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'del' });
            await deleteVerified(api, 'credentials', own.ref, 'Credential');
            expect(await rowOf(api, '/api/v1/credentials', own.ref.uuid), 'the credential is not listed any more').toBeUndefined();
        });

    test('API-GEN-17[bulk-delete]: bulk delete [own, unknown] answers 204; the own credential is removed, the unknown one is skipped',
        meta({ id: 'API-GEN-17', prio: 'P1', issue: ISSUE, rule: 'inventory-api §9.2 r9 (bulk DELETE /v1/credentials skips unknown uuids with a warning: CredentialServiceImpl.bulkDeleteCredential)' }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const own = await ownCredential(api, c, SPEC, { suffix: 'bulk' });
            const bulk = await bulkDeleteObjects(api, 'credentials', [own.ref.uuid, api.probeUuid()]);
            expect(bulk.status, bulk.text.slice(0, 300)).toBe(204);
            expect(bulk.text, 'a 204 has no body').toBe('');
            await readBack404(api, 'credentials', own.ref.uuid, 'Credential');
            recordDeleted('credentials', own.ref, SPEC, 'bulk delete under test: 204, then 404 on read-back');
        });
});

// ================================================================== API-GEN-18

const NAME_ROWS: ReadonlyArray<readonly [row: string, value: string | null, what: string]> = [
    ['name-blank', '', 'a blank'],
    ['name-null', null, 'a null'],
    ['name-whitespace', '   ', 'a whitespace-only'],
];

test.describe('API-GEN-18 credentials: validation matrix', { tag: tags.api }, () => {
    test('API-GEN-18[control]: the valid Basic body is created (201 with the uuid) and listed enabled',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.2 r1 / r3 (create needs name, connectorUuid, kind and attributes; Basic = username + password)', 'inventory-api §9.4 (the control with the attribute uuid still gives 201: core#2512 is the by-name shape)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const name = regName(`cred-ctl-${stamp()}`);
            const { probe, own } = await createCredentialProbe(api, await basicBody(api, c, name), SPEC, 'matrix control');
            expect(probe.status, probe.text.slice(0, 300)).toBe(201);
            expect(own, 'the 201 answer carries the uuid').toBeTruthy();
            expect(own!.uuid).toMatch(UUID_FORMAT);
            const row = await rowOf(api, '/api/v1/credentials', own!.uuid);
            expect(row, 'the credential is listed').toBeTruthy();
            expect([row!.name, row!.kind, row!.enabled, row!.connectorUuid]).toEqual([name, 'Basic', true, c.uuid]);
        });

    for (const [row, value, what] of NAME_ROWS) {
        test(`API-GEN-18[${row}]: ${what} name is refused 422 ["Name must not be empty"]`,
            meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.2 r2 (blank name 422 "Name must not be empty": CredentialServiceImpl:139)', 'inventory-api §9.3 row "name null / "" / "   ""'] }),
            async ({ api }) => {
                const c = await credentialConnectorOrSkip(api);
                const { probe } = await createCredentialProbe(api, await basicBody(api, c, value), SPEC, `${row} probe`);
                expect(refused422(probe)).toEqual(['Name must not be empty']);
            });
    }

    test('API-GEN-18[duplicate]: the same name again answers 409 "Object of type \'Credential\' identified by <name> already exists." and exactly one credential has the name',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.2 r7 (duplicate name: exact, case-sensitive; 409 AlreadyExistException)', 'inventory-api §9.3 row "duplicate name"; REG-CFG-01 (UI partner)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const first = await ownCredential(api, c, SPEC, { suffix: 'dup' });
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, first.ref.name), SPEC, 'duplicate-name probe');
            expect(refusedWith(probe, 409)).toBe(`Object of type 'Credential' identified by ${first.ref.name} already exists.`);
            const rows = await rowsNamed(api, '/api/v1/credentials', first.ref.name);
            expect(rows.map((r) => r.uuid), 'exactly one credential has the name: the first one').toEqual([first.ref.uuid]);
        });

    test('API-GEN-18[connector-not-uuid]: a connectorUuid that is not a UUID answers 422 ["Invalid UUID <value> in the request"]',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.3 row "connectorUuid not a UUID" (SecuredUUID.fromString: Invalid UUID <v> in the request)', 'inventory-api §9.2 r2 (order of checks: the connector is resolved after the name checks)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, regName(`cred-uuid-${stamp()}`), { connectorUuid: 'not-a-uuid' }), SPEC, 'bad connector uuid probe');
            expect(refused422(probe)).toEqual(['Invalid UUID not-a-uuid in the request']);
        });

    test('API-GEN-18[connector-unknown]: an unknown connector answers 404 "Object of type \'Connector\' identified by <uuid> is not found."',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: 'inventory-api §9.3 row "connectorUuid unknown" (ConnectorServiceImpl: NotFoundException(Connector); inferred wording, observed status)' }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const unknown = api.probeUuid();
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, regName(`cred-noconn-${stamp()}`), { connectorUuid: unknown }), SPEC, 'unknown connector probe');
            expect(refusedWith(probe, 404)).toBe(`Object of type 'Connector' identified by ${unknown} is not found.`);
        });

    test('API-GEN-18[connector-no-credential-group]: a connector without the credential function group is refused 422 ("Connector <n> doesn\'t support function group code …")',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.2 r2 (ConnectorServiceImpl.validateFunctionGroup: "Connector {} doesn\'t support function group code {}")', 'inventory-api §9.3 row "connector without credentialProvider group"'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const other = await connectorWithoutCredentialGroup(api);
            test.skip(!other, 'no pre-existing connector with function groups but without credentialProvider on this tier');
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, regName(`cred-nofg-${stamp()}`), { connectorUuid: other!.uuid }), SPEC, 'wrong function group probe');
            const messages = refused422(probe);
            expect(messages.join(' | '), 'the refusal names the missing function group').toMatch(/doesn't support function group code/);
        });

    test('API-GEN-18[kind-unsupported]: a kind the connector does not offer is refused 422 ("Unsupported credential kind …")',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.2 r2 / r3 (the kind is not checked by core: the connector decides; connector 422 "Unsupported credential kind {}")', 'inventory-api §9.3 row "unsupported kind"; interfaces#898 (the connector 422 stays 422)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, regName(`cred-kind-${stamp()}`), { kind: `QaNoSuchKind${stamp()}` }), SPEC, 'unsupported kind probe');
            expect(refused422(probe).join(' | ')).toMatch(/unsupported credential kind/i);
        });

    test('API-GEN-18[basic-no-attributes]: `attributes: []` answers 422, a JSON array with the two "Required attribute <label> not found." texts (the connector 422 is relayed as 422)',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.4 (POST Basic with attributes []: 422 array of two strings, never 500 or 400; BaseApiClient:738, interfaces#898)', 'inventory-api §9.2 r3 (AttributeDefinitionUtils:388)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, regName(`cred-noattr-${stamp()}`), { attributes: [] }), SPEC, 'empty attributes probe');
            const messages = refused422(probe);
            expect([...messages].sort()).toEqual([`Required attribute ${labelOf(c.usernameDef)} not found.`, `Required attribute ${labelOf(c.passwordDef)} not found.`].sort());
        });

    test('API-GEN-18[basic-no-username]: Basic without the username answers 422 ["Required attribute <Username label> not found."]',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.3 row "Basic without username / password"', 'inventory-api §9.2 r3 (username STRING required; AttributeDefinitionUtils:388)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const values: BasicValues = { password: randomSecret() };
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, regName(`cred-nouser-${stamp()}`), {}, values), SPEC, 'missing username probe');
            const messages = refused422(probe);
            expect(messages).toContain(`Required attribute ${labelOf(c.usernameDef)} not found.`);
            expect(messages.join(' | '), 'the password was sent: only the username is missing').not.toContain(labelOf(c.passwordDef));
        });

    test('API-GEN-18[basic-password-not-set]: a password attribute listed without content answers 422 ["Value of required attribute <Password label> not set."]',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.3 row "Basic without username / password" ("Value of required attribute Password not set.")', 'inventory-api §9.2 r3 (AttributeDefinitionUtils:397: the attribute is present, its content is null)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const values: BasicValues = { username: regName(`cu-${stamp()}`), password: null };
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, regName(`cred-nopw-${stamp()}`), {}, values), SPEC, 'password without content probe');
            expect(refused422(probe)).toContain(`Value of required attribute ${labelOf(c.passwordDef)} not set.`);
        });

    test('API-GEN-18[attribute-by-name]: an attribute by name without uuid is refused and no credential is left behind (core#2512: 404 and an orphan today)',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, bug: 'core#2512', rule: ['inventory-api §9.2 r11 (atomicity gap: the credential row is saved before the attribute content is written; core#2512, mechanism core#2449)', 'inventory-api §9.3 row "attribute by name only (no uuid)"; core#2451 (request attribute without uuid)'] }),
        async ({ api }, testInfo) => {
            const c = await credentialConnectorOrSkip(api);
            const name = regName(`cred-byname-${stamp()}`);
            const body = await basicBody(api, c, name, {}, undefined, { withUuid: false });
            const { probe } = await createCredentialProbe(api, body, SPEC, 'by-name attribute probe (core#2512)');
            // Ledger first: a refused create may have left a credential behind. Its unique name is the only handle (no uuid is answered).
            const rows = await adoptByName(api, '/api/v1/credentials', 'credentials', name, SPEC, 'orphan left by a refused create (core#2512)');
            testInfo.annotations.push({ type: 'observed', description: `status ${probe.status}; ${rows.length} credential(s) with the name afterwards` });
            expect(probe.status, 'a refused request is a 4xx, never a 5xx').toBeLessThan(500);
            if (probe.status >= 400) {
                if (probe.status === 422) expect422Messages(probe.text);
                else expectMessageObject(probe.text);
            }
            test.fail(true, 'core#2512: the credential row is saved before the attribute lookup fails; the refused request leaves an orphan credential');
            expect(probe.status >= 400 ? rows : [], 'a refused create leaves no credential with that name').toHaveLength(0);
        });

    test('API-GEN-18[connector-missing]: a create without connectorUuid is a 4xx with the error-contract body, never a 5xx (the first answer is annotated)',
        meta({ id: 'API-GEN-18', prio: 'P1', issue: ISSUE, rule: ['inventory-api §9.3 row "connectorUuid missing" (no written rule; inferred 500 from a null SecuredUUID)', 'inventory-api §1.2 r6 (4xx, never 5xx, for bad input: the negative-testing oracle). Not a bug tag until the defect is confirmed (then test.fail() + the ticket)'] }),
        async ({ api }, testInfo) => {
            const c = await credentialConnectorOrSkip(api);
            const { probe } = await createCredentialProbe(api, await basicBody(api, c, regName(`cred-noconnid-${stamp()}`), { connectorUuid: undefined }), SPEC, 'missing connectorUuid probe');
            testInfo.annotations.push({ type: 'observed', description: `status ${probe.status}: ${probe.text.slice(0, 120)}` });
            expect(probe.status, probe.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
            expect(probe.status, `a missing connectorUuid must not be a 5xx: ${probe.text.slice(0, 300)}`).toBeLessThan(500);
            if (probe.status === 422) expect422Messages(probe.text);
            else expectMessageObject(probe.text);
        });

    test('API-GEN-18[empty-password]: an empty-string password is accepted today (201); recorded as a pin, flips when the owner answers Q9',
        meta({ id: 'API-GEN-18', prio: 'P2', issue: ISSUE, pin: 'Q9', rule: ['inventory-api §9.3 row "empty-string password (API)" (201, observed, no written rule)', 'inventory-api §11.3 Q9 (is an empty-string password valid for a Basic credential through the API?)'] }),
        async ({ api }) => {
            const c = await credentialConnectorOrSkip(api);
            const values: BasicValues = { username: regName(`cu-${stamp()}`), password: '' };
            const name = regName(`cred-emptypw-${stamp()}`);
            const { probe, own } = await createCredentialProbe(api, await basicBody(api, c, name, {}, values), SPEC, 'empty password pin (Q9)');
            expect(probe.status, probe.text.slice(0, 300)).toBe(201);
            expect(own, 'the 201 answer carries the uuid').toBeTruthy();
            const row = await rowOf(api, '/api/v1/credentials', own!.uuid);
            expect([row?.name, row?.kind]).toEqual([name, 'Basic']);
        });
});

// ================================================================== API-GEN-19

/** The custom attributes a group request must carry on this tier (the required ones), plus the ones a row adds. */
async function groupCustom(api: GuardedApi, extra: Json[] = []): Promise<Json[]> {
    return [...(await requiredCustomFor(api, 'groups', regName('ca'))), ...extra];
}

test.describe('API-GEN-19 groups', { tag: tags.api }, () => {
    for (const [row, value, what] of NAME_ROWS) {
        test(`API-GEN-19[${row}]: ${what} group name is refused 422 ["Name must not be empty"]`,
            meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r1 (GroupServiceImpl.createGroup:95 "Name must not be empty")', 'inventory-api §10.3 row "name null / "" / "   "" (observed for whitespace)'] }),
            async ({ api }) => {
                const { probe } = await createGroupProbe(api, groupBody(value, { description: 'API-GEN-19 probe', customAttributes: await groupCustom(api) }), SPEC, `${row} probe`);
                expect(refused422(probe)).toEqual(['Name must not be empty']);
            });
    }

    test('API-GEN-19[duplicate]: the same name again answers 409 "Object of type \'Group\' identified by <name> already exists." and exactly one group has the name',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r1 (name lookup then 409 AlreadyExistException; not trimmed, case-sensitive)', 'inventory-api §10.3 row "duplicate name"; REG-CFG-06 (UI partner)'] }),
        async ({ api }) => {
            const first = await ownGroup(api, SPEC, { description: 'API-GEN-19 duplicate' }, { suffix: 'grp-dup' });
            const { probe } = await createGroupProbe(api, groupBody(first.name, { description: 'second', customAttributes: await groupCustom(api) }), SPEC, 'duplicate-name probe');
            expect(refusedWith(probe, 409)).toBe(`Object of type 'Group' identified by ${first.name} already exists.`);
            expect((await rowsNamed(api, '/api/v1/groups', first.name)).map((r) => r.uuid), 'exactly one group has the name: the first one').toEqual([first.uuid]);
        });

    test('API-GEN-19[put-overwrite]: PUT ignores the body name and overwrites description, e-mail and custom attribute content',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r3 (editGroup: the body name is ignored; description and email are overwritten; custom attributes are replaced wholesale)', 'inventory-api §10.4 (PUT own group: 200, name unchanged)'] }),
        async ({ api }) => {
            const attribute = await ownGroupAttribute(api, SPEC);
            const group = await ownGroup(api, SPEC, { description: 'description one', email: `${regName('one')}@example.test`, customAttributes: [customValue(attribute, 'v1')] }, { suffix: 'grp-put' });
            const otherName = regName(`grp-ignored-${stamp()}`);
            const email = `${regName('two')}@example.test`;

            const put = await putGroup(api, group.uuid, { name: otherName, description: 'description two', email, customAttributes: await groupCustom(api, [customValue(attribute, 'v2')]) });
            expect(put.status, put.text.slice(0, 300)).toBe(200);
            const detail = (await readGroup(api, group.uuid)).json as Json;
            expect(detail.name, 'the body name is ignored').toBe(group.name);
            expect(detail.description).toBe('description two');
            expect(detail.email).toBe(email);
            expect(valuesOf(detail, 'customAttributes', attribute.name), 'the custom attribute is overwritten').toEqual(['v2']);
            expect(await rowsNamed(api, '/api/v1/groups', otherName), 'no group carries the ignored name').toEqual([]);
        });

    test('API-GEN-19[put-omitted]: PUT without e-mail and custom attributes clears the e-mail and the omitted attribute loses its content',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r3 (null or omitted e-mail clears it; any custom attribute not sent loses its content: AttributeEngine:1814, PR core#1124)', 'inventory-api §10.3 row "PUT omitting customAttributes"'] }),
        async ({ api }) => {
            const attribute = await ownGroupAttribute(api, SPEC);
            const group = await ownGroup(api, SPEC, { description: 'description one', email: `${regName('one')}@example.test`, customAttributes: [customValue(attribute, 'v1')] }, { suffix: 'grp-omit' });
            const before = (await readGroup(api, group.uuid)).json as Json;
            expect(valuesOf(before, 'customAttributes', attribute.name), 'precondition: the attribute holds its value').toEqual(['v1']);

            // Only the tier's required custom attributes are sent again: the own attribute and the e-mail are omitted.
            const put = await putGroup(api, group.uuid, { description: 'description three', customAttributes: await groupCustom(api) });
            expect(put.status, put.text.slice(0, 300)).toBe(200);
            const detail = (await readGroup(api, group.uuid)).json as Json;
            expect(detail.description).toBe('description three');
            expect(detail.email ?? null, 'the omitted e-mail is cleared').toBeNull();
            expect(valuesOf(detail, 'customAttributes', attribute.name), 'the omitted custom attribute lost its content').toEqual([]);
        });

    test('API-GEN-19[unknown-uuid]: GET, PUT and DELETE of an unknown group answer 404 "Object of type \'Group\' identified by <uuid> is not found."',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.3 row "unknown uuid on GET / PUT / DELETE" (NotFoundException: ExceptionHandlingAdvice:73-81)', 'inventory-api §10.4 (GET / PUT / DELETE unknown uuid 404)'] }),
        async ({ api }) => {
            const unknown = api.probeUuid();
            const text = `Object of type 'Group' identified by ${unknown} is not found.`;
            expect(refusedWith(await readGroup(api, unknown), 404), 'GET').toBe(text);
            expect(refusedWith(await putGroup(api, unknown, { description: 'x', customAttributes: await groupCustom(api) }), 404), 'PUT').toBe(text);
            expect(refusedWith(await deleteOwnObject(api, 'groups', unknown), 404), 'DELETE').toBe(text);
        });

    test('API-GEN-19[malformed-uuid]: GET with a malformed uuid answers 422 ["Invalid UUID <value> in the request"]',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.4 (malformed uuid 422 "Invalid UUID ...": GroupControllerImpl parses the path with SecuredUUID.fromString)', 'inventory-api §1.3 (path types differ per resource: certificates 400, groups 422)'] }),
        async ({ api }) => {
            const p = await readProbe(api, '/api/v1/groups/not-a-uuid');
            expect(refused422(p)).toEqual(['Invalid UUID not-a-uuid in the request']);
        });

    test('API-GEN-19[malformed-uuid-write]: PUT and DELETE with a malformed uuid answer 422 ["Invalid UUID <value> in the request"]',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.4 (malformed uuid 422 "Invalid UUID ...")', 'GroupControllerImpl.editGroup / deleteGroup: SecuredUUID.fromString(uuid) is the first statement, before any lookup'] }),
        async ({ api }) => {
            const text = ['Invalid UUID not-a-uuid in the request'];
            expect(refused422(await putGroup(api, 'not-a-uuid', { description: 'x', customAttributes: await groupCustom(api) })), 'PUT').toEqual(text);
            expect(refused422(await deleteOwnObject(api, 'groups', 'not-a-uuid')), 'DELETE').toEqual(text);
        });

    test('API-GEN-19[delete-own]: deleting an own group answers 204, the group is gone and the certificate that had it shows no group',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r5 (delete never refused for being in use: removes every group association; certificates stay without that group)', 'inventory-api §10.3 row "DELETE group in use by certificates"'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const certificate = await ownCertificate(api, SPEC);
            const group = await ownGroup(api, SPEC, { description: 'API-GEN-19 delete' }, { suffix: 'grp-del' });
            await setGroups(api, certificate.uuid, [group.uuid]);
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid)), 'precondition: the certificate is in the group').toEqual([group.uuid]);

            await deleteVerified(api, 'groups', group, 'Group');
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid)), 'the certificate shows no group any more').toEqual([]);
            expect(await rowOf(api, '/api/v1/groups', group.uuid), 'the group is not listed any more').toBeUndefined();
        });

    test('API-GEN-19[bulk-delete]: bulk delete [own, unknown] answers 204; the own group is removed, the unknown one is skipped',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: 'inventory-api §10.2 r5 (bulk DELETE /v1/groups skips unknown uuids: GroupServiceImpl.bulkDeleteGroup)' }),
        async ({ api }) => {
            const group = await ownGroup(api, SPEC, { description: 'API-GEN-19 bulk' }, { suffix: 'grp-bulk' });
            const bulk = await bulkDeleteObjects(api, 'groups', [group.uuid, api.probeUuid()]);
            expect(bulk.status, bulk.text.slice(0, 300)).toBe(204);
            expect(bulk.text, 'a 204 has no body').toBe('');
            await readBack404(api, 'groups', group.uuid, 'Group');
            recordDeleted('groups', group, SPEC, 'bulk delete under test: 204, then 404 on read-back');
        });

    test('API-GEN-19[users]: GET /v1/groups/{uuid}/users of an own group answers 200 [] (an unknown group: 404)',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r9 / §10.4 (GET /v1/groups/{uuid}/users: members of the group; core#2210, interfaces#950)', 'GroupServiceImpl.getGroupUsers (a new group has no member)'] }),
        async ({ api }) => {
            const group = await ownGroup(api, SPEC, { description: 'API-GEN-19 members' }, { suffix: 'grp-users' });
            const members = await readProbe(api, `/api/v1/groups/${group.uuid}/users`);
            expect(members.status, members.text.slice(0, 300)).toBe(200);
            expect(members.json, 'a group nobody joined has no member').toEqual([]);
            const unknown = api.probeUuid();
            expect(refusedWith(await readProbe(api, `/api/v1/groups/${unknown}/users`), 404)).toBe(`Object of type 'Group' identified by ${unknown} is not found.`);
        });

    test('API-GEN-19[list-detail]: list items have null customAttributes, the detail has the array',
        meta({ id: 'API-GEN-19', prio: 'P1', issue: ISSUE, rule: 'inventory-api §10.2 r10 (list items come from Group::mapToDto: customAttributes null; the detail adds the custom attributes array: GroupServiceImpl:74-87)' }),
        async ({ api }) => {
            const group = await ownGroup(api, SPEC, { description: 'API-GEN-19 list vs detail' }, { suffix: 'grp-shape' });
            const row = await rowOf(api, '/api/v1/groups', group.uuid);
            expect(row, 'the own group is listed').toBeTruthy();
            expect(row!.customAttributes ?? null, 'a list item has no customAttributes').toBeNull();
            const detail = (await readGroup(api, group.uuid)).json as Json;
            expect(Array.isArray(detail.customAttributes), 'the detail carries the customAttributes array').toBe(true);
        });

    test('API-GEN-19[pin-q8]: a 301-character description, the e-mail "notanemail" and a trailing-space name are accepted (201) although the UI blocks them',
        meta({ id: 'API-GEN-19', prio: 'P2', issue: ISSUE, pin: 'Q8', rule: ['inventory-api §10.2 r2 (the UI limits are UI-only: description 300, e-mail pattern, name regex; the API accepts anything)', 'inventory-api §10.3 rows "description > 300 / email notanemail" and "name differing only by trailing space"; §11.3 Q8'] }),
        async ({ api }) => {
            const custom = await groupCustom(api);
            const accepted = async (what: string, name: string, fields: { description?: string; email?: string }): Promise<Json> => {
                const { probe, own } = await createGroupProbe(api, groupBody(name, { ...fields, customAttributes: custom }), SPEC, `Q8 pin: ${what}`);
                expect(probe.status, `${what}: ${probe.text.slice(0, 300)}`).toBe(201);
                expect(own, `${what}: the 201 answer carries the uuid`).toBeTruthy();
                return (await readGroup(api, own!.uuid)).json as Json;
            };

            const longDescription = 'd'.repeat(301);
            const d = await accepted('description of 301 characters', regName(`grp-q8-desc-${stamp()}`), { description: longDescription });
            expect((d.description as string).length, 'the 301 characters are stored').toBe(301);
            const e = await accepted('e-mail without an address shape', regName(`grp-q8-mail-${stamp()}`), { email: 'notanemail' });
            expect(e.email).toBe('notanemail');
            const trailing = regName(`grp-q8-space-${stamp()}`) + ' ';
            const t = await accepted('name with a trailing space', trailing, {});
            expect(t.name, 'the trailing space is stored (the name is not trimmed)').toBe(trailing);
        });
});

// ================================================================== API-GEN-20

/** An own certificate and `n` own groups: the data of the assignment rows. */
async function assignmentSeed(api: GuardedApi, n: number) {
    const certificate = await ownCertificate(api, SPEC);
    const groups = [];
    for (let i = 1; i <= n; i++) groups.push(await ownGroup(api, SPEC, { description: `API-GEN-20 group ${i}` }, { suffix: `grp-as${i}` }));
    return { certificate, groups };
}

/** The group names of a group list, sorted, joined as core writes them into the history. */
const joined = (names: string[]): string => [...names].sort().join(', ');

test.describe('API-GEN-20 group assignment replaces the set', { tag: tags.api }, () => {
    test('API-GEN-20[replace]: [g1, g2] -> both; key omitted or null -> unchanged; [g3] -> only g3; [] -> none; the history reads "old -> new"',
        meta({ id: 'API-GEN-20', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r6 (PATCH /v1/certificates/{uuid} groupUuids: omitted or null = no change; [] = remove all; non-empty = replace the set; history UPDATE_GROUP "<old> -> <new>": CertificateServiceImpl:3352-3381)', 'core#683, core#630 (objects in several groups; remove owner and group)'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1, g2, g3] } = await assignmentSeed(api, 3);
            const groupsNow = async (): Promise<string[]> => groupUuidsOf(await certificateDetail(api, certificate.uuid));
            const assign = async (label: string, body: Json, expected: string[]): Promise<void> => {
                const p = await patchCertificate(api, certificate.uuid, body);
                expect(p.status, `${label}: ${p.text.slice(0, 300)}`).toBe(204);
                expect(p.text, `${label}: a 204 has no body`).toBe('');
                expect(await groupsNow(), `${label}: the final set read back`).toEqual([...expected].sort());
            };

            expect(await groupsNow(), 'precondition: no group').toEqual([]);
            await assign('[g1, g2]', { groupUuids: [g1.uuid, g2.uuid] }, [g1.uuid, g2.uuid]);
            await assign('key omitted', {}, [g1.uuid, g2.uuid]);
            await assign('groupUuids null', { groupUuids: null }, [g1.uuid, g2.uuid]);
            await assign('[g3] replaces the set', { groupUuids: [g3.uuid] }, [g3.uuid]);
            await assign('[] removes all', { groupUuids: [] }, []);

            const changes = groupChanges(await certificateHistory(api, certificate.uuid)).map(changeKey).sort();
            expect(changes, 'three real changes, each written "old -> new" (undefined = no group); the no-ops wrote nothing').toEqual([
                `undefined -> ${joined([g1.name, g2.name])}`,
                `${joined([g1.name, g2.name])} -> ${g3.name}`,
                `${g3.name} -> undefined`,
            ].sort());
        });

    test('API-GEN-20[duplicates]: [g1, g1] gives one membership',
        meta({ id: 'API-GEN-20', prio: 'P1', issue: ISSUE, rule: 'inventory-api §10.2 r6 (ResourceObjectAssociationServiceImpl.setGroups: duplicates collapse because it is a Set)' }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1] } = await assignmentSeed(api, 1);
            const p = await patchCertificate(api, certificate.uuid, { groupUuids: [g1.uuid, g1.uuid] });
            expect(p.status, p.text.slice(0, 300)).toBe(204);
            const detail = await certificateDetail(api, certificate.uuid);
            expect(groupUuidsOf(detail), 'one membership, not two').toEqual([g1.uuid]);
            expect(detail.groups as Json[], 'the detail lists the group once').toHaveLength(1);
        });

    test('API-GEN-20[identical-set]: assigning the identical set answers 204 and writes no new history event',
        meta({ id: 'API-GEN-20', prio: 'P1', issue: ISSUE, rule: 'inventory-api §10.2 r6 (an identical set is a no-op without history: CertificateServiceImpl.updateCertificateGroups returns before the event)' }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1, g2] } = await assignmentSeed(api, 2);
            await setGroups(api, certificate.uuid, [g1.uuid, g2.uuid]);
            const before = groupEventCount(await certificateHistory(api, certificate.uuid));
            expect(before, 'precondition: the first assignment wrote one event').toBe(1);

            const again = await patchCertificate(api, certificate.uuid, { groupUuids: [g2.uuid, g1.uuid] });
            expect(again.status, again.text.slice(0, 300)).toBe(204);
            expect(groupEventCount(await certificateHistory(api, certificate.uuid)), 'no new event for an identical set').toBe(before);
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid))).toEqual([g1.uuid, g2.uuid].sort());
        });

    test('API-GEN-20[invalid-uuid]: groupUuids ["not-a-uuid"] answers 400 "The request could not be processed." and the groups stay',
        meta({ id: 'API-GEN-20', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.3 row "groupUuids with a non-UUID string" (UUID::fromString IllegalArgumentException: ExceptionHandlingAdvice:155-160)', 'inventory-api §1.2 r3 (a 400 is {message})'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1] } = await assignmentSeed(api, 1);
            await setGroups(api, certificate.uuid, [g1.uuid]);
            const bad = await patchCertificate(api, certificate.uuid, { groupUuids: ['not-a-uuid'] });
            expect(refusedWith(bad, 400)).toBe('The request could not be processed.');
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid)), 'the refused request changed nothing').toEqual([g1.uuid]);
        });

    test('API-GEN-20[owner-only]: an owner-only PATCH leaves the groups alone',
        meta({ id: 'API-GEN-20', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r6 (updateCertificateObjects: each member is applied only when sent)', 'core#630 (remove certificate owner and group, keep Unassigned)'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1] } = await assignmentSeed(api, 1);
            const owner = await createOwnUser(api, 'cfg-owner', SPEC);
            await setGroups(api, certificate.uuid, [g1.uuid]);
            const events = groupEventCount(await certificateHistory(api, certificate.uuid));

            const p = await patchCertificate(api, certificate.uuid, { ownerUuid: owner.uuid });
            expect(p.status, p.text.slice(0, 300)).toBe(204);
            const detail = await certificateDetail(api, certificate.uuid);
            expect(detail.ownerUuid, 'the owner is set').toBe(owner.uuid);
            expect(groupUuidsOf(detail), 'the groups are untouched').toEqual([g1.uuid]);
            expect(groupEventCount(await certificateHistory(api, certificate.uuid)), 'no group event').toBe(events);
        });

    test('API-GEN-20[archived]: an archived own certificate refuses a group change with 422 (the archived text) and keeps its groups',
        meta({ id: 'API-GEN-20', prio: 'P1', issue: ISSUE, rule: ['inventory-api §10.2 r7 (CertificateServiceImpl:3357: "Certificate with UUID %s is archived and its groups cannot be updated."; core#1098, ilm#71)', 'inventory-api §10.3 row "archived certificate"'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1, g2] } = await assignmentSeed(api, 2);
            await setGroups(api, certificate.uuid, [g1.uuid]);
            await archiveOwnCertificate(api, certificate.uuid);

            const p = await patchCertificate(api, certificate.uuid, { groupUuids: [g2.uuid] });
            expect(refused422(p)).toEqual([`Certificate with UUID ${certificate.uuid} is archived and its groups cannot be updated.`]);
            const detail = await certificateDetail(api, certificate.uuid);
            expect(detail.archived).toBe(true);
            expect(groupUuidsOf(detail), 'the refused change left the groups').toEqual([g1.uuid]);
        });
});

// Local stack only until triaged: the inferred transactional gap (inventory-api §10.5 r7) may leave an own certificate without its
// previous groups; the request itself only names the own certificate and own groups (a probe uuid is the unknown group).
test.describe('API-GEN-20 group assignment: unknown group (local stack)', { tag: tags.api }, () => {
    describeLocal(test);

    test('API-GEN-20[unknown-group]: an unknown group uuid answers 404 and the previous groups survive',
        meta({ id: 'API-GEN-20', prio: 'P1', issue: ISSUE, local: true, rule: ['inventory-api §10.3 row "groupUuids with an unknown group" (404 NotFoundException(Group); previous groups may already be removed)', 'inventory-api §10.5 r7 (inferred: setGroups deletes first, the checked NotFoundException does not roll back: same mechanism as core#2449 / core#2512). Not a @bug until triaged'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1, g2] } = await assignmentSeed(api, 2);
            await setGroups(api, certificate.uuid, [g1.uuid, g2.uuid]);
            const unknown = api.probeUuid();

            const p = await patchCertificate(api, certificate.uuid, { groupUuids: [unknown] });
            testInfo.annotations.push({ type: 'observed', description: `status ${p.status}` });
            expect(refusedWith(p, 404)).toBe(`Object of type 'Group' identified by ${unknown} is not found.`);
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid)), 'the previous groups survive the refused request').toEqual([g1.uuid, g2.uuid].sort());
        });
});

// ================================================================== API-GEN-28

/** The first connected pre-existing authority with a required RA-profile attribute, its valid base attributes and the label; else the rows skip. */
async function raSetupOrSkip(api: GuardedApi) {
    const pick = await authorityWithRequiredAttribute(api);
    test.skip(!pick.ok, pick.skip ?? 'no authority');
    const authority = pick.ok!;
    const def = authority.required[0];
    return { authority, def, label: labelOf(def), base: (await validRaAttributes(api, authority.uuid)) ?? [] };
}

/** A connector that is restarting answers 503: an environment blocker (never retried, never a pass), unlike 502 / 400, which are the defect under test. */
const skipOn503 = (p: Probe): void => test.skip(p.status === 503, 'the authority connector answered 503 (unreachable or restarting): environment blocker, not retried');

test.describe('API-GEN-28 RA profile with a required attribute empty (API leg)', { tag: tags.api }, () => {
    const RULES = ['inventory-api §1.2 r4 (a connector 422 becomes ValidationException and so a Core 422 with the connector\'s messages: BaseApiClient:738, interfaces#898)', 'inventory-api §1.4 (RA-profile attribute validation against a connected authority connector with an empty required attribute); ilm#428 step 5'];

    test('API-GEN-28[validate-missing]: validating RA-profile attributes without the required one answers 422 ["Required attribute <label> not found."] (not 400 / 502)',
        meta({ id: 'API-GEN-28', prio: 'P1', issue: ISSUE, rule: RULES }),
        async ({ api }) => {
            const { authority, def, label, base } = await raSetupOrSkip(api);
            const p = await validateRaAttributes(api, authority.uuid, missingArm(base, def));
            skipOn503(p);
            expect(refused422(p)).toContain(requiredNotFound(label));
        });

    test('API-GEN-28[validate-empty]: validating RA-profile attributes with the required one empty answers 422 ["Value of required attribute <label> not set."]',
        meta({ id: 'API-GEN-28', prio: 'P1', issue: ISSUE, rule: RULES }),
        async ({ api }) => {
            const { authority, def, label, base } = await raSetupOrSkip(api);
            const p = await validateRaAttributes(api, authority.uuid, emptyArm(base, def));
            skipOn503(p);
            expect(refused422(p)).toContain(requiredNotSet(label));
        });

    test('API-GEN-28[validate-valid]: the valid attributes of an existing RA profile validate with 200 (control)',
        meta({ id: 'API-GEN-28', prio: 'P1', issue: ISSUE, rule: RULES }),
        async ({ api }) => {
            const { authority, base } = await raSetupOrSkip(api);
            test.skip(!base.length, 'the authority has no enabled pre-existing RA profile to copy valid attributes from');
            const p = await validateRaAttributes(api, authority.uuid, base);
            skipOn503(p);
            expect(p.status, p.text.slice(0, 300)).toBe(200);
        });

    for (const [row, arm, expected] of [
        ['create-missing', missingArm, requiredNotFound],
        ['create-empty', emptyArm, requiredNotSet],
    ] as const) {
        test(`API-GEN-28[${row}]: creating an RA profile with the required attribute ${row === 'create-missing' ? 'missing' : 'empty'} answers 422 with the connector's text and creates nothing`,
            meta({ id: 'API-GEN-28', prio: 'P1', issue: ISSUE, rule: RULES }),
            async ({ api }) => {
                const { authority, def, label, base } = await raSetupOrSkip(api);
                const name = regName(`ra-neg-${row}-${stamp()}`);
                const { probe } = await createRaProfileProbe(api, authority.uuid, await raProfileBody(api, name, arm(base, def)), SPEC, `${row} probe`);
                skipOn503(probe);
                // Ledger first for a leak: any RA profile with this unique name is the run's, whatever the answer was.
                const rows = await adoptByName(api, '/api/v1/raProfiles', 'raProfiles', name, SPEC, 'RA profile left by a refused create', { authority: authority.uuid });
                expect(refused422(probe)).toContain(expected(label));
                expect(rows, 'no RA profile with that name was created').toEqual([]);
            });
    }
});
