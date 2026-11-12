/**
 * API-PROT-35, API-PROT-37 — SCEP endpoint answers. ilm#430.
 *
 * WHAT: 1. GetCACert with the include flags off (RA-profile URL) and on (profile URL) answers the protocol CA and its issuers as a
 *          degenerate PKCS#7 (application/x-x509-ca-ra-cert) holding exactly the CA and the chain core returns for it; both flag settings
 *          give the same certificate set.
 *       2. A PKIOperation of random bytes and one of a CMS cut at 60 % → 400 {message} "SCEP error occurred: …, failInfo=badMessageCheck".
 *       3. A form-encoded PKIOperation → 400 "Unable to read HTTP message"; form-encoded random bytes → 400 with an empty body (core#2502:
 *          401 on the migrated build, test.fail there); a POST without the operation parameter → 400.
 *       4. An unknown operation must be a SCEP badRequest failure and never a 5xx (core#2563: today a null request is dereferenced and the
 *          answer is a 500, test.fail).
 * WHY: GetCACert returns the protocol CA and its issuers whatever the include flags say (RFC 8894 §4.2.1.2); a ScepException before the
 *      operation is HTTP 400 with a JSON {message}; a CMS that does not parse is badMessageCheck (RFC 8894 §3.2.1.4). A malformed request
 *      is never a 5xx.
 * HOW: two own SCEP profiles (flags off and on) and one dedicated own RA profile, created once for the file and recorded in the ledger
 *      (skip with the named reason without a CA or protocol CA certificate); the SCEP CA certificate has its own token key and is issued
 *      through the run RA profile,
 *      hence the long time limit. The garbage bytes are fixed so a failure replays byte for byte; the `test.fail()` of a known bug sits
 *      right before the step it breaks.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { isMigratedBuild } from '../../../utils/regression/coreBuild';
import { expectMessageObject } from '../../../utils/regression/errorContract';
import { GuardedApi } from '../../../utils/regression/guard/types';
import { ensureProtocolCaCertificate, orSkipWithoutProtocolCa, ProtocolCa } from '../../../utils/regression/protocols/protocolCa';
import { fixedGarbage, protocolGet, protocolPost, ProtocolResponse, stackTextIn } from '../../../utils/regression/protocols/protocolHttp';
import { caChainProblems, degeneratePkcs7Of, parseDegeneratePkcs7, Pkcs7Certificate, scepCaSetProblems } from '../../../utils/regression/protocols/protocolResponseReaders';
import { sha256Hex, selfSignedPem } from '../../../utils/regression/pkiBuilders';
import { createOwnScepProfile, enableOwnScepProfile, ensureScepActiveOnOwnRaProfile, scepProfileUrl } from '../../../utils/regression/protocols/protocolProfiles';
import { ensureProtocolRaProfile, OwnRaProfile } from '../../../utils/regression/ownRaProfiles';
import { apiJson } from '../../../utils/regression/apiReads';
import { OwnRef } from '../../../utils/regression/ledger/ledger';
import { runName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ISSUE_MS } from '../../../utils/regression/timeouts';

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
    /**
     * What GetCACert must carry: the protocol CA plus core's own chain of it (`GET /v1/certificates/{uuid}/chain?withEndCertificate=true`).
     */
    expectedFingerprints: string[];
}

const SINGLE = /^application\/x-x509-ca-cert\b/i;
const CHAIN = /^application\/x-x509-ca-ra-cert\b/i;

test.describe('SCEP endpoint answers', { tag: tags.api }, () => {
    let shared: ScepTargets | undefined;

    async function targets(api: GuardedApi, spec: string, env: { baseUrl: string }): Promise<ScepTargets> {
        if (shared) return shared;
        const ca = await orSkipWithoutProtocolCa(ensureProtocolCaCertificate(api, spec), skip);
        const ra = await ensureProtocolRaProfile(api, spec, 'scep-api');
        const profileOff = await createOwnScepProfile(api, spec, 'scep-off', { caCertificateUuid: ca.certificate.uuid, includeCaCertificate: false, includeCaCertificateChain: false, note: 'SCEP profile, include flags off, activated on the dedicated RA profile' });
        await enableOwnScepProfile(api, profileOff);
        const raUrl = await ensureScepActiveOnOwnRaProfile(api, ra, profileOff);
        const profileOn = await createOwnScepProfile(api, spec, 'scep-on', { caCertificateUuid: ca.certificate.uuid, includeCaCertificate: true, includeCaCertificateChain: true, raProfileUuid: ra.uuid, note: 'SCEP profile, include flags on, the dedicated RA profile as default RA profile' });
        await enableOwnScepProfile(api, profileOn);
        // ScepServiceImpl.loadCertificateChain answers exactly core's chain of the CA certificate (a side-effect GET on an OWN
        // certificate).
        const chain = await apiJson<{ certificates?: Array<{ certificateContent?: string }> }>(api, 'GET', `/api/v1/certificates/${ca.certificate.uuid}/chain?withEndCertificate=true`);
        const expectedFingerprints = [...new Set([ca.certificate.fingerprint, ...(chain.certificates ?? []).map((c) => sha256Hex(Buffer.from(String(c.certificateContent ?? ''), 'base64')))])];
        shared = { ca, ra, profileOff, raUrl, profileOn, profileUrl: scepProfileUrl(env.baseUrl, profileOn.name), expectedFingerprints };
        return shared;
    }

    /** GetCACert of a URL: the chain-case certificates, or a skip when the server answers the single-certificate form. */
    async function getCaCert(url: string): Promise<{ res: ProtocolResponse; certificates: Pkcs7Certificate[] }> {
        const res = await protocolGet(`${url}?operation=GetCACert`);
        expect(res.status, res.text.slice(0, 200)).toBe(200);
        test.skip(SINGLE.test(res.contentType ?? ''), 'single-certificate GetCACert (application/x-x509-ca-cert): the chain has one certificate; the single arm is not covered here');
        expect(res.contentType ?? '', 'application/x-x509-ca-ra-cert for a chain (RFC 8894 §4.2.1.2)').toMatch(CHAIN);
        return { res, certificates: parseDegeneratePkcs7(res.body) };
    }

    for (const flags of ['off', 'on'] as const) {
        test(`GetCACert with the include flags ${flags} answers the CA and its issuers as PKCS#7`,
            testMeta({
                id: 'API-PROT-35', row: `include flags ${flags}`, prio: 'P1', needs: 'ca', issue: 'ilm#430',
                rule: [
                    'GetCACert: one certificate → application/x-x509-ca-cert; a chain → degenerate CMS application/x-x509-ca-ra-cert; the include-CA flags do not affect GetCACert',
                    'RFC 8894 §4.2.1.2: the CA certificate and its issuers in a certs-only SignedData',
                    'the SCEP CA certificate has its own token key and is issued through the run RA profile',
                ],
            }),
            async ({ api, env, own }) => {
                // the protocol CA (token, key, issuance ≤ 180 s) on the first test, then two reads.
                test.setTimeout(ISSUE_MS);
                const t = await test.step('Prerequisite: the protocol CA, the dedicated RA profile, SCEP profiles with the flags off (RA-profile URL) and on (profile URL)', async () => targets(api, own.spec, env));
                const url = flags === 'off' ? t.raUrl : t.profileUrl;
                const { certificates } = await test.step(`GET ${flags === 'off' ? 'RA-profile' : 'profile'} URL ?operation=GetCACert → 200 application/x-x509-ca-ra-cert`, async () => getCaCert(url));
                await test.step('The PKCS#7 parses and holds the protocol CA (by fingerprint) and exactly the chain core returns for it', async () => {
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
        const whole = degeneratePkcs7Of([selfSignedPem(runName('scep-truncated')).pem]);
        return whole.subarray(0, Math.floor(whole.length * 0.6));
    };

    test('a PKIOperation of random bytes answers 400 badMessageCheck',
        testMeta({ id: 'API-PROT-37', row: 'random bytes', prio: 'P1', needs: 'ca', issue: 'ilm#430', rule: ['ilm#430 table "SCEP garbage PKIOperation (x-pki-message) → 400, failInfo=badMessageCheck" (both stacks)', 'a ScepException before the operation is HTTP 400 JSON {"message":"SCEP error occurred: <text>, failInfo=<name>"}; a CMS that does not parse is badMessageCheck (ScepRequest)'] }),
        async ({ api, env, own }) => {
            test.setTimeout(ISSUE_MS);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on the dedicated RA profile', async () => targets(api, own.spec, env));
            const res = await test.step('POST ?operation=PKIOperation with 256 random bytes (application/x-pki-message)', async () =>
                protocolPost(`${t.raUrl}?operation=PKIOperation`, { contentType: 'application/x-pki-message', body: garbage() }));
            await test.step('400 {message} "SCEP error occurred: …, failInfo=badMessageCheck"', async () => expectScepError(res, 'badMessageCheck'));
        });

    test('a truncated PKIOperation answers 400 badMessageCheck',
        testMeta({ id: 'API-PROT-37', row: 'truncated CMS', prio: 'P1', needs: 'ca', issue: 'ilm#430', rule: ['ilm#430 table "SCEP garbage PKIOperation → 400 failInfo=badMessageCheck"', 'a parse failure before PKIOperation is a ScepException → 400 JSON (RFC 8894 §3.2.1.4 badMessageCheck)'] }),
        async ({ api, env, own }) => {
            test.setTimeout(ISSUE_MS);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on the dedicated RA profile', async () => targets(api, own.spec, env));
            const res = await test.step('POST ?operation=PKIOperation with a CMS cut at 60 % (application/x-pki-message)', async () =>
                protocolPost(`${t.raUrl}?operation=PKIOperation`, { contentType: 'application/x-pki-message', body: truncatedCms() }));
            await test.step('400 {message} …failInfo=badMessageCheck', async () => expectScepError(res, 'badMessageCheck'));
        });

    test('a form-encoded PKIOperation is refused with 400',
        testMeta({ id: 'API-PROT-37', row: 'form-encoded valid body', prio: 'P1', needs: 'ca', issue: 'ilm#430', rule: ['ilm#430 table "SCEP form-encoded valid body → 400 Unable to read HTTP message" (both stacks)'] }),
        async ({ api, env, own }) => {
            test.setTimeout(ISSUE_MS);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on the dedicated RA profile', async () => targets(api, own.spec, env));
            const cms = degeneratePkcs7Of([selfSignedPem(runName('scep-form')).pem]).toString('base64');
            const res = await test.step('POST ?operation=PKIOperation as application/x-www-form-urlencoded with message=<base64 CMS>', async () =>
                protocolPost(`${t.raUrl}?operation=PKIOperation`, { contentType: 'application/x-www-form-urlencoded', body: `message=${encodeURIComponent(cms)}` }));
            await test.step('400 and "Unable to read HTTP message"', async () => {
                expect(res.status, res.text.slice(0, 300)).toBe(400);
                expect(res.text).toContain('Unable to read HTTP message');
                expect(stackTextIn(res.text)).toBeUndefined();
            });
        });

    test('form-encoded random bytes answer 400 with an empty body',
        testMeta({ id: 'API-PROT-37', row: 'form-encoded binary body', prio: 'P1', needs: 'ca', issue: 'ilm#430', bug: 'core#2502', rule: ['ilm#430 table "SCEP form-encoded binary body: 400 empty on the baseline, 401 empty on the migrated build"; core#2502 for the migrated difference (isMigratedBuild decides the marker)'] }),
        async ({ api, env, own }, testInfo) => {
            test.setTimeout(ISSUE_MS);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on the dedicated RA profile', async () => targets(api, own.spec, env));
            const migrated = await test.step('Build marker: is this the migrated build?', async () => isMigratedBuild(api, testInfo));
            test.fail(migrated, 'core#2502: the migrated build answers 401 instead of 400 for a form-encoded binary body');
            const res = await test.step('POST ?operation=PKIOperation as application/x-www-form-urlencoded with 256 random bytes', async () =>
                protocolPost(`${t.raUrl}?operation=PKIOperation`, { contentType: 'application/x-www-form-urlencoded', body: garbage() }));
            await test.step('400 with an empty body', async () => {
                expect(res.status, res.text.slice(0, 300)).toBe(400);
                expect(res.text.trim()).toBe('');
            });
        });

    test('a POST without the operation parameter answers 400',
        testMeta({ id: 'API-PROT-37', row: 'missing operation', prio: 'P1', needs: 'ca', issue: 'ilm#430', rule: ['SCEP endpoint: `operation` is a required request parameter (ScepRaProfileController); a missing required parameter is 400, never 5xx'] }),
        async ({ api, env, own }) => {
            test.setTimeout(ISSUE_MS);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on the dedicated RA profile', async () => targets(api, own.spec, env));
            const res = await test.step('POST the RA-profile URL without ?operation (application/x-pki-message, random bytes)', async () =>
                protocolPost(t.raUrl, { contentType: 'application/x-pki-message', body: garbage() }));
            await test.step('400, no stack text', async () => {
                expect(res.status, res.text.slice(0, 300)).toBe(400);
                expect(stackTextIn(res.text)).toBeUndefined();
            });
        });

    // Known product bug core#2563: the intended answer is a SCEP failure `badRequest` "Unsupported Operation"
    // (ScepServiceImpl.service `default -> buildResponse(null, buildFailedResponse(…BAD_REQUEST…))`), but
    // `buildResponse(null, …)` dereferences the null request → NPE → 500 (ilm#430 table, both stacks). The rule is asserted as
    // written; `test.fail()` sits right before the step the bug breaks, after the hard assertion that the request is refused.
    test('an unknown operation is a SCEP badRequest failure, never 5xx',
        testMeta({ id: 'API-PROT-37', row: 'unknown operation', prio: 'P1', needs: 'ca', issue: 'ilm#430', bug: 'core#2563', rule: ['a ScepException before the operation is HTTP 400 JSON "SCEP error occurred: <text>, failInfo=<name>" (the code builds an "Unsupported Operation" badRequest failure: ScepServiceImpl.service); known bug core#2563: the platform answers 500 today'] }),
        async ({ api, env, own }) => {
            test.setTimeout(ISSUE_MS);
            const t = await test.step('Prerequisite: an enabled SCEP profile activated on the dedicated RA profile', async () => targets(api, own.spec, env));
            const res = await test.step('POST ?operation=QaNoSuchOperation (application/x-pki-message, fixed bytes)', async () =>
                protocolPost(`${t.raUrl}?operation=QaNoSuchOperation`, { contentType: 'application/x-pki-message', body: garbage() }));
            await test.step('the request is refused, not accepted', async () => {
                expect(res.status, res.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
            });
            test.fail(true, 'core#2563: an unknown SCEP operation dereferences a null request and answers 500 instead of a badRequest failure');
            await test.step('a SCEP badRequest failure (400 JSON "…failInfo=badRequest" or a signed CertRep FAILURE as application/x-pki-message), never 5xx', async () => {
                expect(res.status, res.text.slice(0, 300)).toBeLessThan(500);
                const certRep = /^application\/x-pki-message\b/i.test(res.contentType ?? '');
                if (!certRep) expectScepError(res, 'badRequest');
                else expect(res.status).toBe(200);
            });
        });
});
