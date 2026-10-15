/**
 * auth-rbac-matrix — the RBAC decision table through the API as the dedicated second identity (auth-rbac area, B2 / B5 rows
 * API-AUTH-30, 31, 32, 33; ilm#427 steps 1–6; rules E1–E13, G2, J).
 *
 * Every row needs DED (DevOps request 2). The guard requests GR-2 (the bearer tokens) and GR-3 (the DED ILM user is the suite's own
 * but its name is not run-prefixed) were accepted by the guard pass and merged (2026-10-15), so the tests are plain tests; each body
 * starts with the `@needs:second-identity` / replica / CA preflights and skips with the named reason until the account exists. The matrices are in `utils/regression/rbacFixtures.ts` (rule-derived and unproven live: the first execution
 * runs on a local stack with a second identity; a mismatch is a finding to confirm as a bug first, never an adjusted oracle).
 *
 * One Playwright test per fixture (`API-AUTH-31[F0]` …): the admin builds an OWN role from the fixture's permission document
 * (through the API, never the editor: fe-administrator#2283), makes it DED's only role, waits until DED's profile reflects it
 * (the role-switch barrier, one core replica), and DED's token (`identityOverride`, every ownership rule of the guard still
 * applies to what the request names) walks the rows. Fixtures are not isolated by prefix: the certificate list is filtered
 * to the run's `rbac` certificates, so pre-existing certificates DED may see do not matter.
 *
 * Universal oracles: no status 5xx; every 403 has the ACCESS_DENIED body shape (`accessDeniedProblems`).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { getBuildInfo, isMigratedBuild } from '../../utils/regression/build';
import { callAs, isNotGrantableAction, restrictedIdentity, replicaBlocker, secondIdentityBlocker } from '../../utils/regression/identities';
import {
    applyFixture, auditorDocument, ensureRbacObjects, ensureRestrictedUserOrSkip, raProfileCreateBody, RbacObjects, restrictedRoleSwitch, RoleSwitch,
} from '../../utils/regression/rbacData';
import {
    accessDeniedProblems, CERT_KEYS, Cell, cellPair, cellStatus, CertKey, DENY_NUANCES, Fixture, FIXTURES, MATRIX_A_DETAIL, MATRIX_A_LIST, MATRIX_A_PROFILE,
    MATRIX_B_ISSUE_P1, MATRIX_B_ISSUE_P2, MATRIX_B_RA_CREATE, MATRIX_B_RA_DETAIL_P1, MATRIX_B_RA_DETAIL_P2, MATRIX_B_RA_LIST, MATRIX_B_ROLE_CREATE,
    MATRIX_B_ROLES_LIST, MATRIX_B_USER_PERMISSIONS, MATRIX_B_USERS_LIST, NESTED_GATE_FIXTURES,
} from '../../utils/regression/rbacFixtures';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { csrWithSan, selfSignedPem } from '../../utils/regression/pki';
import { RaProfileSourceMissing } from '../../utils/regression/regressionApi';
import { recordCreated, regName, RUN_ID } from '../../utils/regression/regressionRun';
import { meta, tags } from '../../utils/regression/tags';
import type { TestEnv } from '../../utils/env';
import type { GuardedApi } from '../../utils/regression/guardedApi';

const SPEC_30 = 'API-AUTH-30';
const SPEC_31 = 'API-AUTH-31';
const SPEC_32 = 'API-AUTH-32';
const SPEC_33 = 'API-AUTH-33';

const GR = 'needs the second identity';

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
    const ded = restrictedIdentity()!;
    // A DED user an earlier run left behind is a named skip, never an adoption (Fable F5).
    const user = await ensureRestrictedUserOrSkip(fx.api, spec, ded, (reason) => test.skip(true, reason));
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
        itemsPerPage: 100, pageNumber: 1, filters: [{ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', condition: 'STARTS_WITH', value: `${RUN_ID}-rbac-` }],
    });
    expect(res.status, `the certificate search as DED: ${res.text.slice(0, 200)}`).toBe(200);
    const names = new Set<string>((res.json?.certificates ?? []).map((c: { commonName: string }) => c.commonName));
    return new Set(CERT_KEYS.filter((k) => names.has(m.refs.certs[k].name)));
}

test.describe('API-AUTH RBAC matrix (second identity)', { tag: tags.api }, () => {
    // ------------------------------------------------------------------ API-AUTH-30

    test(`API-AUTH-30[contract]: no credentials 401, DED without the permission 403 (problem+json, ACCESS_DENIED, the Action / Resource pair), the admin 200 (${GR}; the anonymous leg uses anonymousApi)`,
        meta({
            id: 'API-AUTH-30', prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
            rule: [
                'auth-rbac G1 (401 = no or failed authentication), G2 (403 = application/problem+json, code ACCESS_DENIED, message "Access Denied. Required \'<Action>\' permission for \'<Resource>\'", the action in human form: "Check Compliance", `BeautificationUtil.camelToHumanForm`); core#165; AR-600',
                '⚠️ Inferred: a random uuid detail answers 403 for DED, not 404 (no existence leak)',
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
                const body = { name: regName('rbac-create-probe'), description: 'API-AUTH-30', attributes: [], customAttributes: [] };
                expectCell('F2 create an RA profile', await callAs(m.api, m.token, 'POST', `/api/v1/authorities/${m.refs.authorityUuid}/raProfiles`, body), { status: 403, pair: { action: 'Create', resource: 'RA Profile' } });
            });

            await test.step('⚠️ Inferred: a random certificate uuid is 403 for DED (F0), not 404', async () => {
                await applyFixture(m.api, m.sw, 'F0', m.refs, SPEC_30);
                const res = await callAs(m.api, m.token, 'GET', `/api/v1/certificates/${m.api.probeUuid()}`);
                expect(res.status, 'no existence leak for a caller without the permission').toBe(403);
            });
        });

    test(`API-AUTH-30[statusCode]: the 403 body's statusCode is 403 (conditional test.fail on builds without interfaces#887; ${GR})`,
        meta({
            id: 'API-AUTH-30', prio: 'P1', issue: 'ilm#427', needs: 'second-identity', bug: 'interfaces#887',
            rule: ['auth-rbac G2 (the body field `statusCode` was forced to 400 by the DTO getter until interfaces#887, fixed on the integration branch; baseline vs migrated body difference is a fix, not a regression: rules §6.1 C15); AR-600'],
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

    for (const fixture of FIXTURES) {
        test(`API-AUTH-31[${fixture}]: profile and certificate visibility matrix A, fixture ${fixture} (${GR}; a healthy CA for the fixture RA profiles)`,
            meta({
                id: 'API-AUTH-31', prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
                rule: [
                    'auth-rbac E7 (parent resource first: certificate detail adds RA_PROFILE:MEMBERS), E8 (group and owner fallback), E9 (certificate visibility = certificates:list AND RA-profile members, OR group members, OR owner), E13 (profile listings and resource-level actions), AR-400…AR-403, AR-604; ilm#427 steps 1–3',
                    'matrix A (the test plan §3.3); H-1 rows (certificates without an RA profile under an RA-profile deny) are NOT asserted here: API-AUTH-34',
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
        test(`API-AUTH-32[${fixture}]: RA profile, authority and issue gates, matrix B, fixture ${fixture} (${GR}; a healthy CA for the issue rows)`,
            meta({
                id: 'API-AUTH-32', prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
                rule: [
                    'auth-rbac E7 (issue = RA_PROFILE:DETAIL on the profile + AUTHORITY:DETAIL, then CERTIFICATE:CREATE, then the asynchronous CERTIFICATE:ISSUE; RA profile create = RA_PROFILE:CREATE + AUTHORITY:DETAIL; RA profile list = RA_PROFILE:LIST + AUTHORITY:LIST), AR-405…AR-408, AR-605; core#2153; ilm#427 steps 4–6',
                    'matrix B (the test plan §3.4); Spring Security 7 method security: the nested-bean gates answer 403, never a silent 2xx (AR-605)',
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
                    const name = regName(`rbac-create-${fixture.toLowerCase()}`);
                    const body = await raProfileCreateBody(m.api, m.refs.source, name);
                    const res = await callAs(m.api, m.token, 'POST', `/api/v1/authorities/${authorityUuid}/raProfiles`, body);
                    // Ledger before assertion: an RA profile DED managed to create is this run's object.
                    if (res.status < 300 && res.json?.uuid) recordCreated('raProfiles', { uuid: String(res.json.uuid), name }, SPEC_32, 'created by DED in the matrix (F5)', { authority: authorityUuid });
                    expectCell(`${fixture} create RA profile`, res, MATRIX_B_RA_CREATE[fixture]);
                });

                await test.step('v2 issue on P1 (accepted and issued for F2, F2b, F5; 403 otherwise) and on P2 (403 for all)', async () => {
                    const csr = csrWithSan(regName(`rbac-issue-${fixture.toLowerCase()}`), [`${RUN_ID}.example.test`]);
                    const issue = (ra: string) => callAs(m.api, m.token, 'POST', `/api/v2/operations/authorities/${authorityUuid}/raProfiles/${ra}/certificates`, { request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [] });
                    const onP1 = await issue(p1.uuid);
                    if (onP1.status < 300 && onP1.json?.uuid) {
                        recordCreated('certificates', { uuid: String(onP1.json.uuid), name: regName(`rbac-issue-${fixture.toLowerCase()}`) }, SPEC_32, 'issued by DED in the matrix');
                        expectCell(`${fixture} issue on P1`, onP1, MATRIX_B_ISSUE_P1[fixture]);
                        await waitForCertificateState(m.api, String(onP1.json.uuid), 'issued', 180_000);
                    } else expectCell(`${fixture} issue on P1`, onP1, MATRIX_B_ISSUE_P1[fixture]);
                    expectCell(`${fixture} issue on P2`, await issue(p2.uuid), MATRIX_B_ISSUE_P2[fixture]);
                });

                await test.step('Administration: roles list, users list, role create, DED\'s own permissions endpoint', async () => {
                    expectCell(`${fixture} GET /v1/roles`, await callAs(m.api, m.token, 'GET', '/api/v1/roles'), MATRIX_B_ROLES_LIST[fixture]);
                    expectCell(`${fixture} GET /v1/users`, await callAs(m.api, m.token, 'GET', '/api/v1/users'), MATRIX_B_USERS_LIST[fixture]);
                    const roleName = regName(`rbac-role-probe-${fixture.toLowerCase()}`);
                    const created = await callAs(m.api, m.token, 'POST', '/api/v1/roles', { name: roleName, description: 'API-AUTH-32 probe', customAttributes: [] });
                    if (created.status < 300 && created.json?.uuid) recordCreated('roles', { uuid: String(created.json.uuid), name: roleName }, SPEC_32, 'created by DED in the matrix (F5)');
                    expectCell(`${fixture} POST /v1/roles`, created, MATRIX_B_ROLE_CREATE[fixture]);
                    const me = await m.sw.profile();
                    expectCell(`${fixture} GET /v1/users/{DED}/permissions`, await callAs(m.api, m.token, 'GET', `/api/v1/users/${me!.uuid}/permissions`), MATRIX_B_USER_PERMISSIONS[fixture]);
                });

                if (NESTED_GATE_FIXTURES.includes(fixture)) {
                    await test.step('Nested-bean gates (Spring Security 7 method security): each sample call is 403, never a silent 2xx', async () => {
                        const upload = selfSignedPem(regName(`rbac-gate-${fixture.toLowerCase()}`));
                        const probes: Array<{ what: string; send: () => ReturnType<typeof callAs>; created?: 'certificates' }> = [
                            { what: 'upload a certificate', created: 'certificates', send: () => callAs(m.api, m.token, 'POST', '/api/v1/certificates/upload', { certificate: Buffer.from(upload.pem).toString('base64'), customAttributes: [] }) },
                            { what: 'delete a certificate', send: () => callAs(m.api, m.token, 'DELETE', `/api/v1/certificates/${m.api.probeUuid()}`) },
                            { what: 'enable an RA profile', send: () => callAs(m.api, m.token, 'PATCH', `/api/v1/authorities/${authorityUuid}/raProfiles/${p1.uuid}/enable`) },
                            { what: 'archive a certificate', send: () => callAs(m.api, m.token, 'PATCH', '/api/v1/certificates/archive', [m.api.probeUuid()]) },
                        ];
                        for (const p of probes) {
                            const res = await p.send();
                            if (res.status < 300 && p.created && res.json?.uuid) recordCreated(p.created, { uuid: String(res.json.uuid), name: regName(`rbac-gate-${fixture.toLowerCase()}`) }, SPEC_32, 'created by DED through a gate that should have refused');
                            expect(res.status, `${fixture}: ${p.what} must be refused: ${res.text.slice(0, 200)}`).toBe(403);
                        }
                    });
                }
            });
    }

    // ------------------------------------------------------------------ API-AUTH-33

    for (const fixture of ['F4a', 'F4b', 'F4c'] as const) {
        test(`API-AUTH-33[${fixture}]: a deny is per action — fixture ${fixture} (${GR}; a healthy CA for the fixture RA profiles)`,
            meta({
                id: 'API-AUTH-33', prio: 'P1', issue: 'ilm#427', needs: 'second-identity',
                rule: [
                    'auth-rbac E4 (a deny on any requested uuid beats every allow), E5 (a listing is filtered: forbidden objects drop out), E9 (RA-profile `members` gates certificate visibility, `detail` does not); AR-404; release plan REG-CFG-08 N1 ("deny wins" holds per action only)',
                    'F4a denies `detail` on P2, F4b `members`, F4c `list`; the sub-row "a request naming P1 and P2 together → 403" is not expressible: no read endpoint names several RA profiles (reported)',
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

