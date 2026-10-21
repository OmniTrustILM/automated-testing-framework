/**
 * The RBAC decision table through the API as the dedicated second identity: what a role's permissions allow and deny
 * on profiles, certificates, RA profiles and authorities, and that a deny is per action.
 * The admin builds an own role from each fixture's permission document through the API, makes it the second identity's only role,
 * waits until that user's profile reflects it, and the second identity's token walks the rows. Every test starts with the
 * second-identity, replica and CA preflights and skips with the named reason until the account exists.
 * Oracles: no 5xx; every 403 has the ACCESS_DENIED body shape. A mismatch is a finding to confirm, never an adjusted oracle.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { getBuildInfo, isMigratedBuild } from '../../utils/regression/coreBuild';
import { callAs, isNotGrantableAction, restrictedIdentity, replicaBlocker, secondIdentityBlocker } from '../../utils/regression/rbac/identities';
import { accessDeniedProblems, applyFixture, auditorDocument, Cell, cellPair, cellStatus, CERT_KEYS, CertKey, DENY_NUANCES, ensureRbacObjects, ensureRestrictedUserOrSkip, Fixture, FIXTURES, MATRIX_A_DETAIL, MATRIX_A_LIST, MATRIX_A_PROFILE, MATRIX_B_ISSUE_P1, MATRIX_B_ISSUE_P2, MATRIX_B_RA_CREATE, MATRIX_B_RA_DETAIL_P1, MATRIX_B_RA_DETAIL_P2, MATRIX_B_RA_LIST, MATRIX_B_ROLE_CREATE, MATRIX_B_ROLES_LIST, MATRIX_B_USER_PERMISSIONS, MATRIX_B_USERS_LIST, NESTED_GATE_FIXTURES, raProfileCreateBody, RbacObjects, restrictedRoleSwitch, RoleSwitch } from '../../utils/regression/rbac/permissionFixtures';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { csrWithSan, selfSignedPem } from '../../utils/regression/pkiBuilders';
import { RaProfileSourceMissing } from '../../utils/regression/ownRaProfiles';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { runName, runId } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import type { TestEnv } from '../../utils/env';
import type { GuardedApi } from '../../utils/regression/guard/types';

const SPEC_30 = 'API-AUTH-30';
const SPEC_31 = 'API-AUTH-31';
const SPEC_32 = 'API-AUTH-32';
const SPEC_33 = 'API-AUTH-33';


interface Matrix {
    api: GuardedApi;
    refs: RbacObjects;
    sw: RoleSwitch;
    token: string;
}

/** The fixtures `prepare` needs (the test's own destructured fixtures). */
interface Fixtures {
    api: GuardedApi;
    env: TestEnv;
    restrictedToken: string | undefined;
}

/**
 * The preflights and the data of every matrix row: second identity, one core replica, a token, the DED ILM user, and the
 * data table. A deploy gap is a skip with its reason, never a pass.
 */
async function prepare(fx: Fixtures, spec: string): Promise<Matrix> {
    const blocker = secondIdentityBlocker(fx.env.username) ?? replicaBlocker();
    test.skip(!!blocker, blocker);
    test.skip(fx.restrictedToken === undefined, `no bearer token for the second identity on AUTH_MODE=${fx.env.authMode}`);
    const dedicatedUser = restrictedIdentity()!;
    // A DED user an earlier run left behind is a named skip, never an adoption.
    const user = await ensureRestrictedUserOrSkip(fx.api, spec, dedicatedUser, (reason) => test.skip(true, reason));
    let refs: RbacObjects;
    try {
        refs = await ensureRbacObjects(fx.api, spec);
    } catch (e) {
        if (e instanceof RaProfileSourceMissing) test.skip(true, e.reason);
        throw e;
    }
    return { api: fx.api, refs, sw: restrictedRoleSwitch(fx.api, user, fx.restrictedToken!), token: fx.restrictedToken! };
}

/** One cell against an answer: status, and the body contract + pair of a 403. */
function expectCell(what: string, answer: { status: number; contentType: string; json: any; text: string }, cell: Cell): void {
    expect(answer.status, `${what}: ${answer.text.slice(0, 200)}`).toBe(cellStatus(cell));
    if (cellStatus(cell) === 403) expect(accessDeniedProblems(answer.contentType, answer.json, cellPair(cell)), `${what}: the 403 body`).toEqual([]);
}

/** The run's own `rbac` certificates DED can see (`POST /v1/certificates`, filtered by the run prefix). */
async function visibleCertificates(m: Matrix): Promise<Set<CertKey>> {
    const res = await callAs(m.api, m.token, 'POST', '/api/v1/certificates', {
        itemsPerPage: 100, pageNumber: 1, filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: `${runId()}-rbac-` }],
    });
    expect(res.status, `the certificate search as DED: ${res.text.slice(0, 200)}`).toBe(200);
    const names = new Set<string>((res.json?.certificates ?? []).map((c: { commonName: string }) => c.commonName));
    return new Set(CERT_KEYS.filter((k) => names.has(m.refs.certs[k].name)));
}

test.describe('RBAC matrix as the restricted second identity', { tag: tags.api }, () => {
    // ------------------------------------------------------------------ API-AUTH-30

    test(`no credentials 401, a user without the permission 403 ACCESS_DENIED, the admin 200`,
        testMeta({
            id: 'API-AUTH-30', row: 'contract', prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
            rule: [
                'auth-rbac G1 (401 = no or failed authentication), G2 (403 = application/problem+json, code ACCESS_DENIED, message "Access Denied. Required \'<Action>\' permission for \'<Resource>\'", the action in human form: "Check Compliance", `BeautificationUtil.camelToHumanForm`); core#165; AR-600',
                '⚠️ Inferred: a random uuid detail answers 403 for DED, not 404 (no existence leak)',
                'the 403 is application/problem+json with the Action / Resource pair; the anonymous leg uses anonymousApi; needs the second identity',
            ],
        }),
        async ({ api, anonymousApi, env, restrictedToken }) => {
            test.setTimeout(300_000);
            const m = await prepare({ api, env, restrictedToken: restrictedToken?.bearer() }, SPEC_30);
            await test.step('Fixture F0 (no permissions) is DED\'s only role', async () => applyFixture(m.api, m.sw, 'F0', m.refs, SPEC_30));

            await test.step('Three-way check on one endpoint: no credentials → 401, DED → 403, admin → 200', async () => {
                const anon = await anonymousApi.get('/api/v1/roles');
                expect(anon.status()).toBe(401);
                expectCell('DED GET /v1/roles', await callAs(m.api, m.token, 'GET', '/api/v1/roles'), 403);
                expect((await m.api.get('/api/v1/roles')).status()).toBe(200);
            });

            await test.step('The pair is named exactly: Detail / Certificate (first gate), Members / RA Profile (second gate), Create / RA Profile, and a multi-word action (Check Compliance / Compliance Profile)', async () => {
                const c1 = m.refs.certs.c1.uuid;
                expectCell('F0 detail of c1', await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${c1}`), { status: 403, pair: { action: 'Detail', resource: 'Certificate' } });
                // A multi-word action in human form: core's `BeautificationUtil.camelToHumanForm("checkCompliance")` is "Check Compliance"
                // (capital C on both words); the route is gated by COMPLIANCE_PROFILE:CHECK_COMPLIANCE (`ComplianceServiceImpl`
                // `checkResourceObjectsComplianceValidation`), so the resource label is "Compliance Profile".
                expectCell('F0 check compliance of c1', await callAs(m.api, m.token, 'POST', `/api/v2/compliance/certificates/${c1}`), { status: 403, pair: { action: 'Check Compliance', resource: 'Compliance Profile' } });

                await applyFixture(m.api, m.sw, 'F1', m.refs, SPEC_30);
                expectCell('F1 detail of c1', await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${c1}`), { status: 403, pair: { action: 'Members', resource: 'RA Profile' } });

                await applyFixture(m.api, m.sw, 'F2', m.refs, SPEC_30);
                const body = { name: runName('rbac-create-probe'), description: 'API-AUTH-30', attributes: [], customAttributes: [] };
                expectCell('F2 create an RA profile', await callAs(m.api, m.token, 'POST', `/api/v1/authorities/${m.refs.authorityUuid}/raProfiles`, body), { status: 403, pair: { action: 'Create', resource: 'RA Profile' } });
            });

            await test.step('⚠️ Inferred: a random certificate uuid is 403 for DED (F0), not 404', async () => {
                await applyFixture(m.api, m.sw, 'F0', m.refs, SPEC_30);
                const res = await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${m.api.probeUuid()}`);
                expect(res.status, 'no existence leak for a caller without the permission').toBe(403);
            });
        });

    test(`the 403 body's statusCode is 403`,
        testMeta({
            id: 'API-AUTH-30', row: 'statusCode', prio: 'P1', issue: 'ilm#427', needs: 'second-identity', bug: 'interfaces#887',
            rule: ['the body field `statusCode` was forced to 400 by the DTO getter until interfaces#887, fixed on the integration branch; baseline vs migrated body difference is a fix, not a regression', 'expected to fail only on builds without the interfaces#887 fix (conditional test.fail); needs the second identity'],
        }),
        async ({ api, env, restrictedToken }, testInfo) => {
            test.setTimeout(180_000);
            const m = await prepare({ api, env, restrictedToken: restrictedToken?.bearer() }, SPEC_30);
            await applyFixture(m.api, m.sw, 'F0', m.refs, SPEC_30);
            const build = await getBuildInfo(m.api);
            testInfo.annotations.push({ type: 'build', description: `core ${build.version ?? '?'} branch ${build.branch ?? '?'}` });
            // A separate test so the other 403 assertions are never masked: only a build WITHOUT the fix carries the bug.
            test.fail(!(await isMigratedBuild(m.api, testInfo)), 'interfaces#887: a build without the fix reports statusCode 400 inside a 403 body');
            const res = await callAs(m.api, m.token, 'GET', '/api/v1/roles');
            expect(res.status).toBe(403);
            expect(res.json?.statusCode, 'the body field statusCode').toBe(403);
        });

    // ------------------------------------------------------------------ API-AUTH-31

    const FIXTURE_WORDS: Record<Fixture, string> = {
        F0: 'a role without permissions', F1: 'a role with certificate list and detail', F2: 'an issuing role with one RA profile',
        F2b: 'a role with rights on one RA profile object', F3: 'a role with members right on one group', F4a: 'a role denied detail on one RA profile',
        F4b: 'a role denied members on one RA profile', F4c: 'a role denied list on one RA profile', F5: 'an allow-all role denied one RA profile',
        F6: 'a custom role derived from auditor',
    };
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
                id: 'API-AUTH-31', row: fixture, prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
                rule: [
                    'parent resource first: certificate detail adds RA_PROFILE:MEMBERS; group and owner fallback; certificate visibility = certificates:list AND RA-profile members, OR group members, OR owner; profile listings and resource-level actions; ilm#427 steps 1–3',
                    'matrix of certificate access; rows for certificates without an RA profile under an RA-profile deny) are NOT asserted here: API-AUTH-34',
                    'needs the second identity and a healthy CA for the fixture RA profiles',
                ],
            }),
            async ({ api, env, restrictedToken }) => {
                test.setTimeout(420_000);
                const m = await prepare({ api, env, restrictedToken: restrictedToken?.bearer() }, SPEC_31);
                const auditor = fixture === 'F6' ? await auditorDocument(m.api) : undefined;
                await test.step(`Fixture ${fixture} is DED's only role and is in force`, async () => applyFixture(m.api, m.sw, fixture, m.refs, SPEC_31, auditor));

                await test.step('Profile: 200, extra listings and the exact resource-level actions (never ANY / NONE)', async () => {
                    const profile = await m.sw.profile();
                    expect(profile, 'DED\'s profile answers 200').toBeDefined();
                    const want = MATRIX_A_PROFILE[fixture];
                    for (const listing of ['dashboard', 'approvals']) expect(profile!.allowedListings).toContain(listing);
                    if (want.extraListings === 'all-listable') {
                        for (const listing of ['certificates', 'raProfiles', 'authorities', 'users', 'roles', 'groups']) expect(profile!.allowedListings, `${fixture} lists ${listing}`).toContain(listing);
                    } else {
                        for (const listing of want.extraListings) expect(profile!.allowedListings, `${fixture} lists ${listing}`).toContain(listing);
                    }
                    const got = Object.fromEntries(profile!.allowedActions.map((a) => [a.resource, [...a.actions].sort()]));
                    expect(Object.values(got).flat().filter(isNotGrantableAction), 'no ANY / NONE').toEqual([]);
                    if (want.actions === 'all') expect(got.certificates, 'allow-all grants every certificate action').toEqual(expect.arrayContaining(['list', 'detail', 'create', 'issue']));
                    else if (want.actions === 'read-only') {
                        expect(got.certificates).toEqual(expect.arrayContaining(['list', 'detail']));
                        expect(got.certificates.filter((a) => !['list', 'detail', 'members', 'export'].includes(a)), 'a read-only document grants no write action').toEqual([]);
                    } else expect(got, `${fixture}: resource-level actions`).toEqual(want.actions);
                });

                await test.step('Certificates the caller can see (POST /v1/certificates, filtered to the run\'s six): the listed and the absent ones', async () => {
                    const seen = await visibleCertificates(m);
                    const want = MATRIX_A_LIST[fixture];
                    for (const k of want.present) expect(seen.has(k), `${fixture}: ${k} is listed`).toBe(true);
                    for (const k of want.absent) expect(seen.has(k), `${fixture}: ${k} is not listed`).toBe(false);
                });

                for (const key of CERT_KEYS) {
                    await test.step(`GET /v1/certificates/{${key}} → ${cellStatus(MATRIX_A_DETAIL[key][fixture])}`, async () => {
                        expectCell(`${fixture} detail ${key}`, await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${m.refs.certs[key].uuid}`), MATRIX_A_DETAIL[key][fixture]);
                    });
                }
            });
    }

    // ------------------------------------------------------------------ API-AUTH-32

    for (const fixture of FIXTURES) {
        test(`${GATE_WORDS[fixture]}`,
            testMeta({
                id: 'API-AUTH-32', row: fixture, prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
                rule: [
                    'issue = RA_PROFILE:DETAIL on the profile + AUTHORITY:DETAIL, then CERTIFICATE:CREATE, then the asynchronous CERTIFICATE:ISSUE; RA profile create = RA_PROFILE:CREATE + AUTHORITY:DETAIL; RA profile list = RA_PROFILE:LIST + AUTHORITY:LIST; core#2153; ilm#427 steps 4–6',
                    'matrix of write operations; Spring Security 7 method security: the nested-bean gates answer 403, never a silent 2xx',
                    'needs the second identity and a healthy CA for the issue rows',
                ],
            }),
            async ({ api, env, restrictedToken }) => {
                test.setTimeout(600_000);
                const m = await prepare({ api, env, restrictedToken: restrictedToken?.bearer() }, SPEC_32);
                const auditor = fixture === 'F6' ? await auditorDocument(m.api) : undefined;
                await test.step(`Fixture ${fixture} is DED's only role and is in force`, async () => applyFixture(m.api, m.sw, fixture, m.refs, SPEC_32, auditor));
                const { p1, p2, authorityUuid } = m.refs;

                await test.step('GET /v1/raProfiles: the rows seen, or the refusal', async () => {
                    const cell = MATRIX_B_RA_LIST[fixture];
                    const res = await callAs(m.api, m.token, 'GET', '/api/v1/raProfiles');
                    if (cell.status === 403) return expectCell(`${fixture} RA profile list`, res, { status: 403, pair: cell.pair });
                    expect(res.status, res.text.slice(0, 200)).toBe(200);
                    const uuids = new Set<string>((res.json as Array<{ uuid: string }>).map((r) => r.uuid));
                    for (const k of cell.has) expect(uuids.has(k === 'p1' ? p1.uuid : p2.uuid), `${fixture}: ${k} is listed`).toBe(true);
                    for (const k of cell.lacks) expect(uuids.has(k === 'p1' ? p1.uuid : p2.uuid), `${fixture}: ${k} is not listed`).toBe(false);
                });

                await test.step('GET /v1/raProfiles/{P1} and {P2}', async () => {
                    expectCell(`${fixture} detail P1`, await callAs(m.api, m.token, 'GET', `/api/v1/raProfiles/${p1.uuid}`), MATRIX_B_RA_DETAIL_P1[fixture]);
                    expectCell(`${fixture} detail P2`, await callAs(m.api, m.token, 'GET', `/api/v1/raProfiles/${p2.uuid}`), MATRIX_B_RA_DETAIL_P2[fixture]);
                });

                await test.step('POST /v1/authorities/{A}/raProfiles: refused with the pair, or (F5) a create under the pre-existing authority, recorded', async () => {
                    const name = runName(`rbac-create-${fixture.toLowerCase()}`);
                    const body = await raProfileCreateBody(m.api, m.refs.source, name);
                    const res = await callAs(m.api, m.token, 'POST', `/api/v1/authorities/${authorityUuid}/raProfiles`, body);
                    // Ledger before assertion: an RA profile DED managed to create is this run's object.
                    if (res.status < 300 && res.json?.uuid) recordCreated('raProfiles', { uuid: String(res.json.uuid), name }, SPEC_32, 'created by DED in the matrix (F5)', { authority: authorityUuid });
                    expectCell(`${fixture} create RA profile`, res, MATRIX_B_RA_CREATE[fixture]);
                });

                await test.step('v2 issue on P1 (accepted and issued for F2, F2b, F5; 403 otherwise) and on P2 (403 for all)', async () => {
                    const csr = csrWithSan(runName(`rbac-issue-${fixture.toLowerCase()}`), [`${runId()}.example.test`]);
                    const issue = (ra: string) => callAs(m.api, m.token, 'POST', `/api/v2/operations/authorities/${authorityUuid}/raProfiles/${ra}/certificates`, { request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [] });
                    const onP1 = await issue(p1.uuid);
                    if (onP1.status < 300 && onP1.json?.uuid) {
                        recordCreated('certificates', { uuid: String(onP1.json.uuid), name: runName(`rbac-issue-${fixture.toLowerCase()}`) }, SPEC_32, 'issued by DED in the matrix');
                        expectCell(`${fixture} issue on P1`, onP1, MATRIX_B_ISSUE_P1[fixture]);
                        await waitForCertificateState(m.api, String(onP1.json.uuid), 'issued', 180_000);
                    } else expectCell(`${fixture} issue on P1`, onP1, MATRIX_B_ISSUE_P1[fixture]);
                    expectCell(`${fixture} issue on P2`, await issue(p2.uuid), MATRIX_B_ISSUE_P2[fixture]);
                });

                await test.step('Administration: roles list, users list, role create, DED\'s own permissions endpoint', async () => {
                    expectCell(`${fixture} GET /v1/roles`, await callAs(m.api, m.token, 'GET', '/api/v1/roles'), MATRIX_B_ROLES_LIST[fixture]);
                    expectCell(`${fixture} GET /v1/users`, await callAs(m.api, m.token, 'GET', '/api/v1/users'), MATRIX_B_USERS_LIST[fixture]);
                    const roleName = runName(`rbac-role-probe-${fixture.toLowerCase()}`);
                    const created = await callAs(m.api, m.token, 'POST', '/api/v1/roles', { name: roleName, description: 'API-AUTH-32 probe', customAttributes: [] });
                    if (created.status < 300 && created.json?.uuid) recordCreated('roles', { uuid: String(created.json.uuid), name: roleName }, SPEC_32, 'created by DED in the matrix (F5)');
                    expectCell(`${fixture} POST /v1/roles`, created, MATRIX_B_ROLE_CREATE[fixture]);
                    const me = await m.sw.profile();
                    expectCell(`${fixture} GET /v1/users/{DED}/permissions`, await callAs(m.api, m.token, 'GET', `/api/v1/users/${me!.uuid}/permissions`), MATRIX_B_USER_PERMISSIONS[fixture]);
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
                            if (res.status < 300 && p.created && res.json?.uuid) recordCreated(p.created, { uuid: String(res.json.uuid), name: runName(`rbac-gate-${fixture.toLowerCase()}`) }, SPEC_32, 'created by DED through a gate that should have refused');
                            expect(res.status, `${fixture}: ${p.what} must be refused: ${res.text.slice(0, 200)}`).toBe(403);
                        }
                    });
                }
            });
    }

    // ------------------------------------------------------------------ API-AUTH-33

    for (const fixture of ['F4a', 'F4b', 'F4c'] as const) {
        test(`a deny is per action for ${FIXTURE_WORDS[fixture]}`,
            testMeta({
                id: 'API-AUTH-33', row: fixture, prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
                rule: [
                    'a deny on any requested uuid beats every allow; a listing is filtered: forbidden objects drop out; RA-profile `members` gates certificate visibility, `detail` does not; "deny wins" holds per action only',
                    'F4a denies `detail` on P2, F4b `members`, F4c `list`; the sub-row "a request naming P1 and P2 together → 403" is not expressible: no read endpoint names several RA profiles (reported)',
                    'needs the second identity and a healthy CA for the fixture RA profiles',
                ],
            }),
            async ({ api, env, restrictedToken }) => {
                test.setTimeout(420_000);
                const m = await prepare({ api, env, restrictedToken: restrictedToken?.bearer() }, SPEC_33);
                await test.step(`Fixture ${fixture} is DED's only role and is in force`, async () => applyFixture(m.api, m.sw, fixture, m.refs, SPEC_33));
                const want = DENY_NUANCES[fixture];

                await test.step('P2 detail: 403 Detail / RA Profile only for the `detail` deny; P1 detail stays 200', async () => {
                    expectCell(`${fixture} detail P2`, await callAs(m.api, m.token, 'GET', `/api/v1/raProfiles/${m.refs.p2.uuid}`), want.p2Detail);
                    expectCell(`${fixture} detail P1`, await callAs(m.api, m.token, 'GET', `/api/v1/raProfiles/${m.refs.p1.uuid}`), 200);
                });

                await test.step('The certificates of P2: visible (list and detail 200), or — a `members` deny — gone from the list and 403 Members / RA Profile on detail', async () => {
                    const seen = await visibleCertificates(m);
                    expect(seen.has('c1'), 'c1 (P1) stays listed').toBe(true);
                    expect(seen.has('c2'), `c2 (P2) is ${want.certificatesOfP2}`).toBe(want.certificatesOfP2 === 'visible');
                    expectCell(`${fixture} detail c2`, await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${m.refs.certs.c2.uuid}`),
                        want.certificatesOfP2 === 'visible' ? 200 : { status: 403, pair: { action: 'Members', resource: 'RA Profile' } });
                });

                await test.step('GET /v1/raProfiles: P2 is missing only for the `list` deny', async () => {
                    const res = await callAs(m.api, m.token, 'GET', '/api/v1/raProfiles');
                    expect(res.status, res.text.slice(0, 200)).toBe(200);
                    const uuids = (res.json as Array<{ uuid: string }>).map((r) => r.uuid);
                    expect(uuids).toContain(m.refs.p1.uuid);
                    expect(uuids.includes(m.refs.p2.uuid), `P2 in the RA profile list under ${fixture}`).toBe(want.p2InRaList);
                });
            });
    }
});

