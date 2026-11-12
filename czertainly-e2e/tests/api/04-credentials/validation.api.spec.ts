/**
 * API-GEN-17, API-GEN-18 — Credential create validation, one test per row. ilm#428.
 *
 * WHAT: 1. The valid Basic body (name, connector, kind, username and password attributes) → 201 with the uuid; the credential is listed
 *          enabled.
 *       2. A blank, null or whitespace-only name → 422 "Name must not be empty"; the same name again → 409 and exactly one credential has
 *          it.
 *       3. A connectorUuid that is not a UUID → 422 "Invalid UUID <value> in the request"; an unknown connector → 404; a connector without
 *          the credential function group → 422; a missing connectorUuid → a 4xx with the error-contract body, never a 5xx.
 *       4. A kind the connector does not offer → 422 "Unsupported credential kind …"; `attributes: []` → 422 with two texts, a missing
 *          username → 422, a password attribute without content → 422 "Value of required attribute … not set.".
 *       5. A name-only attribute (no uuid) is refused and leaves no credential behind (core#2512: an orphan today, test.fail).
 *       6. An empty-string password is accepted today (201); the row records this behaviour until the product owner decides.
 * WHY: core checks the name and the connector; the connector decides the kind and the required attributes, and its 422 is relayed as 422
 *      (interfaces#898). The credential row is saved before the attribute content is written, which is the atomicity gap behind core#2512
 *      (mechanism core#2449, request attribute without uuid core#2451).
 * HOW: create-only on shared tiers with run-prefixed names; every create goes through a probe helper that records the ledger line before
 *      any assertion, and an orphan of a refused create is adopted by its unique name. The wrong-function-group row skips without a
 *      pre-existing connector that lacks the credential group. The empty-password row records today's behaviour and is P3.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { expect422Messages, expectMessageObject } from '../../../utils/regression/errorContract';
import { basicBody, credentialConnectorOrSkip, refused422, refusedWith } from '../../../utils/regression/inventory/configProbes';
import { adoptByName, connectorWithoutCredentialGroup, probeCredential, createOwnBasicCredential, randomSecret, findRowByUuid } from '../../../utils/regression/inventory/credentialsApi';
import { labelOf } from '../../../utils/regression/inventory/raProfileValidation';
import { rowsNamed } from '../../../utils/regression/listReads';
import { uniqueSuffix } from '../../../utils/regression/text';
import type { BasicValues } from '../../../utils/regression/inventory/credentialsApi';
import { ownName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { createdUuid } from '../../../utils/regression/ownCrud';

const ISSUE = 'ilm#428';
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ================================================================== API-GEN-18

const NAME_ROWS: ReadonlyArray<readonly [row: string, value: string | null, what: string]> = [
    ['name-blank', '', 'a blank'],
    ['name-null', null, 'a null'],
    ['name-whitespace', '   ', 'a whitespace-only'],
];

test.describe('credential validation', { tag: tags.api }, () => {
    test('the valid Basic body is created (201 with the uuid) and listed enabled',
        testMeta({ id: 'API-GEN-18', row: 'control', prio: 'P1', issue: ISSUE, rule: ['create needs name, connectorUuid, kind and attributes; Basic = username + password', 'the control with the attribute uuid still gives 201: core#2512 is the by-name shape'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const name = ownName('cred-ctl');
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, name), 'matrix control');
            const createdId = createdUuid(probe);
            expect(probe.status, probe.text.slice(0, 300)).toBe(201);
            expect(createdId, 'the 201 answer carries the uuid').toBeTruthy();
            expect(createdId!).toMatch(UUID_FORMAT);
            const row = await findRowByUuid(api, '/api/v1/credentials', createdId!);
            expect(row, 'the credential is listed').toBeTruthy();
            expect([row!.name, row!.kind, row!.enabled, row!.connectorUuid]).toEqual([name, 'Basic', true, c.uuid]);
        });

    for (const [row, value, what] of NAME_ROWS) {
        test(`${what} name is refused 422`,
            testMeta({ id: 'API-GEN-18', row, prio: 'P1', issue: ISSUE, rule: ['blank name 422 "Name must not be empty": CredentialServiceImpl', 'name null, empty or blank'] }),
            async ({ api, own }) => {
                const c = await credentialConnectorOrSkip(api);
                const probe = await probeCredential(api, own.spec, await basicBody(api, c, value), `${row} probe`);
                expect(refused422(probe)).toEqual(['Name must not be empty']);
            });
    }

    test('the same name again answers 409 and exactly one credential has the name',
        testMeta({ id: 'API-GEN-18', row: 'duplicate', prio: 'P1', issue: ISSUE, rule: ['duplicate name: exact, case-sensitive; 409 AlreadyExistException', 'a duplicate name is refused; the credential form in the UI refuses it too', '409 "Object of type \'Credential\' identified by <name> already exists."'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const first = await createOwnBasicCredential(api, own.spec, 'dup', { connector: c });
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, first.name), 'duplicate-name probe');
            expect(refusedWith(probe, 409)).toBe(`Object of type 'Credential' identified by ${first.name} already exists.`);
            const rows = await rowsNamed(api, '/api/v1/credentials', first.name);
            expect(rows.map((r) => r.uuid), 'exactly one credential has the name: the first one').toEqual([first.uuid]);
        });

    test('a connectorUuid that is not a UUID answers 422',
        testMeta({ id: 'API-GEN-18', row: 'connector-not-uuid', prio: 'P1', issue: ISSUE, rule: ['connectorUuid is not a UUID (SecuredUUID.fromString: Invalid UUID <v> in the request)', 'order of checks: the connector is resolved after the name checks', '422 ["Invalid UUID <value> in the request"]'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-uuid'), { connectorUuid: 'not-a-uuid' }), 'bad connector uuid probe');
            expect(refused422(probe)).toEqual(['Invalid UUID not-a-uuid in the request']);
        });

    test('an unknown connector answers 404',
        testMeta({ id: 'API-GEN-18', row: 'connector-unknown', prio: 'P1', issue: ISSUE, rule: ['connectorUuid unknown (ConnectorServiceImpl: NotFoundException(Connector); inferred wording, observed status)', '404 "Object of type \'Connector\' identified by <uuid> is not found."'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const unknown = api.probeUuid();
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-noconn'), { connectorUuid: unknown }), 'unknown connector probe');
            expect(refusedWith(probe, 404)).toBe(`Object of type 'Connector' identified by ${unknown} is not found.`);
        });

    test('a connector without the credential group is refused 422',
        testMeta({ id: 'API-GEN-18', row: 'connector-no-credential-group', prio: 'P1', issue: ISSUE, rule: ['ConnectorServiceImpl.validateFunctionGroup: "Connector {} doesn\'t support function group code {}"', 'a connector without the credentialProvider function group', '422 ("Connector <n> doesn\'t support function group code …")'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const other = await connectorWithoutCredentialGroup(api);
            test.skip(!other, 'no pre-existing connector with function groups but without credentialProvider on this tier');
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-nofg'), { connectorUuid: other!.uuid }), 'wrong function group probe');
            const messages = refused422(probe);
            expect(messages.join(' | '), 'the refusal names the missing function group').toMatch(/doesn't support function group code/);
        });

    test('a kind the connector does not offer is refused 422',
        testMeta({ id: 'API-GEN-18', row: 'kind-unsupported', prio: 'P1', issue: ISSUE, rule: ['the kind is not checked by core: the connector decides; connector 422 "Unsupported credential kind {}"', 'unsupported kind; interfaces#898 (the connector 422 stays 422)', '422 ("Unsupported credential kind …")'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-kind'), { kind: `QaNoSuchKind${uniqueSuffix()}` }), 'unsupported kind probe');
            expect(refused422(probe).join(' | ')).toMatch(/unsupported credential kind/i);
        });

    test('`attributes: []` answers 422 with a JSON array of two texts',
        testMeta({ id: 'API-GEN-18', row: 'basic-no-attributes', prio: 'P1', issue: ISSUE, rule: ['POST Basic with attributes []: 422 array of two strings, never 500 or 400; BaseApiClient, interfaces#898', 'AttributeDefinitionUtils', 'the two texts are "Required attribute <label> not found."; the connector 422 is relayed as 422'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-noattr'), { attributes: [] }), 'empty attributes probe');
            const messages = refused422(probe);
            expect([...messages].sort()).toEqual([`Required attribute ${labelOf(c.usernameDef)} not found.`, `Required attribute ${labelOf(c.passwordDef)} not found.`].sort());
        });

    test('Basic without the username answers 422',
        testMeta({ id: 'API-GEN-18', row: 'basic-no-username', prio: 'P1', issue: ISSUE, rule: ['Basic without username / password', 'username STRING required; AttributeDefinitionUtils', '422 ["Required attribute <Username label> not found."]'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const values: BasicValues = { password: randomSecret() };
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-nouser'), {}, values), 'missing username probe');
            const messages = refused422(probe);
            expect(messages).toContain(`Required attribute ${labelOf(c.usernameDef)} not found.`);
            expect(messages.join(' | '), 'the password was sent: only the username is missing').not.toContain(labelOf(c.passwordDef));
        });

    test('a password attribute listed without content answers 422',
        testMeta({ id: 'API-GEN-18', row: 'basic-password-not-set', prio: 'P1', issue: ISSUE, rule: ['Basic without username / password ("Value of required attribute Password not set.")', 'AttributeDefinitionUtils: the attribute is present, its content is null', '422 ["Value of required attribute <Password label> not set."]'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const values: BasicValues = { username: ownName('cu'), password: null };
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-nopw'), {}, values), 'password without content probe');
            expect(refused422(probe)).toContain(`Value of required attribute ${labelOf(c.passwordDef)} not set.`);
        });

    test('a name-only attribute is refused and no credential is left behind',
        testMeta({ id: 'API-GEN-18', row: 'attribute-by-name', prio: 'P1', issue: ISSUE, bug: 'core#2512', rule: ['atomicity gap: the credential row is saved before the attribute content is written; core#2512, mechanism core#2449', 'attribute by name only (no uuid); core#2451 (request attribute without uuid)', 'core#2512: 404 and an orphan today'] }),
        async ({ api, own }, testInfo) => {
            const c = await credentialConnectorOrSkip(api);
            const name = ownName('cred-byname');
            const body = await basicBody(api, c, name, {}, undefined, { withUuid: false });
            const probe = await probeCredential(api, own.spec, body, 'by-name attribute probe (core#2512)');
            // Ledger first: a refused create may have left a credential behind. Its unique name is the only handle (no uuid is answered).
            const rows = await adoptByName(api, '/api/v1/credentials', 'credentials', name, own.spec, 'orphan left by a refused create (core#2512)');
            testInfo.annotations.push({ type: 'observed', description: `status ${probe.status}; ${rows.length} credential(s) with the name afterwards` });
            expect(probe.status, 'a refused request is a 4xx, never a 5xx').toBeLessThan(500);
            if (probe.status >= 400) {
                if (probe.status === 422) expect422Messages(probe.text);
                else expectMessageObject(probe.text);
            }
            test.fail(true, 'core#2512: the credential row is saved before the attribute lookup fails; the refused request leaves an orphan credential');
            expect(probe.status >= 400 ? rows : [], 'a refused create leaves no credential with that name').toHaveLength(0);
        });

    test('a create without connectorUuid is a 4xx with the error-contract body',
        testMeta({ id: 'API-GEN-18', row: 'connector-missing', prio: 'P1', issue: ISSUE, rule: ['connectorUuid missing (no written rule; inferred 500 from a null SecuredUUID)', '4xx, never 5xx, for bad input: the negative-testing oracle. A confirmed defect: core#2585, marked as a known bug', 'never a 5xx (the first answer is annotated)'] }),
        async ({ api, own }, testInfo) => {
            const c = await credentialConnectorOrSkip(api);
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-noconnid'), { connectorUuid: undefined }), 'missing connectorUuid probe');
            testInfo.annotations.push({ type: 'observed', description: `status ${probe.status}: ${probe.text.slice(0, 120)}` });
            expect(probe.status, probe.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
            if (probe.status === 422) expect422Messages(probe.text);
            else expectMessageObject(probe.text);
        });

    test('a create without connectorUuid is never a 5xx',
        testMeta({ id: 'API-GEN-18', row: 'connector-missing-5xx', prio: 'P1', issue: ISSUE, bug: 'core#2585', rule: ['connectorUuid missing: 4xx, never 5xx, for bad input (the negative-testing oracle); core#2585: 500 today'] }),
        async ({ api, own }, testInfo) => {
            const c = await credentialConnectorOrSkip(api);
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, ownName('cred-noconnid5'), { connectorUuid: undefined }), 'missing connectorUuid probe (5xx check)');
            testInfo.annotations.push({ type: 'observed', description: `status ${probe.status}: ${probe.text.slice(0, 120)}` });
            expect(probe.status, probe.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
            // Known bug: a missing connectorUuid answers 500 today.
            test.fail(true, 'core#2585: a credential create without connectorUuid answers 500 instead of a 4xx');
            expect(probe.status, `a missing connectorUuid must not be a 5xx: ${probe.text.slice(0, 300)}`).toBeLessThan(500);
        });

    test('an empty-string password is accepted today (201)',
        testMeta({ id: 'API-GEN-18', row: 'empty-password', prio: 'P3', issue: ISSUE, pin: 'empty-password-accepted', rule: ['empty-string password through the API (201, observed, no written rule)', 'open question: is an empty-string password valid for a Basic credential through the API?', 'flips when the product owner decides'] }),
        async ({ api, own }) => {
            const c = await credentialConnectorOrSkip(api);
            const values: BasicValues = { username: ownName('cu'), password: '' };
            const name = ownName('cred-emptypw');
            const probe = await probeCredential(api, own.spec, await basicBody(api, c, name, {}, values), 'empty password accepted');
            const createdId = createdUuid(probe);
            expect(probe.status, probe.text.slice(0, 300)).toBe(201);
            expect(createdId, 'the 201 answer carries the uuid').toBeTruthy();
            const row = await findRowByUuid(api, '/api/v1/credentials', createdId!);
            expect([row?.name, row?.kind]).toEqual([name, 'Basic']);
        });
});
