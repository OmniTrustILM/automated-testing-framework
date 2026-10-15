/**
 * prot-scep — SCEP endpoint pins at the HTTP level (B2: API-PROT-35 GetCACert, API-PROT-37 malformed requests;
 * ilm#430 step 10).
 *
 * Setup (own objects only): F-CA (protocolCa) → RA* (`<run>-ra-scep-api`) → SCEP profile A (include flags OFF,
 * enabled, activated on RA*: the RA-profile URL) and SCEP profile B (include flags ON, RA* as its default RA profile:
 * the profile-based URL). GetCACert (RFC 8894 §4.2) answers the CA certificate and its issuers as a degenerate PKCS#7
 * (`application/x-x509-ca-ra-cert`) whatever the include flags say (rules §7.2 r13); when the chain has one
 * certificate the single-certificate arm (`application/x-x509-ca-cert`) is deferred (ledger) and the test skips with
 * that reason. API-PROT-37 pins the pre-PKIOperation error shape (rules §7.2 r12, r14: a `ScepException` before the
 * operation is HTTP 400 JSON `{"message":"SCEP error occurred: <text>, failInfo=<name>"}`) and the ilm#430 table
 * rows, including the migrated-only difference (core#2502: form-encoded binary body 401 instead of 400) as a
 * conditional `test.fail` and the unknown-operation NPE (core#2140 per the ledger) as a `test.fail`.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { isMigratedBuild } from '../../utils/regression/build';
import { expectMessageObject } from '../../utils/regression/errorContract';
import { GuardedApi } from '../../utils/regression/guardedApi';
import { ensureProtocolCaCertificate, orSkipWithoutProtocolCa, ProtocolCa } from '../../utils/regression/protocolCa';
import { fixedGarbage, protocolGet, protocolPost, ProtocolResponse, stackTextIn } from '../../utils/regression/protocolHttp';
import { caChainProblems, degeneratePkcs7Of, parseDegeneratePkcs7, Pkcs7Certificate, scepCaSetProblems, sha256Hex } from '../../utils/regression/protocolPki';
import {
    createOwnScepProfile, enableOwnScepProfile, ensureProtocolRaProfile, ensureScepActiveOnOwnRaProfile, OwnRaProfile, scepProfileUrl,
} from '../../utils/regression/protocolProfiles';
import { apiJson, orSkipWithoutCa } from '../../utils/regression/regressionApi';
import { OwnRef, regName } from '../../utils/regression/regressionRun';
import { meta } from '../../utils/regression/tags';
import { selfSignedPem } from '../../utils/regression/pki';

const SPEC = 'API-PROT-35';
const skip = (reason: string) => test.skip(true, reason);

interface ScepTargets {
    ca: ProtocolCa;
    ra: OwnRaProfile;
    /** Profile A (flags off) on the RA-profile URL. */
    profileOff: OwnRef;
    raUrl: string;
    /** Profile B (flags on) on the profile-based URL. */
    profileOn: OwnRef;
    profileUrl: string;
    /** What GetCACert must carry: F-CA plus core's own chain of it (`GET /v1/certificates/{uuid}/chain?withEndCertificate=true`). */
    expectedFingerprints: string[];
}

const SINGLE = /^application\/x-x509-ca-cert\b/i;
const CHAIN = /^application\/x-x509-ca-ra-cert\b/i;

test.describe('@api prot-scep', () => {
    let shared: ScepTargets | undefined;

    async function targets(api: GuardedApi, env: { baseUrl: string }): Promise<ScepTargets> {
        if (shared) return shared;
        const ca = await orSkipWithoutProtocolCa(orSkipWithoutCa(ensureProtocolCaCertificate(api, SPEC), skip), skip);
        const ra = await ensureProtocolRaProfile(api, SPEC, 'scep-api');
        const stamp = Date.now().toString(36);
        const profileOff = await createOwnScepProfile(api, SPEC, { name: regName(`scep-off-${stamp}`), caCertificateUuid: ca.certificate.uuid, includeCaCertificate: false, includeCaCertificateChain: false },
            'SCEP profile, include flags off, activated on RA* (API-PROT-35 / 37)');
        await enableOwnScepProfile(api, profileOff);
        const raUrl = await ensureScepActiveOnOwnRaProfile(api, ra, profileOff);
        const profileOn = await createOwnScepProfile(api, SPEC, { name: regName(`scep-on-${stamp}`), caCertificateUuid: ca.certificate.uuid, includeCaCertificate: true, includeCaCertificateChain: true, raProfileUuid: ra.uuid },
            'SCEP profile, include flags on, RA* as default RA profile (API-PROT-35)');
        await enableOwnScepProfile(api, profileOn);
        // ScepServiceImpl.loadCertificateChain answers exactly core's chain of the CA certificate (a side-effect GET on an OWN certificate).
        const chain = await apiJson<{ certificates?: Array<{ certificateContent?: string }> }>(api, 'GET', `/api/v1/certificates/${ca.certificate.uuid}/chain?withEndCertificate=true`);
        const expectedFingerprints = [...new Set([ca.certificate.fingerprint, ...(chain.certificates ?? []).map((c) => sha256Hex(Buffer.from(String(c.certificateContent ?? ''), 'base64')))])];
        shared = { ca, ra, profileOff, raUrl, profileOn, profileUrl: scepProfileUrl(env.baseUrl, profileOn.name), expectedFingerprints };
        return shared;
    }

    /** GetCACert of a URL: the chain-case certificates, or a skip when the server answers the single-certificate form. */
    async function getCaCert(url: string): Promise<{ res: ProtocolResponse; certificates: Pkcs7Certificate[] }> {
        const res = await protocolGet(`${url}?operation=GetCACert`);
        expect(res.status, res.text.slice(0, 200)).toBe(200);
        test.skip(SINGLE.test(res.contentType ?? ''), 'single-certificate GetCACert (application/x-x509-ca-cert): the chain has one certificate; the single arm is deferred (ledger API-PROT-35)');
        expect(res.contentType ?? '', 'application/x-x509-ca-ra-cert for a chain (RFC 8894 §4.2.1.2)').toMatch(CHAIN);
        return { res, certificates: parseDegeneratePkcs7(res.body) };
    }

    for (const flags of ['off', 'on'] as const) {
        test(`API-PROT-35[include flags ${flags}]: GetCACert answers a degenerate PKCS#7 with F-CA and its issuers as application/x-x509-ca-ra-cert`,
            meta({
                id: 'API-PROT-35', prio: 'P1', issue: 'ilm#430',
                rule: [
                    'protocols §7.2 r13: GetCACert: one certificate → application/x-x509-ca-cert; a chain → degenerate CMS application/x-x509-ca-ra-cert; the include-CA flags do not affect GetCACert',
                    'RFC 8894 §4.2.1.2: the CA certificate and its issuers in a certs-only SignedData',
                    'protocols §7.2 r2: the SCEP CA certificate is F-CA (own token key, issued through the run RA profile)',
                ],
            }),
            async ({ api, env }) => {
                // F-CA (token, key, issuance ≤ 180 s) on the first test, then two reads.
                test.setTimeout(240_000);
                const t = await test.step('Prerequisite: F-CA, RA*, SCEP profiles with the flags off (RA-profile URL) and on (profile URL)', async () => targets(api, env));
                const url = flags === 'off' ? t.raUrl : t.profileUrl;
                const { certificates } = await test.step(`GET ${flags === 'off' ? 'RA-profile' : 'profile'} URL ?operation=GetCACert → 200 application/x-x509-ca-ra-cert`, async () => getCaCert(url));
                await test.step('The PKCS#7 parses and holds F-CA (by fingerprint) and exactly the chain core returns for it', async () => {
                    expect(certificates.length, 'chain of at least two certificates').toBeGreaterThanOrEqual(2);
                    expect(caChainProblems(certificates, t.ca.certificate.fingerprint)).toEqual([]);
                    expect(scepCaSetProblems(certificates, t.expectedFingerprints)).toEqual([]);
                });
                if (flags === 'on') {
                    await test.step('Identical to the answer with the flags off (same certificate set)', async () => {
                        const off = await getCaCert(t.raUrl);
                        expect(certificates.map((c) => c.fingerprint).sort()).toEqual(off.certificates.map((c) => c.fingerprint).sort());
                    });
                }
            });
    }

    // ------------------------------------------------------------------ API-PROT-37

    /** The SCEP pre-operation error body: 400, `{message}` "SCEP error occurred: …, failInfo=<name>". */
    function expectScepError(res: ProtocolResponse, failInfo: string): void {
        expect(res.status, res.text.slice(0, 300)).toBe(400);
        const message = expectMessageObject(res.text);
        expect(message).toMatch(/^SCEP error occurred: /);
        expect(message).toContain(`failInfo=${failInfo}`);
        expect(stackTextIn(res.text)).toBeUndefined();
    }

    /** Fixed bytes (a sha256 chain of a constant): the same request on every run. */
    const garbage = (): Buffer => fixedGarbage('API-PROT-37', 256);
    /** A real CMS (certs-only SignedData) cut at 60 %: DER that starts right and ends wrong. */
    const truncatedCms = (): Buffer => {
        const whole = degeneratePkcs7Of([selfSignedPem(regName('scep-truncated')).pem]);
        return whole.subarray(0, Math.floor(whole.length * 0.6));
    };

    test('API-PROT-37[random bytes]: PKIOperation with random bytes as application/x-pki-message answers 400 JSON failInfo=badMessageCheck',
        meta({ id: 'API-PROT-37', prio: 'P1', issue: 'ilm#430', rule: ['ilm#430 table "SCEP garbage PKIOperation (x-pki-message) → 400, failInfo=badMessageCheck" (both stacks)', 'protocols §7.2 r12 / r14: a ScepException before the operation is HTTP 400 JSON {"message":"SCEP error occurred: <text>, failInfo=<name>"}; a CMS that does not parse is badMessageCheck (ScepRequest)'] }),
        async ({ api, env }) => {
            test.setTimeout(240_000);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on RA*', async () => targets(api, env));
            const res = await test.step('POST ?operation=PKIOperation with 256 random bytes (application/x-pki-message)', async () =>
                protocolPost(`${t.raUrl}?operation=PKIOperation`, { contentType: 'application/x-pki-message', body: garbage() }));
            await test.step('400 {message} "SCEP error occurred: …, failInfo=badMessageCheck"', async () => expectScepError(res, 'badMessageCheck'));
        });

    test('API-PROT-37[truncated CMS]: PKIOperation with a truncated CMS answers 400 JSON failInfo=badMessageCheck',
        meta({ id: 'API-PROT-37', prio: 'P1', issue: 'ilm#430', rule: ['ilm#430 table "SCEP garbage PKIOperation → 400 failInfo=badMessageCheck"', 'protocols §7.2 r14: a parse failure before PKIOperation is a ScepException → 400 JSON (RFC 8894 §3.2.1.4 badMessageCheck)'] }),
        async ({ api, env }) => {
            test.setTimeout(240_000);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on RA*', async () => targets(api, env));
            const res = await test.step('POST ?operation=PKIOperation with a CMS cut at 60 % (application/x-pki-message)', async () =>
                protocolPost(`${t.raUrl}?operation=PKIOperation`, { contentType: 'application/x-pki-message', body: truncatedCms() }));
            await test.step('400 {message} …failInfo=badMessageCheck', async () => expectScepError(res, 'badMessageCheck'));
        });

    test('API-PROT-37[form-encoded valid body]: a valid-looking message sent form-encoded answers 400 "Unable to read HTTP message"',
        meta({ id: 'API-PROT-37', prio: 'P1', issue: 'ilm#430', rule: ['ilm#430 table "SCEP form-encoded valid body → 400 Unable to read HTTP message" (both stacks)'] }),
        async ({ api, env }) => {
            test.setTimeout(240_000);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on RA*', async () => targets(api, env));
            const cms = degeneratePkcs7Of([selfSignedPem(regName('scep-form')).pem]).toString('base64');
            const res = await test.step('POST ?operation=PKIOperation as application/x-www-form-urlencoded with message=<base64 CMS>', async () =>
                protocolPost(`${t.raUrl}?operation=PKIOperation`, { contentType: 'application/x-www-form-urlencoded', body: `message=${encodeURIComponent(cms)}` }));
            await test.step('400 and "Unable to read HTTP message"', async () => {
                expect(res.status, res.text.slice(0, 300)).toBe(400);
                expect(res.text).toContain('Unable to read HTTP message');
                expect(stackTextIn(res.text)).toBeUndefined();
            });
        });

    test('API-PROT-37[form-encoded binary body]: random bytes sent form-encoded answer 400 with an empty body (401 on the migrated build: core#2502)',
        meta({ id: 'API-PROT-37', prio: 'P1', issue: 'ilm#430', bug: 'core#2502', rule: ['ilm#430 table "SCEP form-encoded binary body: 400 empty on the baseline, 401 empty on the migrated build" (C-X2); core#2502 for the migrated difference (O6: isMigratedBuild decides the marker)'] }),
        async ({ api, env }, testInfo) => {
            test.setTimeout(240_000);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on RA*', async () => targets(api, env));
            const migrated = await test.step('Build marker: is this the migrated build?', async () => isMigratedBuild(api, testInfo));
            test.fail(migrated, 'core#2502: the migrated build answers 401 instead of 400 for a form-encoded binary body');
            const res = await test.step('POST ?operation=PKIOperation as application/x-www-form-urlencoded with 256 random bytes', async () =>
                protocolPost(`${t.raUrl}?operation=PKIOperation`, { contentType: 'application/x-www-form-urlencoded', body: garbage() }));
            await test.step('400 with an empty body', async () => {
                expect(res.status, res.text.slice(0, 300)).toBe(400);
                expect(res.text.trim()).toBe('');
            });
        });

    test('API-PROT-37[missing operation]: a POST without the operation parameter answers 400',
        meta({ id: 'API-PROT-37', prio: 'P1', issue: 'ilm#430', rule: ['protocols §7.2 endpoint: `operation` is a required request parameter (ScepRaProfileController); a missing required parameter is 400, never 5xx'] }),
        async ({ api, env }) => {
            test.setTimeout(240_000);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on RA*', async () => targets(api, env));
            const res = await test.step('POST the RA-profile URL without ?operation (application/x-pki-message, random bytes)', async () =>
                protocolPost(t.raUrl, { contentType: 'application/x-pki-message', body: garbage() }));
            await test.step('400, no stack text', async () => {
                expect(res.status, res.text.slice(0, 300)).toBe(400);
                expect(stackTextIn(res.text)).toBeUndefined();
            });
        });

    // Suspected product defect (reviewer): the intended answer is a SCEP failure `badRequest` "Unsupported Operation"
    // (ScepServiceImpl.service :290-292 `default -> buildResponse(null, buildFailedResponse(…BAD_REQUEST…))`), but
    // `buildResponse(null, …)` dereferences the null request → NPE → 500 (ilm#430 table, both stacks). The mechanism is
    // not core#2140 (a Content-Type mismatch), so no @bug is pinned here: the test asserts the intended behaviour and
    // stays red until the defect is confirmed against the acceptance criteria and filed.
    test('API-PROT-37[unknown operation]: an unknown operation is answered as a SCEP badRequest failure, never 5xx',
        meta({ id: 'API-PROT-37', prio: 'P1', issue: 'ilm#430', rule: ['protocols §7.2 r12: a ScepException before the operation is HTTP 400 JSON "SCEP error occurred: <text>, failInfo=<name>" (the code builds an "Unsupported Operation" badRequest failure: ScepServiceImpl.service :290-292); ilm#430 table records 500 today (suspected defect, not core#2140)'] }),
        async ({ api, env }) => {
            test.setTimeout(240_000);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on RA*', async () => targets(api, env));
            const res = await test.step('POST ?operation=QaNoSuchOperation (application/x-pki-message, fixed bytes)', async () =>
                protocolPost(`${t.raUrl}?operation=QaNoSuchOperation`, { contentType: 'application/x-pki-message', body: garbage() }));
            await test.step('a SCEP badRequest failure (400 JSON "…failInfo=badRequest" or a signed CertRep FAILURE as application/x-pki-message), never 5xx', async () => {
                expect(res.status, res.text.slice(0, 300)).toBeLessThan(500);
                const certRep = /^application\/x-pki-message\b/i.test(res.contentType ?? '');
                if (!certRep) expectScepError(res, 'badRequest');
                else expect(res.status).toBe(200);
            });
        });
});
