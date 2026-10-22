/**
 * API-AUTH-30, 31, 32, 33 — The RBAC decision table through the API as the dedicated second identity. ilm#427.
 *
 * WHAT: 1. Contract: no credentials → 401, a user without the permission → 403 ACCESS_DENIED naming the exact Action / Resource pair, the
 *          admin → 200; the 403 body's `statusCode` is 403 (interfaces#887 on builds without the fix, test.fail there).
 *       2. Per permission fixture (no permissions, certificate list and detail, issuing role, rights on one RA profile, members right
 *          on one group, denies, allow-all with one deny, custom role derived from auditor): the profile's listings and
 *          resource-level actions, the run's certificates the user can see, and the detail of each certificate.
 *       3. Per fixture: RA profile list and detail, RA profile create, v2 issue on both profiles, roles and users administration, and
 *          the nested-bean gates (upload, delete, enable, archive) that must answer 403, never a silent 2xx.
 *       4. A deny is per action: `detail`, `members` or `list` denied on one RA profile changes only what that action gates.
 * WHY: the platform authorises by role permissions on the resource and on its parent resource (certificate detail needs RA profile
 *      members; visibility = certificates:list AND RA profile members, OR group members, OR owner). A red row means a role got more or
 *      less access than its document grants, or a deny answered with the wrong body. A mismatch is a finding to confirm, never an
 *      adjusted oracle.
 * HOW: the admin builds an own role from each fixture's permission document through the API, makes it the second identity's only role,
 *      waits until that user's profile reflects it, and the second identity's token walks the rows. Every test starts with the
 *      second-identity, replica and CA preflights and skips with the named reason until the account exists. Oracles: no 5xx; every
 *      403 has the ACCESS_DENIED body shape. Anything the restricted user manages to create is recorded in the ledger before the
 *      assertion; the matrix certificates are own objects of the run.
 */
import { BATTERY_TEST_MS, ISSUING_MATRIX_ROW_TEST_MS, LIFECYCLE_MS, LONG_TEST_MS } from '../../../utils/regression/timeouts';
import { expect, test } from '../../../fixtures/regressionFixtures';
import { getBuildInfo, isMigratedBuild } from '../../../utils/regression/coreBuild';
import { callAs, isNotGrantableAction, restrictedIdentity, replicaBlocker } from '../../../utils/regression/rbac/identities';
import { accessDeniedProblems, Cell, cellPair, cellStatus, CERT_KEYS, CertKey, DENY_NUANCES, Fixture, FIXTURES, MATRIX_A_DETAIL, MATRIX_A_LIST, MATRIX_A_PROFILE, MATRIX_B_ISSUE_P1, MATRIX_B_ISSUE_P2, MATRIX_B_RA_CREATE, MATRIX_B_RA_DETAIL_P1, MATRIX_B_RA_DETAIL_P2, MATRIX_B_RA_LIST, MATRIX_B_ROLE_CREATE, MATRIX_B_ROLES_LIST, MATRIX_B_USER_PERMISSIONS, MATRIX_B_USERS_LIST, NESTED_GATE_FIXTURES } from '../../../utils/regression/rbac/permissionMatrix';
import { applyFixture, auditorDocument, ensureRbacObjects, ensureRestrictedUserOrSkip, raProfileCreateBody, RbacObjects, restrictedRoleSwitch, RoleSwitch } from '../../../utils/regression/rbac/permissionObjects';
import { waitIssued } from '../../../utils/regression/ownCertificates';
import { csrWithSan, selfSignedPem } from '../../../utils/regression/pkiBuilders';
import { pickHealthyAuthority } from '../../../utils/regression/ownRaProfiles';
import { recordIfAccepted } from '../../../utils/regression/ownCrud';
import { runName, runId } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import type { TestEnv } from '../../../utils/env';
import type { GuardedApi } from '../../../utils/regression/guard/types';
import type { OwnObjects } from '../../../utils/regression/ownObjects';
import { ApiAnswer } from '../../../utils/regression/apiReads';


interface Matrix {
    api: GuardedApi;
    /** The ledger id of the test: every object the matrix makes carries it. */
    spec: string;
    refs: RbacObjects;
    sw: RoleSwitch;
    token: string;
}

/** The fixtures `prepare` needs (the test's own destructured fixtures). */
interface Fixtures {
    api: GuardedApi;
    env: TestEnv;
    own: OwnObjects;
    restrictedToken: string | undefined;
}

/**
 * The preflights and the data of every matrix row: second identity, one core replica, a token, the dedicated ILM user, and the
 * data table. A deploy gap is a skip with its reason, never a pass: the second identity and the CA are the `needs` of the rows, which the
 * fixtures resolve first.
 */
async function prepare(fx: Fixtures): Promise<Matrix> {
    const spec = fx.own.spec;
    const blocker = replicaBlocker();
    test.skip(!!blocker, blocker);
    test.skip(fx.restrictedToken === undefined, `no bearer token for the second identity on AUTH_MODE=${fx.env.authMode}`);
    // The CA the fixture RA profiles copy from is read before anything is written: no healthy authority is a named skip.
    const source = await pickHealthyAuthority(fx.api);
    if ('skip' in source) test.skip(true, source.skip);
    const dedicatedUser = restrictedIdentity()!;
    // A dedicated user an earlier run left behind is a named skip, never an adoption.
    const user = await ensureRestrictedUserOrSkip(fx.api, spec, dedicatedUser, (reason) => test.skip(true, reason));
    const refs = await ensureRbacObjects(fx.api, spec);
    return { api: fx.api, spec, refs, sw: restrictedRoleSwitch(fx.api, user, fx.restrictedToken!), token: fx.restrictedToken! };
}

/** One cell against an answer: status, and the body contract + pair of a 403. */
function expectCell(what: string, answer: ApiAnswer, cell: Cell): void {
    expect(answer.status, `${what}: ${answer.text.slice(0, 200)}`).toBe(cellStatus(cell));
    if (cellStatus(cell) === 403) expect(accessDeniedProblems(answer.contentType, answer.json, cellPair(cell)), `${what}: the 403 body`).toEqual([]);
}

/** The run's own `rbac` certificates the restricted user can see (`POST /v1/certificates`, filtered by the run prefix). */
async function visibleCertificates(m: Matrix): Promise<Set<CertKey>> {
    const res = await callAs(m.api, m.token, 'POST', '/api/v1/certificates', {
        itemsPerPage: 100, pageNumber: 1, filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: `${runId()}-rbac-` }],
    });
    expect(res.status, `the certificate search as the second identity: ${res.text.slice(0, 200)}`).toBe(200);
    const names = new Set<string>((res.json?.certificates ?? []).map((c: { commonName: string }) => c.commonName));
    return new Set(CERT_KEYS.filter((k) => names.has(m.refs.certs[k].name)));
}

/** The role each permission fixture stands for, in words (the fixture codes are the keys of the shared tables). */
const ROLE_WORDS: Record<Fixture, string> = {
    F0: 'a role without permissions', F1: 'a role with certificate list and detail', F2: 'an issuing role with one RA profile',
    F2b: 'a role with rights on one RA profile object', F3: 'a role with members right on one group', F4a: 'a role denied detail on one RA profile',
    F4b: 'a role denied members on one RA profile', F4c: 'a role denied list on one RA profile', F5: 'an allow-all role denied one RA profile',
    F6: 'a custom role derived from auditor',
};

test.describe('RBAC matrix as the restricted second identity', { tag: tags.api }, () => {
    // ------------------------------------------------------------------ API-AUTH-30

    test(`no credentials 401, a user without the permission 403 ACCESS_DENIED, the admin 200`,
        testMeta({
            id: 'API-AUTH-30', row: 'contract', prio: 'P1', issue: 'ilm#427', needs: ['second-identity', 'ca'],
            rule: [
                '401 means no or failed authentication; 403 = application/problem+json, code ACCESS_DENIED, message "Access Denied. Required \'<Action>\' permission for \'<Resource>\'", the action in human form: "Check Compliance", `BeautificationUtil.camelToHumanForm`); core#165',
                'inferred rule, not stated in a ticket: a random uuid detail answers 403 for the restricted user, not 404 (no existence leak)',
                'the 403 is application/problem+json with the Action / Resource pair; the anonymous leg uses anonymousApi; needs the second identity',
            ],
        }),
        async ({ api, anonymousApi, env, own, restrictedToken }) => {
            test.setTimeout(LONG_TEST_MS);
            const m = await prepare({ api, env, own, restrictedToken: restrictedToken?.bearer() });
            await test.step('The role without permissions is the second identity\'s only role', async () => applyFixture(m.api, m.sw, 'F0', m.refs, m.spec));

            await test.step('Three-way check on one endpoint: no credentials → 401, the second identity → 403, admin → 200', async () => {
                const anon = await anonymousApi.get('/api/v1/roles');
                expect(anon.status()).toBe(401);
                expectCell('second identity GET /v1/roles', await callAs(m.api, m.token, 'GET', '/api/v1/roles'), 403);
                expect((await m.api.get('/api/v1/roles')).status()).toBe(200);
            });

            await test.step('The pair is named exactly: Detail / Certificate (first gate), Members / RA Profile (second gate), Create / RA Profile, and a multi-word action (Check Compliance / Compliance Profile)', async () => {
                const c1 = m.refs.certs.c1.uuid;
                expectCell('no-permission role, detail of c1', await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${c1}`), { status: 403, pair: { action: 'Detail', resource: 'Certificate' } });
                // A multi-word action in human form: core's `BeautificationUtil.camelToHumanForm("checkCompliance")` is "Check Compliance"
                // (capital C on both words); the route is gated by COMPLIANCE_PROFILE:CHECK_COMPLIANCE (`ComplianceServiceImpl`
                // `checkResourceObjectsComplianceValidation`), so the resource label is "Compliance Profile".
                expectCell('no-permission role, check compliance of c1', await callAs(m.api, m.token, 'POST', `/api/v2/compliance/certificates/${c1}`), { status: 403, pair: { action: 'Check Compliance', resource: 'Compliance Profile' } });

                await applyFixture(m.api, m.sw, 'F1', m.refs, m.spec);
                expectCell('list-and-detail role, detail of c1', await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${c1}`), { status: 403, pair: { action: 'Members', resource: 'RA Profile' } });

                await applyFixture(m.api, m.sw, 'F2', m.refs, m.spec);
                const body = { name: runName('rbac-create-probe'), description: 'API-AUTH-30', attributes: [], customAttributes: [] };
                const probe = await callAs(m.api, m.token, 'POST', `/api/v1/authorities/${m.refs.authorityUuid}/raProfiles`, body);
                // Ledger before assertion: an RA profile the second identity managed to create is this run's object.
                recordIfAccepted('raProfiles', probe, body.name, m.spec, 'created by the second identity in the contract row', { authority: m.refs.authorityUuid });
                expectCell('issuing role, create an RA profile', probe, { status: 403, pair: { action: 'Create', resource: 'RA Profile' } });
            });

            await test.step('A random certificate uuid is 403 for the second identity without permissions, not 404 (no existence leak)', async () => {
                await applyFixture(m.api, m.sw, 'F0', m.refs, m.spec);
                const res = await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${m.api.probeUuid()}`);
                expect(res.status, 'no existence leak for a caller without the permission').toBe(403);
            });
        });

    test(`the 403 body's statusCode is 403`,
        testMeta({
            id: 'API-AUTH-30', row: 'statusCode', prio: 'P1', issue: 'ilm#427', needs: ['second-identity', 'ca'], bug: 'interfaces#887',
            rule: ['the body field `statusCode` was forced to 400 by the DTO getter until interfaces#887, fixed on the migrated build; a body difference between the main and the migrated build is a fix, not a regression', 'expected to fail only on builds without the interfaces#887 fix (conditional test.fail); needs the second identity'],
        }),
        async ({ api, env, own, restrictedToken }, testInfo) => {
            test.setTimeout(BATTERY_TEST_MS);
            const m = await prepare({ api, env, own, restrictedToken: restrictedToken?.bearer() });
            await applyFixture(m.api, m.sw, 'F0', m.refs, m.spec);
            const build = await getBuildInfo(m.api);
            testInfo.annotations.push({ type: 'build', description: `core ${build.version ?? '?'} branch ${build.branch ?? '?'}` });
            // A separate test so the other 403 assertions are never masked: only a build WITHOUT the fix carries the bug.
            test.fail(!(await isMigratedBuild(m.api, testInfo)), 'interfaces#887: a build without the fix reports statusCode 400 inside a 403 body');
            const res = await callAs(m.api, m.token, 'GET', '/api/v1/roles');
            expect(res.status).toBe(403);
            expect(res.json?.statusCode, 'the body field statusCode').toBe(403);
        });

    // ------------------------------------------------------------------ API-AUTH-31

    /** What a fixture's profile and certificate visibility amount to (MATRIX_A_LIST / MATRIX_A_PROFILE), in words. */
    const VISIBILITY_WORDS: Record<Fixture, string> = {
        F0: 'a role without permissions sees no certificate and no extra listing',
        F1: 'a role with only certificate list and detail sees none of the run\'s certificates',
        F2: 'an issuing role with one RA profile sees only that profile\'s certificate',
        F2b: 'a role with rights on one RA profile object sees only that profile\'s certificate',
        F3: 'a role with members right on one group sees only that group\'s certificates',
        F4a: 'a role denied detail on one RA profile still lists every certificate',
        F4b: 'a role denied members on one RA profile no longer sees that profile\'s certificate',
        F4c: 'a role denied list on one RA profile still lists every certificate',
        F5: 'an allow-all role denied one RA profile does not see that profile\'s certificate',
        F6: 'a custom role derived from auditor sees every certificate with read-only actions',
    };
    /** What a fixture may do on RA profiles, authorities and issue (the MATRIX_B rows), in words. */
    const GATE_WORDS: Record<Fixture, string> = {
        F0: 'a role without permissions is refused every RA profile, authority and issue call',
        F1: 'a role with certificate list and detail is refused RA profile, authority and issue calls',
        F2: 'an issuing role with one RA profile issues there but cannot create RA profiles',
        F2b: 'a role with rights on one RA profile object issues there but cannot create RA profiles',
        F3: 'a role with members right on one group is refused RA profile, authority and issue calls',
        F4a: 'a role denied detail on one RA profile cannot read that profile, issue or create',
        F4b: 'a role denied members on one RA profile reads both profiles but cannot issue',
        F4c: 'a role denied list on one RA profile reads both profiles but cannot issue',
        F5: 'an allow-all role denied one RA profile issues and creates, but not on that profile',
        F6: 'a custom role derived from auditor reads RA profiles and roles but cannot issue or create',
    };
    for (const fixture of FIXTURES) {
        test(`${VISIBILITY_WORDS[fixture]}`,
            testMeta({
                id: 'API-AUTH-31', row: fixture, prio: 'P1', issue: 'ilm#427', needs: ['second-identity', 'ca'],
                rule: [
                    'parent resource first: certificate detail adds RA_PROFILE:MEMBERS; group and owner fallback; certificate visibility = certificates:list AND RA-profile members, OR group members, OR owner; profile listings and resource-level actions; ilm#427 steps 1–3',
                    'certificates without an RA profile under an RA profile deny are not asserted here (API-AUTH-34)',
                    'needs the second identity and a healthy CA for the fixture RA profiles',
                ],
            }),
            async ({ api, env, own, restrictedToken }) => {
                test.setTimeout(LIFECYCLE_MS);
                const m = await prepare({ api, env, own, restrictedToken: restrictedToken?.bearer() });
                const auditor = fixture === 'F6' ? await auditorDocument(m.api) : undefined;
                await test.step(`${ROLE_WORDS[fixture]} is the second identity's only role and is in force`, async () => applyFixture(m.api, m.sw, fixture, m.refs, m.spec, auditor));

                await test.step('Profile: 200, extra listings and the exact resource-level actions (never ANY / NONE)', async () => {
                    const profile = await m.sw.profile();
                    expect(profile, 'the second identity\'s profile answers 200').toBeDefined();
                    const want = MATRIX_A_PROFILE[fixture];
                    for (const listing of ['dashboard', 'approvals']) expect(profile!.allowedListings, `${ROLE_WORDS[fixture]} lists ${listing}`).toContain(listing);
                    if (want.extraListings === 'all-listable') {
                        for (const listing of ['certificates', 'raProfiles', 'authorities', 'users', 'roles', 'groups']) expect(profile!.allowedListings, `${ROLE_WORDS[fixture]} lists ${listing}`).toContain(listing);
                    } else {
                        for (const listing of want.extraListings) expect(profile!.allowedListings, `${ROLE_WORDS[fixture]} lists ${listing}`).toContain(listing);
                    }
                    const got = Object.fromEntries(profile!.allowedActions.map((a) => [a.resource, [...a.actions].sort()]));
                    expect(Object.values(got).flat().filter(isNotGrantableAction), 'no ANY / NONE').toEqual([]);
                    if (want.actions === 'all') expect(got.certificates, 'allow-all grants every certificate action').toEqual(expect.arrayContaining(['list', 'detail', 'create', 'issue']));
                    else if (want.actions === 'read-only') {
                        expect(got.certificates).toEqual(expect.arrayContaining(['list', 'detail']));
                        expect(got.certificates.filter((a) => !['list', 'detail', 'members', 'export'].includes(a)), 'a read-only document grants no write action').toEqual([]);
                    } else expect(got, `${ROLE_WORDS[fixture]}: resource-level actions`).toEqual(want.actions);
                });

                await test.step('Certificates the caller can see (POST /v1/certificates, filtered to the run\'s six): the listed and the absent ones', async () => {
                    const seen = await visibleCertificates(m);
                    const want = MATRIX_A_LIST[fixture];
                    for (const k of want.present) expect(seen.has(k), `${ROLE_WORDS[fixture]}: ${k} is listed`).toBe(true);
                    for (const k of want.absent) expect(seen.has(k), `${ROLE_WORDS[fixture]}: ${k} is not listed`).toBe(false);
                });

                for (const key of CERT_KEYS) {
                    await test.step(`GET /v1/certificates/{${key}} → ${cellStatus(MATRIX_A_DETAIL[key][fixture])}`, async () => {
                        expectCell(`${ROLE_WORDS[fixture]} detail ${key}`, await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${m.refs.certs[key].uuid}`), MATRIX_A_DETAIL[key][fixture]);
                    });
                }
            });
    }

    // ------------------------------------------------------------------ API-AUTH-32

    for (const fixture of FIXTURES) {
        test(`${GATE_WORDS[fixture]}`,
            testMeta({
                id: 'API-AUTH-32', row: fixture, prio: 'P1', issue: 'ilm#427', needs: ['second-identity', 'ca'],
                rule: [
                    'issue = RA_PROFILE:DETAIL on the profile + AUTHORITY:DETAIL, then CERTIFICATE:CREATE, then the asynchronous CERTIFICATE:ISSUE; RA profile create = RA_PROFILE:CREATE + AUTHORITY:DETAIL; RA profile list = RA_PROFILE:LIST + AUTHORITY:LIST; core#2153; ilm#427 steps 4–6',
                    'write operations; Spring Security 7 method security: the nested-bean gates answer 403, never a silent 2xx',
                    'needs the second identity and a healthy CA for the issue rows',
                ],
            }),
            async ({ api, env, own, restrictedToken }) => {
                test.setTimeout(ISSUING_MATRIX_ROW_TEST_MS);
                const m = await prepare({ api, env, own, restrictedToken: restrictedToken?.bearer() });
                const auditor = fixture === 'F6' ? await auditorDocument(m.api) : undefined;
                await test.step(`${ROLE_WORDS[fixture]} is the second identity's only role and is in force`, async () => applyFixture(m.api, m.sw, fixture, m.refs, m.spec, auditor));
                const { p1, p2, authorityUuid } = m.refs;

                await test.step('GET /v1/raProfiles: the rows seen, or the refusal', async () => {
                    const cell = MATRIX_B_RA_LIST[fixture];
                    const res = await callAs(m.api, m.token, 'GET', '/api/v1/raProfiles');
                    if (cell.status === 403) return expectCell(`${ROLE_WORDS[fixture]} RA profile list`, res, { status: 403, pair: cell.pair });
                    expect(res.status, res.text.slice(0, 200)).toBe(200);
                    const uuids = new Set<string>((res.json as Array<{ uuid: string }>).map((r) => r.uuid));
                    for (const k of cell.has) expect(uuids.has(k === 'p1' ? p1.uuid : p2.uuid), `${ROLE_WORDS[fixture]}: ${k} is listed`).toBe(true);
                    for (const k of cell.lacks) expect(uuids.has(k === 'p1' ? p1.uuid : p2.uuid), `${ROLE_WORDS[fixture]}: ${k} is not listed`).toBe(false);
                });

                await test.step('GET /v1/raProfiles/{P1} and {P2}', async () => {
                    expectCell(`${ROLE_WORDS[fixture]} detail P1`, await callAs(m.api, m.token, 'GET', `/api/v1/raProfiles/${p1.uuid}`), MATRIX_B_RA_DETAIL_P1[fixture]);
                    expectCell(`${ROLE_WORDS[fixture]} detail P2`, await callAs(m.api, m.token, 'GET', `/api/v1/raProfiles/${p2.uuid}`), MATRIX_B_RA_DETAIL_P2[fixture]);
                });

                await test.step('POST /v1/authorities/{A}/raProfiles: refused with the pair, or, for the allow-all fixture, a create under the pre-existing authority, recorded', async () => {
                    const name = runName(`rbac-create-${fixture.toLowerCase()}`);
                    const body = await raProfileCreateBody(m.api, m.refs.source, name);
                    const res = await callAs(m.api, m.token, 'POST', `/api/v1/authorities/${authorityUuid}/raProfiles`, body);
                    // Ledger before assertion: an RA profile the restricted user managed to create is this run's object.
                    recordIfAccepted('raProfiles', res, name, m.spec, 'created by the second identity in the matrix (allow-all fixture)', { authority: authorityUuid });
                    expectCell(`${ROLE_WORDS[fixture]} create RA profile`, res, MATRIX_B_RA_CREATE[fixture]);
                });

                await test.step('v2 issue on P1 (accepted and issued for the issuing, the one-RA-profile-object and the allow-all roles; 403 otherwise) and on P2 (403 for all)', async () => {
                    const csr = csrWithSan(runName(`rbac-issue-${fixture.toLowerCase()}`), [`${runId()}.example.test`]);
                    const issue = (ra: string) => callAs(m.api, m.token, 'POST', `/api/v2/operations/authorities/${authorityUuid}/raProfiles/${ra}/certificates`, { request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [] });
                    const onP1 = await issue(p1.uuid);
                    const accepted = recordIfAccepted('certificates', onP1, runName(`rbac-issue-${fixture.toLowerCase()}`), m.spec, 'issued by the second identity in the matrix');
                    expectCell(`${ROLE_WORDS[fixture]} issue on P1`, onP1, MATRIX_B_ISSUE_P1[fixture]);
                    if (accepted) await waitIssued(m.api, accepted.uuid);
                    expectCell(`${ROLE_WORDS[fixture]} issue on P2`, await issue(p2.uuid), MATRIX_B_ISSUE_P2[fixture]);
                });

                await test.step('Administration: roles list, users list, role create, the second identity\'s own permissions endpoint', async () => {
                    expectCell(`${ROLE_WORDS[fixture]} GET /v1/roles`, await callAs(m.api, m.token, 'GET', '/api/v1/roles'), MATRIX_B_ROLES_LIST[fixture]);
                    expectCell(`${ROLE_WORDS[fixture]} GET /v1/users`, await callAs(m.api, m.token, 'GET', '/api/v1/users'), MATRIX_B_USERS_LIST[fixture]);
                    const roleName = runName(`rbac-role-probe-${fixture.toLowerCase()}`);
                    const created = await callAs(m.api, m.token, 'POST', '/api/v1/roles', { name: roleName, description: 'API-AUTH-32 probe', customAttributes: [] });
                    recordIfAccepted('roles', created, roleName, m.spec, 'created by the second identity in the matrix (allow-all fixture)');
                    expectCell(`${ROLE_WORDS[fixture]} POST /v1/roles`, created, MATRIX_B_ROLE_CREATE[fixture]);
                    const me = await m.sw.profile();
                    expectCell(`${ROLE_WORDS[fixture]} GET /v1/users/{second identity}/permissions`, await callAs(m.api, m.token, 'GET', `/api/v1/users/${me!.uuid}/permissions`), MATRIX_B_USER_PERMISSIONS[fixture]);
                });

                if (NESTED_GATE_FIXTURES.includes(fixture)) {
                    await test.step('Nested-bean gates (Spring Security 7 method security): each sample call is 403, never a silent 2xx', async () => {
                        const upload = selfSignedPem(runName(`rbac-gate-${fixture.toLowerCase()}`));
                        const probes: Array<{ what: string; send: () => ReturnType<typeof callAs>; created?: 'certificates' }> = [
                            { what: 'upload a certificate', created: 'certificates', send: () => callAs(m.api, m.token, 'POST', '/api/v1/certificates/upload', { certificate: Buffer.from(upload.pem).toString('base64'), customAttributes: [] }) },
                            { what: 'delete a certificate', send: () => callAs(m.api, m.token, 'DELETE', `/api/v1/certificates/${m.api.probeUuid()}`) },
                            { what: 'enable an RA profile', send: () => callAs(m.api, m.token, 'PATCH', `/api/v1/authorities/${authorityUuid}/raProfiles/${p1.uuid}/enable`) },
                            { what: 'archive a certificate', send: () => callAs(m.api, m.token, 'PATCH', '/api/v1/certificates/archive', [m.api.probeUuid()]) },
                        ];
                        for (const p of probes) {
                            const res = await p.send();
                            if (p.created) recordIfAccepted(p.created, res, runName(`rbac-gate-${fixture.toLowerCase()}`), m.spec, 'created by the second identity through a gate that should have refused');
                            expect(res.status, `${ROLE_WORDS[fixture]}: ${p.what} must be refused: ${res.text.slice(0, 200)}`).toBe(403);
                        }
                    });
                }
            });
    }

    // ------------------------------------------------------------------ API-AUTH-33

    for (const fixture of ['F4a', 'F4b', 'F4c'] as const) {
        test(`a deny is per action for ${ROLE_WORDS[fixture]}`,
            testMeta({
                id: 'API-AUTH-33', row: fixture, prio: 'P1', issue: 'ilm#427', needs: ['second-identity', 'ca'],
                rule: [
                    'a deny on any requested uuid beats every allow; a listing is filtered: forbidden objects drop out; RA-profile `members` gates certificate visibility, `detail` does not; "deny wins" holds per action only',
                    'the detail-denied role denies `detail` on P2, the members-denied role `members`, the list-denied role `list`; the case "a request naming P1 and P2 together → 403" is not expressible: no read endpoint names several RA profiles',
                    'needs the second identity and a healthy CA for the fixture RA profiles',
                ],
            }),
            async ({ api, env, own, restrictedToken }) => {
                test.setTimeout(LIFECYCLE_MS);
                const m = await prepare({ api, env, own, restrictedToken: restrictedToken?.bearer() });
                await test.step(`${ROLE_WORDS[fixture]} is the second identity's only role and is in force`, async () => applyFixture(m.api, m.sw, fixture, m.refs, m.spec));
                const want = DENY_NUANCES[fixture];

                await test.step('P2 detail: 403 Detail / RA Profile only for the `detail` deny; P1 detail stays 200', async () => {
                    expectCell(`${ROLE_WORDS[fixture]} detail P2`, await callAs(m.api, m.token, 'GET', `/api/v1/raProfiles/${m.refs.p2.uuid}`), want.p2Detail);
                    expectCell(`${ROLE_WORDS[fixture]} detail P1`, await callAs(m.api, m.token, 'GET', `/api/v1/raProfiles/${m.refs.p1.uuid}`), 200);
                });

                await test.step('The certificates of P2: visible (list and detail 200), or — a `members` deny — gone from the list and 403 Members / RA Profile on detail', async () => {
                    const seen = await visibleCertificates(m);
                    expect(seen.has('c1'), 'c1 (P1) stays listed').toBe(true);
                    expect(seen.has('c2'), `c2 (P2) is ${want.certificatesOfP2}`).toBe(want.certificatesOfP2 === 'visible');
                    expectCell(`${ROLE_WORDS[fixture]} detail c2`, await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${m.refs.certs.c2.uuid}`),
                        want.certificatesOfP2 === 'visible' ? 200 : { status: 403, pair: { action: 'Members', resource: 'RA Profile' } });
                });

                await test.step('GET /v1/raProfiles: P2 is missing only for the `list` deny', async () => {
                    const res = await callAs(m.api, m.token, 'GET', '/api/v1/raProfiles');
                    expect(res.status, res.text.slice(0, 200)).toBe(200);
                    const uuids = (res.json as Array<{ uuid: string }>).map((r) => r.uuid);
                    expect(uuids, `${ROLE_WORDS[fixture]}: P1 is listed`).toContain(m.refs.p1.uuid);
                    expect(uuids.includes(m.refs.p2.uuid), `P2 in the RA profile list under ${ROLE_WORDS[fixture]}`).toBe(want.p2InRaList);
                });
            });
    }
});

