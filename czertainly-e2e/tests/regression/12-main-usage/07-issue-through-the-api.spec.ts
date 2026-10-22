/**
 * REG-USE-07 — A certificate issued through the v2 API (release checklist: Usage 7). ilm#429.
 *
 * WHAT: 1. GET the issue attributes of the run RA profile; POST the v2 issue of an external CSR → 200 with a uuid and empty
 *          certificateData.
 *       2. Poll until issued; the detail (subject, RA profile, public key), the history (issue events) and the raw PEM download match the
 *          CSR.
 *       3. (REG-USE-07.1) A CSR with DNS and IP SANs → 200 with exactly certificateData "", uuid and requestAttributeWarnings (a list);
 *          issued with the CSR's SANs and key; the history says "Issued using RA Profile <name>".
 *       4. (REG-USE-07.1) A garbage CSR → 400 with a {message} starting "Failed to submit certificate request" (a test of its own).
 *       5. A read without credentials → 401 and no certificate data (a test of its own, not on a local stack).
 * WHY: the v2 operations API is what automation uses; the answer must never carry the signed certificate, a lenient request-attribute
 *      policy answers warnings with 200, and an unauthenticated read must leak nothing.
 * HOW: the RA profile is the run's own. Every certificate is recorded in the ledger right after the issue call, before any assertion, with
 *      the key core links at request time, and is deleted by the run-end teardown; a garbage CSR the platform accepted is recorded too.
 *      The SAN oracle is CA-aware (exact on EJBCA-NG, DNS values elsewhere); the IP SAN is a documentation address (RFC 5737). The 401 read
 *      asks for the run's own certificate, so a body that leaked its name or content would be caught; it is not asserted on a local stack.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { ACCEPT_JSON } from '../../../utils/regression/platform/connectorApi';
import { expectRefused } from '../../../utils/regression/errorContract';
import { csrWithSan, parseCertificate, publicKeyPemOf } from '../../../utils/regression/pkiBuilders';
import { apiJson, createdAfterOf, getCertificate, answerOf } from '../../../utils/regression/apiReads';
import { authorityConnectorName } from '../../../utils/regression/config/authorities';
import { recordDerivedKeyOrNamed } from '../../../utils/regression/issuedRecords';
import { historyMessages, historyOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { sendRaw } from '../../../utils/regression/lifecycle/rawAnswers';
import { sanOracle, submitOwnCertificate, waitIssued } from '../../../utils/regression/ownCertificates';
import { ownCommonName, runCommonName } from '../../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ISSUE_MS } from '../../../utils/regression/timeouts';
import { isLocalTier } from '../../../utils/regression/tier/kind';

test.describe('Certificate issue through the API', { tag: tags.regression }, () => {
    test('an external CSR issued through the v2 API reaches issued with the CSR key and its history',
        testMeta({
            id: 'REG-USE-07', prio: 'P1', issue: 'ilm#429',
            rule: ['release checklist Usage 7: issue a certificate with the v2 operations API from an external CSR; detail, history and download match the CSR'],
        }),
        async ({ api, own, ownRaProfile }) => {
            const ra = ownRaProfile;
            const base = `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}`;

            await test.step('GET issue attributes', async () => {
                const attrs = await apiJson<unknown[]>(api, 'GET', `${base}/attributes/issue`);
                expect(Array.isArray(attrs)).toBe(true);
            });

            // The CSR carries the run-prefixed common name as its one DNS name and no IP address.
            const cert = await test.step('POST v2 issue → 200, uuid, empty certificateData', async () => {
                const issued = await submitOwnCertificate(api, ra, own.spec, { suffix: 'api', sans: { ip: [] }, fillRequiredAttributes: true, note: 'issued via API' });
                // Core links certKey_<CN> at REQUEST time (CertificateServiceImpl.uploadCertificateKey): recorded now, not only after
                // 'issued'.
                await recordDerivedKeyOrNamed(api, issued.uuid, issued.cn, issued.createdAfter, own.spec, 'issued via API');
                expect(issued.answer.status, issued.answer.text.slice(0, 300)).toBe(200);
                expect(issued.uuid).toMatch(/^[0-9a-f-]{36}$/);
                expect(issued.answer.json?.certificateData ?? '').toBe('');
                return issued;
            });

            await test.step('Poll until issued', async () => {
                await waitIssued(api, cert.uuid);
                await own.derivedKey(cert.uuid, cert.createdAfter);
            });

            await test.step('Detail: subject, RA profile and public key match the CSR', async () => {
                const detail = await getCertificate(api, cert.uuid);
                expect(detail, 'the issued certificate carries the requested name and the run RA profile').toMatchObject({ commonName: cert.cn, raProfile: { uuid: ra.uuid } });
                expect(detail.certificateContent, 'certificateContent once issued').toBeTruthy();
                expect(publicKeyPemOf(parseCertificate(detail.certificateContent))).toBe(cert.csr.publicKeyPem);
            });

            await test.step('History has the request and issue events', async () => {
                const events = (await historyOf(api, cert.uuid)).map((h) => String(h.event)).join(' | ');
                expect(events).toMatch(/issue/i);
            });

            await test.step('Download raw PEM', async () => {
                const res = await api.get(`/api/v1/certificates/${cert.uuid}/raw?encoding=pem`);
                expect(res.status()).toBe(200);
                const body = await res.text();
                const content = (() => {
                    try {
                        return JSON.parse(body).content as string;
                    } catch {
                        return body;
                    }
                })();
                const decoded = content.includes('BEGIN CERTIFICATE') ? content : Buffer.from(content, 'base64').toString('utf8');
                expect(publicKeyPemOf(parseCertificate(decoded.includes('BEGIN') ? decoded : content))).toBe(cert.csr.publicKeyPem);
            });
        });

    test('the v2 issue answers the exact contract and issues the certificate with the CSR SANs',
        testMeta({
            id: 'REG-USE-07.1', prio: 'P1', issue: 'ilm#429',
            rule: [
                '200 {certificateData:"", uuid, requestAttributeWarnings}; never the signed certificate; lenient: accepted with warnings',
                'history "Issued using RA Profile <name>"; SANs: the CA decides, exact on EJBCA-NG',
            ],
        }),
        async ({ api, own, ownRaProfile }, testInfo) => {
            // Issue + poll (180 s) + the reads.
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const base = `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}`;
            const san = sanOracle(await authorityConnectorName(api, ra.authorityUuid));
            testInfo.annotations.push({ type: 'san-oracle', description: san.describe() });
            // A time suffix keeps the name unique under --repeat-each.
            const cn = ownCommonName('api-san');
            // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): a documentation address, never a real host.
            const sans = { dns: [cn, `alt.${cn}`], ip: ['192.0.2.11'] };
            const csr = csrWithSan(cn, sans.dns, { ip: sans.ip });

            const issued = await test.step('POST v2 issue → 200 with exactly certificateData "", uuid, requestAttributeWarnings (a list)', async () => {
                const answer = await sendRaw(api, 'POST', `${base}/certificates`, { request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [] });
                const body = answer.json as Record<string, unknown> | undefined;
                const createdAfter = createdAfterOf(answer, 'v2 issue (REG-USE-07.1)');
                // Ledger before assertion: whatever the platform made is this run's.
                if (typeof body?.uuid === 'string') {
                    own.record('certificates', { status: answer.status, uuid: body.uuid, text: answer.text }, { name: cn, note: 'issued via API with DNS + IP SANs (REG-USE-07.1)', parents: { raProfile: ra.uuid, authority: ra.authorityUuid } });
                    await recordDerivedKeyOrNamed(api, body.uuid, cn, createdAfter, own.spec, 'issued via API (REG-USE-07.1)');
                }
                expect(answer.status, answer.text.slice(0, 300)).toBe(200);
                expect(Object.keys(body ?? {}).sort()).toEqual(['certificateData', 'requestAttributeWarnings', 'uuid']);
                expect(body, 'the answer never carries the signed certificate').toMatchObject({ certificateData: '' });
                // Warnings are not a violation (a lenient request-attribute policy answers them with 200);
                // a strict violation would be a 422. The list is asserted to be a list and annotated when not empty.
                expect(Array.isArray(body!.requestAttributeWarnings), 'requestAttributeWarnings is a list').toBe(true);
                const warnings = body!.requestAttributeWarnings as unknown[];
                if (warnings.length) testInfo.annotations.push({ type: 'request-attribute-warnings', description: JSON.stringify(warnings).slice(0, 500) });
                expect(body!.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                return { uuid: String(body!.uuid), createdAfter };
            });

            await test.step('Poll until issued (within 180 s)', async () => {
                await waitIssued(api, issued.uuid);
                await own.derivedKey(issued.uuid, issued.createdAfter);
            });

            await test.step('Detail: the certificate carries the CSR\'s SANs and key', async () => {
                const cert = await getCertificate(api, issued.uuid);
                san.expectIssued(cert, sans);
                expect(publicKeyPemOf(parseCertificate(cert.certificateContent))).toBe(csr.publicKeyPem);
            });

            await test.step('History: "Issued using RA Profile <RA name>"', async () => {
                expect(historyMessages(await historyOf(api, issued.uuid)), 'history messages').toContainEqual(expect.stringContaining(`Issued using RA Profile ${ra.name}`));
            });
        });

    test('a garbage CSR is refused with 400 and a message that says the request could not be submitted',
        testMeta({
            id: 'REG-USE-07.1', row: 'garbage-csr-refused', prio: 'P1', issue: 'ilm#429',
            rule: ['an unparseable CSR: 400 "Failed to submit certificate request…"; a 400 body is {message}'],
        }),
        async ({ api, own, ownRaProfile }) => {
            const ra = ownRaProfile;
            const base = `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}`;
            const answer = await sendRaw(api, 'POST', `${base}/certificates`, { request: 'bm90LWEtY3Ny', format: 'pkcs10', attributes: [], customAttributes: [] });
            // Ledger before assertion: a garbage CSR the platform accepted made a certificate of this run.
            const accepted = (answer.json as { uuid?: unknown } | undefined)?.uuid;
            if (typeof accepted === 'string') {
                own.record('certificates', { status: answer.status, uuid: accepted, text: answer.text }, { name: runCommonName('api-garbage'), note: 'garbage CSR accepted (REG-USE-07.1 negative)' });
            }
            expectRefused(answer, { status: 400, text: 'Failed to submit certificate request', prefix: true });
        });

    test('a read of an own certificate without credentials is refused with 401 and no certificate data',
        testMeta({
            id: 'REG-USE-07.1', row: 'no-credentials', prio: 'P1', issue: 'ilm#429',
            rule: ['no credentials → 401 and a body that carries neither the common name nor the certificate content; not asserted on a local stack, where the dev proxy (AUTH_MODE=header) or the localhost identity may authenticate the call'],
        }),
        async ({ api, request, own, ownRaProfile }) => {
            // No `needs` value describes this environment condition, so it stays a skip with its reason.
            test.skip(isLocalTier(), 'local stack: the dev proxy (AUTH_MODE=header) or the localhost identity may authenticate an anonymous call, so the 401 is not asserted there');
            test.setTimeout(ISSUE_MS);
            // The run's own issued certificate: a real object whose common name and content could leak into a refusal.
            const cert = await test.step('Fixture: an own certificate issued through the v2 API', async () =>
                own.certificate.issue(ownRaProfile, { suffix: 'c07anon', note: 'issued via API (anonymous read probe, REG-USE-07.1)' }));
            const detail = await getCertificate(api, cert.uuid);
            // The content must exist, or the "no certificate content" check below would compare against "undefined".
            expect(typeof detail.certificateContent, 'the own certificate has content to compare against').toBe('string');
            const started = Date.now();
            const anon = await answerOf(await request.get(`/api/v1/certificates/${cert.uuid}`, { headers: ACCEPT_JSON }), started);
            expect(anon.status).toBe(401);
            expect(anon.text, 'a 401 body carries no common name').not.toContain(cert.cn);
            expect(anon.text, 'a 401 body carries no certificate content').not.toContain(String(detail.certificateContent));
            expect(anon.text, 'a 401 body names no certificate field').not.toMatch(/certificateContent|commonName/);
        });
});
