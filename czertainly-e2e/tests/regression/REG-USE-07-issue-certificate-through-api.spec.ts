/**
 * REG-USE-07 — a certificate issued through the v2 API (release checklist: Usage 7) on the run RA profile: the issue
 * attributes, the v2 issue of an external CSR, the certificate polled to issued; its detail, history and download match
 * the CSR, including its SANs; a garbage CSR is a 400 {message} and no token is a 401. Every certificate is recorded
 * right after the issue call, before any assertion, and deleted by the run-end teardown.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { ACCEPT_JSON, readProbe } from '../../utils/regression/platform/connectorApi';
import { expectMessageObject } from '../../utils/regression/errorContract';
import { csrWithSan, parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../utils/regression/pkiBuilders';
import { apiJson, createdAfterOf, getCertificate } from '../../utils/regression/apiReads';
import { authorityConnectorName } from '../../utils/regression/config/authorities';
import { recordDerivedKeyOf, recordDerivedKeyOrNamed } from '../../utils/regression/issuedRecords';
import { issueWithCsr, sanOracleFor } from '../../utils/regression/ownCertificates';
import { recordCreated, serverDate } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { ISSUE_MS } from '../../utils/regression/timeouts';
import { isLocalTier } from '../../utils/regression/tier/kind';

const SPEC = 'REG-USE-07';

test.describe('Certificate issue through the API', { tag: tags.regression }, () => {
    test('an external CSR issued through the v2 API reaches issued with the CSR key and its history',
        testMeta({
            id: 'REG-USE-07', prio: 'P1', issue: 'ilm#429',
            rule: ['release checklist Usage 7: issue a certificate with the v2 operations API from an external CSR; detail, history and download match the CSR'],
        }),
        async ({ api, ownRaProfile }) => {
            const ra = ownRaProfile;
            const base = `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}`;
            const cn = `${runName('api')}.example.test`;
            const csr = csrWithSan(cn, [cn]);

            await test.step('GET issue attributes', async () => {
                const attrs = await apiJson<unknown[]>(api, 'GET', `${base}/attributes/issue`);
                expect(Array.isArray(attrs)).toBe(true);
            });

            const { uuid, createdAfter } = await test.step('POST v2 issue → 200, uuid, empty certificateData', async () => {
                const { uuid, body, createdAfter } = await issueWithCsr(api, ra.authorityUuid, ra.uuid, csr.derBase64);
                recordCreated('certificates', { uuid, name: cn }, SPEC, 'issued via API', { raProfile: ra.uuid, authority: ra.authorityUuid });
                // Core links certKey_<CN> at REQUEST time (CertificateServiceImpl.uploadCertificateKey): recorded now, not only after 'issued'.
                await recordDerivedKeyOrNamed(api, uuid, cn, createdAfter, SPEC, 'issued via API');
                expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
                expect(body.certificateData ?? '').toBe('');
                return { uuid, createdAfter };
            });

            await test.step('Poll until issued', async () => {
                await waitForCertificateState(api, uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, uuid, createdAfter, SPEC);
            });

            await test.step('Detail: subject, RA profile and public key match the CSR', async () => {
                const cert = await getCertificate(api, uuid);
                expect(cert.commonName).toBe(cn);
                expect(cert.raProfile?.uuid).toBe(ra.uuid);
                expect(cert.certificateContent, 'certificateContent once issued').toBeTruthy();
                expect(publicKeyPemOf(parseCertificate(cert.certificateContent))).toBe(csr.publicKeyPem);
            });

            await test.step('History has the request and issue events', async () => {
                const history = await apiJson<Array<{ event: string; status: string }>>(api, 'GET', `/api/v1/certificates/${uuid}/history`);
                const events = history.map((h) => h.event).join(' | ');
                expect(events).toMatch(/issue/i);
            });

            await test.step('Download raw PEM', async () => {
                const res = await api.get(`/api/v1/certificates/${uuid}/raw?encoding=pem`);
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
                expect(publicKeyPemOf(parseCertificate(decoded.includes('BEGIN') ? decoded : content))).toBe(csr.publicKeyPem);
            });
        });

    test('the v2 issue answers the exact contract with the SANs, 400 for a garbage CSR and 401 without a token',
        testMeta({
            id: 'REG-USE-07.1', prio: 'P1', issue: 'ilm#429',
            rule: [
                '200 {certificateData:"", uuid, requestAttributeWarnings}; never the signed certificate; lenient: accepted with warnings',
                'an unparseable CSR: 400 "Failed to submit certificate request…"; a 400 body is {message}',
                'history "Issued using RA Profile <name>"; SANs: the CA decides, exact on EJBCA-NG',
                'no credentials → 401',
            ],
        }),
        async ({ api, request, ownRaProfile }, testInfo) => {
            // Issue + poll (180 s) + two short negatives.
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const base = `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${ra.uuid}`;
            const connector = await authorityConnectorName(api, ra.authorityUuid);
            const mode = sanOracleFor(connector);
            testInfo.annotations.push({ type: 'san-oracle', description: mode === 'exact' ? `exact SAN set on ${connector}` : `DNS values only on ${connector}` });
            // A time suffix keeps the name unique under --repeat-each.
            const cn = `${runName(`api-san-${Date.now().toString(36)}`)}.example.test`;
            // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): a documentation address, never a real host.
            const sans = { dns: [cn, `alt.${cn}`], ip: ['192.0.2.11'] };
            const csr = csrWithSan(cn, sans.dns, { ip: sans.ip });

            const issued = await test.step('POST v2 issue → 200 with exactly certificateData "", uuid, requestAttributeWarnings (a list)', async () => {
                const started = Date.now();
                const res = await api.post(`${base}/certificates`, { data: { request: csr.derBase64, format: 'pkcs10', attributes: [], customAttributes: [] } });
                const text = await res.text();
                const body = (() => {
                    try {
                        return JSON.parse(text) as Record<string, unknown>;
                    } catch {
                        return undefined;
                    }
                })();
                // Ledger before assertion: whatever the platform made is this run's.
                const serverAt = serverDate(res.headers());
                const createdAfter = createdAfterOf({ serverAt, startedAt: new Date(started), elapsedMs: Date.now() - started }, 'v2 issue (REG-USE-07.1)');
                if (typeof body?.uuid === 'string') {
                    recordCreated('certificates', { uuid: body.uuid, name: cn }, SPEC, 'issued via API with DNS + IP SANs (REG-USE-07.1)', { raProfile: ra.uuid, authority: ra.authorityUuid });
                    await recordDerivedKeyOrNamed(api, body.uuid, cn, createdAfter, SPEC, 'issued via API (REG-USE-07.1)');
                }
                expect(res.status(), text.slice(0, 300)).toBe(200);
                expect(Object.keys(body ?? {}).sort()).toEqual(['certificateData', 'requestAttributeWarnings', 'uuid']);
                expect(body!.certificateData).toBe('');
                // Warnings are not a violation (a lenient request-attribute policy answers them with 200);
                // a strict violation would be a 422. The list is asserted to be a list and annotated when not empty.
                expect(Array.isArray(body!.requestAttributeWarnings), 'requestAttributeWarnings is a list').toBe(true);
                const warnings = body!.requestAttributeWarnings as unknown[];
                if (warnings.length) testInfo.annotations.push({ type: 'request-attribute-warnings', description: JSON.stringify(warnings).slice(0, 500) });
                expect(body!.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                return { uuid: String(body!.uuid), createdAfter };
            });

            await test.step('Poll until issued (within 180 s)', async () => {
                await waitForCertificateState(api, issued.uuid, 'issued', 180_000);
                await recordDerivedKeyOf(api, issued.uuid, issued.createdAfter, SPEC);
            });

            await test.step('Detail: the certificate carries the CSR\'s SANs and key', async () => {
                const cert = await getCertificate(api, issued.uuid);
                const got = sansOfDetail(cert.subjectAlternativeNames);
                if (mode === 'exact') expect(sameSans(got, sans), `issued SANs ${JSON.stringify(got)} = CSR SANs ${JSON.stringify(sans)}`).toBe(true);
                else for (const d of sans.dns) expect(got.dns.map((x) => x.toLowerCase())).toContain(d.toLowerCase());
                expect(publicKeyPemOf(parseCertificate(cert.certificateContent))).toBe(csr.publicKeyPem);
            });

            await test.step('History: "Issued using RA Profile <RA name>"', async () => {
                const history = await apiJson<Array<{ message?: string }>>(api, 'GET', `/api/v1/certificates/${issued.uuid}/history`);
                expect(history.map((h) => String(h.message ?? '')), 'history messages').toContainEqual(expect.stringContaining(`Issued using RA Profile ${ra.name}`));
            });

            await test.step('Negative: a garbage CSR → 400 and {message} starting "Failed to submit certificate request"', async () => {
                const res = await api.post(`${base}/certificates`, { data: { request: 'bm90LWEtY3Ny', format: 'pkcs10', attributes: [], customAttributes: [] } });
                const text = await res.text();
                const accepted = (() => {
                    try {
                        return (JSON.parse(text) as { uuid?: unknown }).uuid;
                    } catch {
                        return undefined;
                    }
                })();
                // Ledger before assertion: a garbage CSR the platform accepted made a certificate of this run.
                if (typeof accepted === 'string') recordCreated('certificates', { uuid: accepted, name: `${runName('api-garbage')}.example.test` }, SPEC, 'garbage CSR accepted (REG-USE-07.1 negative)');
                expect(res.status(), text.slice(0, 300)).toBe(400);
                expect(expectMessageObject(text)).toMatch(/^Failed to submit certificate request/);
            });

            await test.step('Negative: no credentials → 401 (and no certificate data in the body)', async () => {
                const started = Date.now();
                const anon = await readProbe(await request.get(`/api/v1/certificates/${issued.uuid}`, { headers: ACCEPT_JSON }), Date.now() - started);
                if (isLocalTier()) {
                    // A local stack's dev proxy (AUTH_MODE=header) or the localhost identity may authenticate the call.
                    testInfo.annotations.push({ type: 'local-stack', description: `anonymous certificate read answered ${anon.status} (not asserted on a local stack)` });
                    return;
                }
                expect(anon.status).toBe(401);
                expect(anon.text, 'a 401 body carries no certificate data').not.toContain(cn);
                expect(anon.text).not.toMatch(/certificateContent/);
            });
        });
});
