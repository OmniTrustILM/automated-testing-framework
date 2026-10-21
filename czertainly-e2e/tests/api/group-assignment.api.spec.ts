/**
 * Group assignment on a certificate replaces the set: state transitions, the history text "old -> new", no event for
 * an identical set, and the 400 / 422 refusals. The unknown-group row runs on a local stack only.
 * Shared tiers: create-only with run-prefixed names; every create is in the ledger before the first assertion.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { refused422, refusedWith } from '../../utils/regression/inventory/configProbes';
import type { Json } from '../../utils/regression/inventory/searchApi';
import { archiveOwnCertificate, certificateDetail, certificateHistory, changeKey, groupChanges, groupEventCount, ownGroup, patchCertificate } from '../../utils/regression/inventory/groupProbes';
import { groupUuidsOf, setCertificateGroups } from '../../utils/regression/ownGroups';
import { uploadOwnSelfSigned } from '../../utils/regression/ownCertificates';
import { createOwnUser } from '../../utils/regression/ownUsers';
import { testMeta, tags } from '../../utils/regression/tags';
import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import type { GuardedApi } from '../../utils/regression/guard/types';

const SPEC = 'API-GEN-17';
const ISSUE = 'ilm#428';

// ================================================================== API-GEN-20

/** An own certificate and `n` own groups: the data of the assignment rows. */
async function assignmentSeed(api: GuardedApi, n: number) {
    const certificate = await uploadOwnSelfSigned(api, SPEC);
    const groups = [];
    for (let i = 1; i <= n; i++) groups.push(await ownGroup(api, SPEC, { description: `API-GEN-20 group ${i}` }, { suffix: `grp-as${i}` }));
    return { certificate, groups };
}

/** The group names of a group list, sorted, joined as core writes them into the history. */
const joined = (names: string[]): string => [...names].sort().join(', ');

test.describe('group assignment replaces the set', { tag: tags.api }, () => {
    test('a group list [g1, g2] gives both, omitted or null keeps them, [g3] leaves only g3, [] none',
        testMeta({ id: 'API-GEN-20', row: 'replace', prio: 'P1', issue: ISSUE, rule: ['PATCH /v1/certificates/{uuid} groupUuids: omitted or null = no change; [] = remove all; non-empty = replace the set; history UPDATE_GROUP "<old> -> <new>": CertificateServiceImpl:3352-3381', 'core#683, core#630 (objects in several groups; remove owner and group)', 'key omitted or null -> unchanged; the history reads "old -> new"'] }),
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

    test('[g1, g1] gives one membership',
        testMeta({ id: 'API-GEN-20', row: 'duplicates', prio: 'P1', issue: ISSUE, rule: 'ResourceObjectAssociationServiceImpl.setGroups: duplicates collapse because it is a Set' }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1] } = await assignmentSeed(api, 1);
            const p = await patchCertificate(api, certificate.uuid, { groupUuids: [g1.uuid, g1.uuid] });
            expect(p.status, p.text.slice(0, 300)).toBe(204);
            const detail = await certificateDetail(api, certificate.uuid);
            expect(groupUuidsOf(detail), 'one membership, not two').toEqual([g1.uuid]);
            expect(detail.groups as Json[], 'the detail lists the group once').toHaveLength(1);
        });

    test('assigning the identical set answers 204 and writes no new history event',
        testMeta({ id: 'API-GEN-20', row: 'identical-set', prio: 'P1', issue: ISSUE, rule: 'an identical set is a no-op without history: CertificateServiceImpl.updateCertificateGroups returns before the event' }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1, g2] } = await assignmentSeed(api, 2);
            await setCertificateGroups(api, certificate.uuid, [g1.uuid, g2.uuid]);
            const before = groupEventCount(await certificateHistory(api, certificate.uuid));
            expect(before, 'precondition: the first assignment wrote one event').toBe(1);

            const again = await patchCertificate(api, certificate.uuid, { groupUuids: [g2.uuid, g1.uuid] });
            expect(again.status, again.text.slice(0, 300)).toBe(204);
            expect(groupEventCount(await certificateHistory(api, certificate.uuid)), 'no new event for an identical set').toBe(before);
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid))).toEqual([g1.uuid, g2.uuid].sort());
        });

    test('groupUuids ["not-a-uuid"] answers 400 and the groups stay',
        testMeta({ id: 'API-GEN-20', row: 'invalid-uuid', prio: 'P1', issue: ISSUE, rule: ['groupUuids with a non-UUID string (UUID::fromString IllegalArgumentException: ExceptionHandlingAdvice:155-160)', 'a 400 is {message}', '400 "The request could not be processed."'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1] } = await assignmentSeed(api, 1);
            await setCertificateGroups(api, certificate.uuid, [g1.uuid]);
            const bad = await patchCertificate(api, certificate.uuid, { groupUuids: ['not-a-uuid'] });
            expect(refusedWith(bad, 400)).toBe('The request could not be processed.');
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid)), 'the refused request changed nothing').toEqual([g1.uuid]);
        });

    test('an owner-only PATCH leaves the groups alone',
        testMeta({ id: 'API-GEN-20', row: 'owner-only', prio: 'P1', issue: ISSUE, rule: ['updateCertificateObjects: each member is applied only when sent', 'core#630 (remove certificate owner and group, keep Unassigned)'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1] } = await assignmentSeed(api, 1);
            const owner = await createOwnUser(api, SPEC, 'cfg-owner');
            await setCertificateGroups(api, certificate.uuid, [g1.uuid]);
            const events = groupEventCount(await certificateHistory(api, certificate.uuid));

            const p = await patchCertificate(api, certificate.uuid, { ownerUuid: owner.uuid });
            expect(p.status, p.text.slice(0, 300)).toBe(204);
            const detail = await certificateDetail(api, certificate.uuid);
            expect(detail.ownerUuid, 'the owner is set').toBe(owner.uuid);
            expect(groupUuidsOf(detail), 'the groups are untouched').toEqual([g1.uuid]);
            expect(groupEventCount(await certificateHistory(api, certificate.uuid)), 'no group event').toBe(events);
        });

    test('an archived own certificate refuses a group change with 422, groups kept',
        testMeta({ id: 'API-GEN-20', row: 'archived', prio: 'P1', issue: ISSUE, rule: ['CertificateServiceImpl:3357: "Certificate with UUID %s is archived and its groups cannot be updated."; core#1098, ilm#71', 'an archived certificate', 'the 422 carries the archived text'] }),
        async ({ api }) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1, g2] } = await assignmentSeed(api, 2);
            await setCertificateGroups(api, certificate.uuid, [g1.uuid]);
            await archiveOwnCertificate(api, certificate.uuid);

            const p = await patchCertificate(api, certificate.uuid, { groupUuids: [g2.uuid] });
            expect(refused422(p)).toEqual([`Certificate with UUID ${certificate.uuid} is archived and its groups cannot be updated.`]);
            const detail = await certificateDetail(api, certificate.uuid);
            expect(detail.archived).toBe(true);
            expect(groupUuidsOf(detail), 'the refused change left the groups').toEqual([g1.uuid]);
        });
});

// Local stack only until triaged: the inferred transactional gap of the group assignment may leave an own certificate without its
// previous groups; the request itself only names the own certificate and own groups (a probe uuid is the unknown group).
test.describe('group assignment of an unknown group (local stack)', { tag: tags.api }, () => {
    describeLocalOnly(test);

    test('an unknown group uuid answers 404 and the previous groups survive',
        testMeta({ id: 'API-GEN-20', row: 'unknown-group', prio: 'P1', issue: ISSUE, local: true, rule: ['groupUuids with an unknown group (404 NotFoundException(Group); previous groups may already be removed)', 'inferred: setCertificateGroups deletes first, the checked NotFoundException does not roll back: same mechanism as core#2449 / core#2512. Not a @bug until triaged'] }),
        async ({ api }, testInfo) => {
            test.setTimeout(90_000);
            const { certificate, groups: [g1, g2] } = await assignmentSeed(api, 2);
            await setCertificateGroups(api, certificate.uuid, [g1.uuid, g2.uuid]);
            const unknown = api.probeUuid();

            const p = await patchCertificate(api, certificate.uuid, { groupUuids: [unknown] });
            testInfo.annotations.push({ type: 'observed', description: `status ${p.status}` });
            expect(refusedWith(p, 404)).toBe(`Object of type 'Group' identified by ${unknown} is not found.`);
            expect(groupUuidsOf(await certificateDetail(api, certificate.uuid)), 'the previous groups survive the refused request').toEqual([g1.uuid, g2.uuid].sort());
        });
});
