/**
 * Two simultaneous operations on one own certificate: two identical renews give two issued successors with no 5xx
 * (renew takes no lock), and two identical completions of a registered certificate give one issued certificate.
 * Shared-tier safety: only own certificates are touched; the completion walk needs a path-less register call that
 * the guard does not list yet.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { EVENT_CODES, relationsOf, sortedHistory } from '../../utils/regression/lifecycle/certificateHistory';
import { issueExisting, renewOwnCertificate } from '../../utils/regression/lifecycle/certificateOperations';
import { newChallenge, registerOwnCertificate } from '../../utils/regression/lifecycle/preRegistration';
import { csrFromKeyWithSubject, newKeyPair, csrFromKey, sansOfDetail } from '../../utils/regression/pkiBuilders';
import { issueOwnCertificate } from '../../utils/regression/ownCertificates';
import { apiJson, getCertificate } from '../../utils/regression/apiReads';
import { recordDerivedKeyOf } from '../../utils/regression/issuedRecords';
import { testMeta, tags } from '../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../utils/regression/timeouts';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-36';

test.describe('Concurrent certificate operations', { tag: tags.api }, () => {
    test('two simultaneous identical renews give two issued successors and no 5xx',
        testMeta({
            id: 'API-CERT-36', row: 'renew', prio: 'P1', issue: 'ilm#429',
            rule: [
                'no predecessor lock, one successor per call: two parallel renews create two issued successors (ilm#429 closing comment); assert "no 5xx, two successors, both consistent"',
                'ilm#424 (Hibernate 7.4.8+ lock, HHH-20744: the migration must not turn the parallel path into a 5xx), core#2435 (duplicate delivery is another race; not asserted here)',
            ],
        }),
        async ({ api, ownRaProfile }) => {
            // One issuance plus two parallel successor issuances (180 s each, awaited together) and the reads.
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const ra = ownRaProfile;
            const a = await test.step('Fixture: an own issued certificate A', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'c36' }));
            const aDetail = await getCertificate(api, a.uuid);
            const csr = csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));

            const [r1, r2] = await test.step('Two identical POST …/{A}/renew via Promise.all → both 200 with different uuids', async () => {
                const both = await Promise.all([
                    renewOwnCertificate(api, a, ra, SPEC, { csrDerBase64: csr.derBase64, note: 'API-CERT-36 parallel renew 1' }),
                    renewOwnCertificate(api, a, ra, SPEC, { csrDerBase64: csr.derBase64, note: 'API-CERT-36 parallel renew 2' }),
                ]);
                for (const r of both) {
                    expect(r.status, r.text.slice(0, 300)).toBe(200);
                    expect(r.successor?.uuid, 'the answer names a successor').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                }
                expect(both[0].successor!.uuid).not.toBe(both[1].successor!.uuid);
                return both;
            });

            await test.step('Both successors reach issued with different serials; both relations are renewal; exactly two successors; A stays issued', async () => {
                await Promise.all([r1, r2].map((r) => waitForCertificateState(api, r.successor!.uuid, 'issued', 180_000)));
                for (const r of [r1, r2]) await recordDerivedKeyOf(api, r.successor!.uuid, r.createdAfter, SPEC);
                const [d1, d2] = await Promise.all([getCertificate(api, r1.successor!.uuid), getCertificate(api, r2.successor!.uuid)]);
                expect(d1.serialNumber).not.toBe(d2.serialNumber);
                const rel = await relationsOf(api, a.uuid);
                expect(rel.successors.map((s) => s.uuid).sort()).toEqual([r1.successor!.uuid, r2.successor!.uuid].sort());
                expect(rel.successors.map((s) => s.relationType)).toEqual(['renewal', 'renewal']);
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
            });
        });

    test('two simultaneous completions give one issued certificate and no 5xx',
        testMeta({
            id: 'API-CERT-36', row: 'complete', prio: 'P1', issue: 'ilm#429',
            rule: [
                'the ISSUE action claims the certificate under a pessimistic lock; a second claim commits and returns: one serial, one issue event (HHH-20744 lock)',
                'completion = issue-existing with the CSR and the challenge',
            ],
        }),
        async ({ api, ownRaProfile }) => {
            test.setTimeout(300_000);
            const ra = ownRaProfile;
            const reg = await registerOwnCertificate(api, ra, SPEC, { suffix: 'c36c', secret: newChallenge() });
            expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, reg.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
            const csr = csrFromKey(newKeyPair(), reg.cn);
            const complete = () => issueExisting(api, reg.cert!, ra, { request: csr.derBase64, authorizationSecret: reg.secret });
            const [c1, c2] = await Promise.all([complete(), complete()]);
            // Exact oracle: one 200 and the other 200 or the 422 state guard (a 5xx fails here too).
            const statuses = [c1.status, c2.status].sort();
            expect(statuses[0]).toBe(200);
            expect([200, 422]).toContain(statuses[1]);
            if (statuses[1] === 422) expect([c1, c2].find((c) => c.status === 422)!.text).toMatch(/Cannot issue certificate with state|already has a signing request/);
            await waitForCertificateState(api, reg.cert!.uuid, 'issued', 180_000);
            await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, SPEC);
            const detail = await getCertificate(api, reg.cert!.uuid);
            expect(String(detail.serialNumber ?? ''), 'one serial (hex)').toMatch(/^[0-9a-f]+$/i);
            const history = sortedHistory(await apiJson<Array<Record<string, unknown>>>(api, 'GET', `/api/v1/certificates/${reg.cert!.uuid}/history`));
            expect(history.filter((h) => h.event === EVENT_CODES.ISSUE && h.status === 'SUCCESS' && String(h.message ?? '').startsWith('Issued using RA Profile')), 'exactly one issue event').toHaveLength(1);
        });
});
