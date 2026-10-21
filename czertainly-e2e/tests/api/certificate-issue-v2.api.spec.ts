/**
 * Issuing a certificate through the v2 API: the happy path and contract of an external CSR, and the error contract
 * of the lifecycle endpoints (a validation error is a 422 string array, a malformed request a 400 message).
 * Shared-tier safety: one own certificate is recorded before any assertion; negatives target the create path,
 * an own object or a probe uuid, and a request the platform accepts by mistake is recorded too.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { expectMessageObject } from '../../utils/regression/errorContract';
import { historyMessages, historyOf } from '../../utils/regression/lifecycle/certificateHistory';
import { opsBase } from '../../utils/regression/lifecycle/certificateLabels';
import { isSubsequenceOf, observeStatesUntil } from '../../utils/regression/lifecycle/certificateOperations';
import { createdAfterOfAnswer, leaksIn, messageOf, sendRaw } from '../../utils/regression/lifecycle/rawAnswers';
import { sanOracleFor, submitOwnCertificate } from '../../utils/regression/ownCertificates';
import { parseCertificate, publicKeyPemOf, sameSans, sansOfDetail } from '../../utils/regression/pkiBuilders';
import { getCertificate } from '../../utils/regression/apiReads';
import { authorityConnectorName } from '../../utils/regression/config/authorities';
import { recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { recordCreated } from '../../utils/regression/ledger/ledger';
import { runName } from '../../utils/regression/ledger/runState';
import { testMeta, tags } from '../../utils/regression/tags';
import { ISSUE_MS } from '../../utils/regression/timeouts';
import { isLocalTier } from '../../utils/regression/tier/kind';
import { readProbe } from '../../utils/regression/platform/connectorApi';

const SPEC = 'API-CERT-01';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISSUE_WALK = ['requested', 'pending_issue', 'issued'] as const;

/** The raw PEM of `GET /v1/certificates/{uuid}/raw?encoding=pem` (JSON `{content}` or the PEM itself, base64 or armoured). */
const pemOfRaw = (body: string): string => {
    const content = (() => {
        try {
            return (JSON.parse(body) as { content?: string }).content ?? body;
        } catch {
            return body;
        }
    })();
    return content.includes('BEGIN CERTIFICATE') ? content : Buffer.from(content, 'base64').toString('utf8');
};

test.describe('Certificate issue through the v2 API', { tag: tags.api }, () => {
    test('an external CSR is issued with the contract answer, the state walk, and the CSR key and SANs',
        testMeta({
            id: 'API-CERT-01', prio: 'P1', issue: 'ilm#429',
            rule: [
                'issue returns (200 {certificateData:"", uuid, requestAttributeWarnings}; issuance is asynchronous, tracked through the state)',
                'requested → pending_issue → issued on a synchronous CA (history "Issued using RA Profile <name>")',
                'attribute schemas are arrays, [] on MS ADCS NG / EJBCA NG; the SAN content reaches the CA (exact set on EJBCA-NG)',
                'lenient: the whitelist warnings travel in requestAttributeWarnings and are not a refusal',
            ],
        }),
        async ({ api, ownRaProfile }, testInfo) => {
            // Issuance budget (180 s hard wait) plus the reads.
            test.setTimeout(ISSUE_MS);
            const ra = ownRaProfile;
            const base = opsBase(ra);
            const connector = await authorityConnectorName(api, ra.authorityUuid);
            const mode = sanOracleFor(connector);
            testInfo.annotations.push({ type: 'san-oracle', description: mode === 'exact' ? `exact SAN set on ${connector}` : `DNS values only on ${connector} (its template decides the SAN extension)` });

            await test.step('GET …/attributes/issue, /renew, /revoke → 200 arrays', async () => {
                for (const kind of ['issue', 'renew', 'revoke'] as const) {
                    const p = await readProbe(await api.get(`${base}/attributes/${kind}`), 0);
                    expect(p.status, `${kind}: ${p.text.slice(0, 200)}`).toBe(200);
                    expect(Array.isArray(p.json), `${kind} schema is an array`).toBe(true);
                }
            });

            const cert = await test.step('POST …/certificates (CN + 1 DNS + 1 IP SAN, attributes []) → 200 with exactly certificateData "", uuid, requestAttributeWarnings', async () => {
                const c = await submitOwnCertificate(api, ra, SPEC, { suffix: 'c01', note: 'API-CERT-01 issue' });
                expect(c.answer.status, c.answer.text.slice(0, 300)).toBe(200);
                const body = c.answer.json as Record<string, unknown>;
                expect(Object.keys(body).sort()).toEqual(['certificateData', 'requestAttributeWarnings', 'uuid']);
                expect(body.certificateData).toBe('');
                expect(body.uuid).toMatch(UUID_RE);
                expect(Array.isArray(body.requestAttributeWarnings), 'requestAttributeWarnings is a list').toBe(true);
                const warnings = body.requestAttributeWarnings as unknown[];
                if (warnings.length) testInfo.annotations.push({ type: 'request-attribute-warnings', description: JSON.stringify(warnings).slice(0, 500) });
                return c;
            });

            await test.step('The observed states are a subsequence of requested, pending_issue, issued; never failed or rejected', async () => {
                const walk = await observeStatesUntil(api, cert.uuid, 'issued', 180_000);
                testInfo.annotations.push({ type: 'state-walk', description: `${walk.states.join(' → ')} in ${Math.round(walk.elapsedMs / 1000)} s` });
                expect(isSubsequenceOf(walk.states, ISSUE_WALK), `observed ${walk.states.join(' → ')}`).toBe(true);
                expect(walk.states[walk.states.length - 1]).toBe('issued');
                // Expected: issued within 120 s on a synchronous CA (a polling CA may take longer; the 180 s wait is the hard limit).
                if (walk.elapsedMs > 120_000) testInfo.annotations.push({ type: 'slow-issuance', description: `issued after ${Math.round(walk.elapsedMs / 1000)} s (> 120 s: not a synchronous CA?)` });
                await recordDerivedKeyOf(api, cert.uuid, createdAfterOfAnswer(cert.answer), SPEC);
            });

            const detail = await test.step('Detail: CN, the run RA profile, the CSR\'s SAN set, certificateContent and the CSR key', async () => {
                const d = await getCertificate(api, cert.uuid);
                expect(d.commonName).toBe(cert.cn);
                expect(d.raProfile?.uuid).toBe(ra.uuid);
                expect(String(d.certificateContent ?? ''), 'certificateContent once issued (base64 or PEM)').toMatch(/^[A-Za-z0-9+/=\s-]+$/);
                const issued = sansOfDetail(d.subjectAlternativeNames);
                if (mode === 'exact') expect(sameSans(issued, cert.sans), `issued SANs ${JSON.stringify(issued)} = CSR SANs ${JSON.stringify(cert.sans)}`).toBe(true);
                else for (const dns of cert.sans.dns) expect(issued.dns.map((x) => x.toLowerCase())).toContain(dns.toLowerCase());
                expect(publicKeyPemOf(parseCertificate(d.certificateContent)), 'public key = CSR key').toBe(cert.csr.publicKeyPem);
                return d;
            });

            await test.step('History: "Issued using RA Profile <name>"', async () => {
                const messages = historyMessages(await historyOf(api, cert.uuid));
                expect(messages).toContainEqual(expect.stringContaining(`Issued using RA Profile ${ra.name}`));
            });

            await test.step('Raw PEM download carries the same key', async () => {
                const p = await readProbe(await api.get(`/api/v1/certificates/${cert.uuid}/raw?encoding=pem`), 0);
                expect(p.status, p.text.slice(0, 300)).toBe(200);
                expect(publicKeyPemOf(parseCertificate(pemOfRaw(p.text)))).toBe(publicKeyPemOf(parseCertificate(detail.certificateContent)));
            });
        });

    test('lifecycle endpoints answer 400, 404 or 401 with a message, and malformed input never gives a 5xx',
        testMeta({
            id: 'API-CERT-02', prio: 'P1', issue: 'ilm#429',
            rule: [
                'unknown RA profile → 404 "Object of type \'RaProfile\' identified by <uuid> is not found."; neither CSR nor key, or an unparseable CSR → 400 "Failed to submit certificate request…"',
                'ValidationException = 422 string array; CertificateOperationException = 400 {message} (core exception handler); type mismatch → 400 {message}',
                'ilm#424 (the 422 / 400 split must survive the migration); no stack trace, class name or SQL state in an error body; no valid credentials → 401',
            ],
        }),
        async ({ api, ownRaProfile }, testInfo) => {
            test.setTimeout(120_000);
            const ra = ownRaProfile;
            const base = opsBase(ra);
            const create = `${base}/certificates`;
            const clean = (text: string, where: string) => expect(leaksIn(text), `${where}: no stack trace / class / SQL leak`).toEqual([]);
            /** Ledger before assertion: a negative the platform accepted made a certificate of this run. */
            const recordIfCreated = (json: unknown, note: string) => {
                const uuid = (json as { uuid?: unknown } | undefined)?.uuid;
                if (typeof uuid === 'string' && UUID_RE.test(uuid)) recordCreated('certificates', { uuid, name: `${runName('api-neg')}.example.test` }, SPEC, note, { raProfile: ra.uuid, authority: ra.authorityUuid });
            };

            await test.step('Neither CSR nor key → 400 {message} "Failed to submit certificate request: Cannot submit certificate request without specifying key or uploaded request content"', async () => {
                const a = await sendRaw(api, 'POST', create, { format: 'pkcs10', attributes: [], customAttributes: [] });
                recordIfCreated(a.json, 'issue without CSR accepted (API-CERT-02 negative)');
                expect(a.status, a.text.slice(0, 300)).toBe(400);
                expect(messageOf(a)).toMatch(/^Failed to submit certificate request: Cannot submit certificate request without specifying key or uploaded request content/);
                clean(a.text, 'no CSR');
            });

            await test.step('Base64 that is not a CSR → 400 {message} starting "Failed to submit certificate request"', async () => {
                const a = await sendRaw(api, 'POST', create, { request: 'bm90LWEtY3Ny', format: 'pkcs10', attributes: [], customAttributes: [] });
                recordIfCreated(a.json, 'garbage CSR accepted (API-CERT-02 negative)');
                expect(a.status, a.text.slice(0, 300)).toBe(400);
                expect(messageOf(a)).toMatch(/^Failed to submit certificate request/);
                clean(a.text, 'garbage CSR');
            });

            await test.step('Unknown RA profile uuid → 404 {message} "Object of type \'RaProfile\' identified by <uuid> is not found."', async () => {
                const probe = api.probeUuid();
                const a = await sendRaw(api, 'POST', `/api/v2/operations/authorities/${ra.authorityUuid}/raProfiles/${probe}/certificates`, { request: 'bm90LWEtY3Ny', format: 'pkcs10', attributes: [], customAttributes: [] });
                recordIfCreated(a.json, 'issue on a probe RA profile accepted (API-CERT-02 negative)');
                expect(a.status, a.text.slice(0, 300)).toBe(404);
                expect(messageOf(a)).toBe(`Object of type 'RaProfile' identified by ${probe} is not found.`);
                clean(a.text, 'unknown RA profile');
            });

            await test.step('Malformed uuid in a path → 400 {message} (type mismatch)', async () => {
                // A mutation path holds canonical uuids and API words only (guard rule): the malformed-uuid case is read on a GET.
                const p = await readProbe(await api.get('/api/v1/certificates/not-a-uuid'), 0);
                const text = p.text;
                expect(p.status, text.slice(0, 300)).toBe(400);
                expect(expectMessageObject(text)).toMatch(/not-a-uuid|UUID|type/);
                clean(text, 'malformed uuid');
            });

            await test.step('Malformed JSON → 400, never 5xx', async () => {
                const a = await sendRaw(api, 'POST', create, Buffer.from('{"request": "bm90LWEtY3Ny", "format": '));
                recordIfCreated(a.json, 'malformed JSON accepted (API-CERT-02 negative)');
                expect(a.status, a.text.slice(0, 300)).toBe(400);
                clean(a.text, 'malformed JSON');
            });

            await test.step('Wrong content type (text/plain) → the status the OpenAPI declares, else a 4xx (spec gap), never 5xx', async () => {
                const a = await sendRaw(api, 'POST', create, '{"request": "bm90LWEtY3Ny", "format": "pkcs10", "attributes": []}', { headers: { 'Content-Type': 'text/plain' } });
                recordIfCreated(a.json, 'text/plain issue accepted (API-CERT-02 negative)');
                expect(a.status, a.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
                // Robustness only: the operation declares no status for a wrong content type, so the oracle is "a 4xx, never 5xx".
                expect(a.status).toBeLessThan(500);
                // The v2 issue operation declares 200 / 400 / 422 / 500 only: a 415 is undeclared (spec gap, recorded).
                testInfo.annotations.push({ type: 'spec-gap', description: `wrong content type answered ${a.status} (415 is not declared on the issue operation)` });
                clean(a.text, 'text/plain');
            });

            await test.step('`attributes` omitted (the spec marks it required) → the status pinned by this probe, never 5xx', async () => {
                const a = await sendRaw(api, 'POST', create, { request: 'bm90LWEtY3Ny', format: 'pkcs10', customAttributes: [] });
                recordIfCreated(a.json, 'issue without attributes accepted (API-CERT-02 probe)');
                // Robustness only: the status is pinned by the annotation below (no documented contract), the oracle is "never 5xx".
                expect(a.status, a.text.slice(0, 300)).toBeLessThan(500);
                testInfo.annotations.push({ type: 'pinned-status', description: `attributes omitted → ${a.status}` });
                clean(a.text, 'attributes omitted');
            });

            await test.step('No valid credentials → 401 on issue, issue-existing, renew, rekey, revoke, approve and reject', async () => {
                const probe = api.probeUuid();
                const anon = { headers: { authorization: 'Bearer invalid' }, identityOverride: true };
                const calls: Array<[string, 'POST' | 'PATCH', string, unknown]> = [
                    ['issue', 'POST', create, { request: 'bm90LWEtY3Ny', format: 'pkcs10', attributes: [] }],
                    ['issue-existing', 'POST', `${base}/certificates/${probe}/issue`, { attributes: [] }],
                    ['renew', 'POST', `${base}/certificates/${probe}/renew`, { format: 'pkcs10', attributes: [] }],
                    ['rekey', 'POST', `${base}/certificates/${probe}/rekey`, { request: 'bm90LWEtY3Ny', format: 'pkcs10', attributes: [] }],
                    ['revoke', 'POST', `${base}/certificates/${probe}/revoke`, { reason: 'unspecified', attributes: [], destroyKey: false }],
                    ['approve', 'PATCH', `/api/v1/approvals/${probe}/approve`, undefined],
                    ['reject', 'PATCH', `/api/v1/approvals/${probe}/reject`, undefined],
                ];
                // `register` is a path-less create the guard does not list yet (not yet a guarded path): its 401 check is in the registration spec.
                for (const [name, method, url, data] of calls) {
                    const a = await sendRaw(api, method, url, data, anon);
                    if (name === 'issue') recordIfCreated(a.json, 'issue with an invalid bearer accepted (API-CERT-02 negative)');
                    if (isLocalTier()) {
                        // A local stack's dev proxy (AUTH_MODE=header) or the localhost identity may authenticate the call.
                        testInfo.annotations.push({ type: 'local-stack', description: `${name} with an invalid bearer answered ${a.status} (not asserted on a local stack)` });
                        continue;
                    }
                    expect(a.status, `${name}: ${a.text.slice(0, 200)}`).toBe(401);
                    clean(a.text, `${name} 401`);
                }
            });
        });
});
