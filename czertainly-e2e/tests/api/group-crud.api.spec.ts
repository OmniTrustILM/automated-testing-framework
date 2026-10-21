/**
 * Groups: name rules, duplicates, PUT semantics (the name is ignored, omitted members are cleared), unknown and
 * malformed uuids, values the UI blocks but the API accepts, delete, bulk delete, members, list against detail.
 * Shared tiers: create-only with run-prefixed names; every create is in the ledger before the first assertion.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { deleteAndVerify, expectGoneWith404, refused422, refusedWith } from '../../utils/regression/inventory/configProbes';
import { readProbe } from '../../utils/regression/inventory/searchApi';
import type { Json } from '../../utils/regression/inventory/searchApi';
import { bulkDeleteObjects, findRowByUuid, valuesOf, deleteOwnConfigObject } from '../../utils/regression/inventory/credentialsApi';
import { certificateDetail, createGroupProbe, groupBody, ownGroup, ownGroupAttribute, putGroup, readGroup } from '../../utils/regression/inventory/groupProbes';
import { customAttributeRequest, requiredCustomAttributes } from '../../utils/regression/customAttributes';
import { groupUuidsOf, setCertificateGroups } from '../../utils/regression/ownGroups';
import { uploadOwnSelfSigned } from '../../utils/regression/ownCertificates';
import { rowsNamed } from '../../utils/regression/listReads';
import { uniqueStamp } from '../../utils/regression/text';
import { recordDeleted } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import type { GuardedApi } from '../../utils/regression/guard/types';

const SPEC = 'API-GEN-17';
const ISSUE = 'ilm#428';

// ================================================================== API-GEN-18

const NAME_ROWS: ReadonlyArray<readonly [row: string, value: string | null, what: string]> = [
    ['name-blank', '', 'a blank'],
    ['name-null', null, 'a null'],
    ['name-whitespace', '   ', 'a whitespace-only'],
];

// ================================================================== API-GEN-19

/** The custom attributes a group request must carry on this tier (the required ones), plus the ones a row adds. */
async function groupCustom(api: GuardedApi, extra: Json[] = []): Promise<Json[]> {
    return [...(await requiredCustomAttributes(api, 'groups', runName('ca'))), ...extra];
}

test.describe('groups', { tag: tags.api }, () => {
    for (const [row, value, what] of NAME_ROWS) {
        test(`${what} group name is refused 422`,
            testMeta({ id: 'API-GEN-19', row, prio: 'P1', issue: ISSUE, rule: ['GroupServiceImpl.createGroup:95 "Name must not be empty"', 'name null, empty or blank (observed for whitespace)'] }),
            async ({ api }) => {
                const { probe } = await createGroupProbe(api, groupBody(value, { description: 'API-GEN-19 probe', customAttributes: await groupCustom(api) }), SPEC, `${row} probe`);
                expect(refused422(probe)).toEqual(['Name must not be empty']);
            });
    }

    test('the same name again answers 409 and exactly one group has the name',
        testMeta({ id: 'API-GEN-19', row: 'duplicate', prio: 'P1', issue: ISSUE, rule: ['name lookup then 409 AlreadyExistException; not trimmed, case-sensitive', 'a duplicate name is refused; REG-CFG-06 is the UI partner', '409 "Object of type \'Group\' identified by <name> already exists."'] }),
        async ({ api }) => {
            const first = await ownGroup(api, SPEC, { description: 'API-GEN-19 duplicate' }, { suffix: 'grp-dup' });
            const { probe } = await createGroupProbe(api, groupBody(first.name, { description: 'second', customAttributes: await groupCustom(api) }), SPEC, 'duplicate-name probe');
            expect(refusedWith(probe, 409)).toBe(`Object of type 'Group' identified by ${first.name} already exists.`);
            expect((await rowsNamed(api, '/api/v1/groups', first.name)).map((r) => r.uuid), 'exactly one group has the name: the first one').toEqual([first.uuid]);
        });

    test('PUT ignores the body name and overwrites description, e-mail, attributes',
        testMeta({ id: 'API-GEN-19', row: 'put-overwrite', prio: 'P1', issue: ISSUE, rule: ['editGroup: the body name is ignored; description and email are overwritten; custom attributes are replaced wholesale', 'PUT own group: 200, name unchanged', 'overwrites description, e-mail and custom attribute content'] }),
        async ({ api }) => {
            const attribute = await ownGroupAttribute(api, SPEC);
            const group = await ownGroup(api, SPEC, { description: 'description one', email: `${runName('one')}@example.test`, customAttributes: [customAttributeRequest(attribute, 'v1')] }, { suffix: 'grp-put' });
            const otherName = runName(`grp-ignored-${uniqueStamp()}`);
            const email = `${runName('two')}@example.test`;

            const put = await putGroup(api, group.uuid, { name: otherName, description: 'description two', email, customAttributes: await groupCustom(api, [customAttributeRequest(attribute, 'v2')]) });
            expect(put.status, put.text.slice(0, 300)).toBe(200);
            const detail = (await readGroup(api, group.uuid)).json as Json;
            expect(detail.name, 'the body name is ignored').toBe(group.name);
            expect(detail.description).toBe('description two');
            expect(detail.email).toBe(email);
            expect(valuesOf(detail, 'customAttributes', attribute.name), 'the custom attribute is overwritten').toEqual(['v2']);
            expect(await rowsNamed(api, '/api/v1/groups', otherName), 'no group carries the ignored name').toEqual([]);
        });

    test('PUT without e-mail and attributes clears both',
        testMeta({ id: 'API-GEN-19', row: 'put-omitted', prio: 'P1', issue: ISSUE, rule: ['null or omitted e-mail clears it; any custom attribute not sent loses its content: AttributeEngine:1814, PR core#1124', 'PUT omitting customAttributes', 'clears the e-mail and the omitted custom attribute loses its content'] }),
        async ({ api }) => {
            const attribute = await ownGroupAttribute(api, SPEC);
            const group = await ownGroup(api, SPEC, { description: 'description one', email: `${runName('one')}@example.test`, customAttributes: [customAttributeRequest(attribute, 'v1')] }, { suffix: 'grp-omit' });
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

    test('GET, PUT and DELETE of an unknown group answer 404',
        testMeta({ id: 'API-GEN-19', row: 'unknown-uuid', prio: 'P1', issue: ISSUE, rule: ['unknown uuid on GET / PUT / DELETE (NotFoundException: ExceptionHandlingAdvice:73-81)', 'GET / PUT / DELETE unknown uuid 404', '404 "Object of type \'Group\' identified by <uuid> is not found."'] }),
        async ({ api }) => {
            const unknown = api.probeUuid();
            const text = `Object of type 'Group' identified by ${unknown} is not found.`;
            expect(refusedWith(await readGroup(api, unknown), 404), 'GET').toBe(text);
            expect(refusedWith(await putGroup(api, unknown, { description: 'x', customAttributes: await groupCustom(api) }), 404), 'PUT').toBe(text);
            expect(refusedWith(await deleteOwnConfigObject(api, 'groups', unknown), 404), 'DELETE').toBe(text);
        });

    test('GET with a malformed uuid answers 422',
        testMeta({ id: 'API-GEN-19', row: 'malformed-uuid', prio: 'P1', issue: ISSUE, rule: ['malformed uuid 422 "Invalid UUID ...": GroupControllerImpl parses the path with SecuredUUID.fromString', 'path types differ per resource: certificates 400, groups 422', '422 ["Invalid UUID <value> in the request"]'] }),
        async ({ api }) => {
            const p = await readProbe(api, '/api/v1/groups/not-a-uuid');
            expect(refused422(p)).toEqual(['Invalid UUID not-a-uuid in the request']);
        });

    test('PUT and DELETE with a malformed uuid answer 422',
        testMeta({ id: 'API-GEN-19', row: 'malformed-uuid-write', prio: 'P1', issue: ISSUE, rule: ['malformed uuid 422 "Invalid UUID ..."', 'GroupControllerImpl.editGroup / deleteGroup: SecuredUUID.fromString(uuid) is the first statement, before any lookup', '422 ["Invalid UUID <value> in the request"]'] }),
        async ({ api }) => {
            const text = ['Invalid UUID not-a-uuid in the request'];
            expect(refused422(await putGroup(api, 'not-a-uuid', { description: 'x', customAttributes: await groupCustom(api) })), 'PUT').toEqual(text);
            expect(refused422(await deleteOwnConfigObject(api, 'groups', 'not-a-uuid')), 'DELETE').toEqual(text);
        });

    test('deleting an own group answers 204, the group is gone, certificates lose it',
        testMeta({ id: 'API-GEN-19', row: 'delete-own', prio: 'P1', issue: ISSUE, rule: ['delete never refused for being in use: removes every group association; certificates stay without that group', 'DELETE of a group in use by certificates', 'the certificate that had the group shows no group'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const certificate = await uploadOwnSelfSigned(api, SPEC);
            const group = await ownGroup(api, SPEC, { description: 'API-GEN-19 delete' }, { suffix: 'grp-del' });
            await setCertificateGroups(api, certificate.uuid, [group.uuid]);
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid)), 'precondition: the certificate is in the group').toEqual([group.uuid]);

            await deleteAndVerify(api, 'groups', group, 'Group', SPEC);
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid)), 'the certificate shows no group any more').toEqual([]);
            expect(await findRowByUuid(api, '/api/v1/groups', group.uuid), 'the group is not listed any more').toBeUndefined();
        });

    test('bulk delete [own, unknown] answers 204 and removes the own group',
        testMeta({ id: 'API-GEN-19', row: 'bulk-delete', prio: 'P1', issue: ISSUE, rule: ['bulk DELETE /v1/groups skips unknown uuids: GroupServiceImpl.bulkDeleteGroup', 'the unknown one is skipped'] }),
        async ({ api }) => {
            const group = await ownGroup(api, SPEC, { description: 'API-GEN-19 bulk' }, { suffix: 'grp-bulk' });
            const bulk = await bulkDeleteObjects(api, 'groups', [group.uuid, api.probeUuid()]);
            expect(bulk.status, bulk.text.slice(0, 300)).toBe(204);
            expect(bulk.text, 'a 204 has no body').toBe('');
            await expectGoneWith404(api, 'groups', group.uuid, 'Group');
            recordDeleted('groups', group, SPEC, 'bulk delete under test: 204, then 404 on read-back');
        });

    test('GET /v1/groups/{uuid}/users of an own group answers 200 []',
        testMeta({ id: 'API-GEN-19', row: 'users', prio: 'P1', issue: ISSUE, rule: ['GET /v1/groups/{uuid}/users: members of the group; core#2210, interfaces#950', 'GroupServiceImpl.getGroupUsers (a new group has no member)', 'an unknown group: 404'] }),
        async ({ api }) => {
            const group = await ownGroup(api, SPEC, { description: 'API-GEN-19 members' }, { suffix: 'grp-users' });
            const members = await readProbe(api, `/api/v1/groups/${group.uuid}/users`);
            expect(members.status, members.text.slice(0, 300)).toBe(200);
            expect(members.json, 'a group nobody joined has no member').toEqual([]);
            const unknown = api.probeUuid();
            expect(refusedWith(await readProbe(api, `/api/v1/groups/${unknown}/users`), 404)).toBe(`Object of type 'Group' identified by ${unknown} is not found.`);
        });

    test('list items have null customAttributes, the detail has the array',
        testMeta({ id: 'API-GEN-19', row: 'list-detail', prio: 'P1', issue: ISSUE, rule: 'list items come from Group::mapToDto: customAttributes null; the detail adds the custom attributes array: GroupServiceImpl:74-87' }),
        async ({ api }) => {
            const group = await ownGroup(api, SPEC, { description: 'API-GEN-19 list vs detail' }, { suffix: 'grp-shape' });
            const row = await findRowByUuid(api, '/api/v1/groups', group.uuid);
            expect(row, 'the own group is listed').toBeTruthy();
            expect(row!.customAttributes ?? null, 'a list item has no customAttributes').toBeNull();
            const detail = (await readGroup(api, group.uuid)).json as Json;
            expect(Array.isArray(detail.customAttributes), 'the detail carries the customAttributes array').toBe(true);
        });

    test('an over-long description, bad e-mail and trailing-space name are accepted (201)',
        testMeta({ id: 'API-GEN-19', row: 'pin-q8', prio: 'P2', issue: ISSUE, pin: 'Q8', rule: ['the UI limits are UI-only: description 300, e-mail pattern, name regex; the API accepts anything', 'description over 300 characters, an e-mail that is not an address, and a name differing only by a trailing space are accepted', 'a 301-character description, the e-mail "notanemail" and a trailing-space name are accepted although the UI blocks them'] }),
        async ({ api }) => {
            const custom = await groupCustom(api);
            const accepted = async (what: string, name: string, fields: { description?: string; email?: string }): Promise<Json> => {
                const { probe, own } = await createGroupProbe(api, groupBody(name, { ...fields, customAttributes: custom }), SPEC, `accepted-value pin: ${what}`);
                expect(probe.status, `${what}: ${probe.text.slice(0, 300)}`).toBe(201);
                expect(own, `${what}: the 201 answer carries the uuid`).toBeTruthy();
                return (await readGroup(api, own!.uuid)).json as Json;
            };

            const longDescription = 'd'.repeat(301);
            const d = await accepted('description of 301 characters', runName(`grp-q8-desc-${uniqueStamp()}`), { description: longDescription });
            expect((d.description as string).length, 'the 301 characters are stored').toBe(301);
            const e = await accepted('e-mail without an address shape', runName(`grp-q8-mail-${uniqueStamp()}`), { email: 'notanemail' });
            expect(e.email).toBe('notanemail');
            const trailing = runName(`grp-q8-space-${uniqueStamp()}`) + ' ';
            const t = await accepted('name with a trailing space', trailing, {});
            expect(t.name, 'the trailing space is stored (the name is not trimmed)').toBe(trailing);
        });
});
