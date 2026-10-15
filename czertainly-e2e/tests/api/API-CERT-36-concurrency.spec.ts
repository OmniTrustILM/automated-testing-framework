/**
 * API-CERT-36 — two simultaneous operations on one own certificate (ilm#429 step 9; ilm#424 §3 HHH-20744;
 * cert-lifecycle rules §3.2 RR-8, §2.2 API-8, §10 C8; core#2435). `[renew]` (P1): two identical renews → two issued
 * successors, both `renewal`, exactly two, the original issued, no 5xx (renew takes no lock: the ilm#429 closing
 * comment's outcome, asserted absolutely). `[complete]` (P1, the lock proxy on a shared tier) starts with a platform-level
 * register: that route needs the guard's create list (guard request, API-CERT-21) and is declared `test.fixme` with its
 * full body. The rekey / revoke params are P3 (B5).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { csrFromKeyWithSubject, EVENT_CODES, issueExisting, issueOwnCertificate, newChallenge, newKeyPair, registerOwn, relationsOf, renewOwn, sortedHistory } from '../../utils/regression/lifecycle';
import { csrFromKey, sansOfDetail } from '../../utils/regression/pki';
import { apiJson, ensureRaProfileOrSkip, getCertificate, recordDerivedKeyOf } from '../../utils/regression/regressionApi';
import { meta, tags } from '../../utils/regression/tags';
import { waitForCertificateState } from '../../utils/certificateUtils';

const SPEC = 'API-CERT-36';

test.describe('API-CERT-36 concurrency', { tag: tags.api }, () => {
    test('API-CERT-36[renew]: two identical renews at the same moment both answer 200 with two different successors; both are issued as renewals with different serials; exactly two successors; the original stays issued; no 5xx',
        meta({
            id: 'API-CERT-36', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §3.2 RR-8 (no predecessor lock, one successor per call: two parallel renews create two issued successors — ilm#429 closing comment), §10 C8 (assert "no 5xx, two successors, both consistent")',
                'ilm#424 §3 (Hibernate 7.4.8+ lock, HHH-20744: the migration must not turn the parallel path into a 5xx), core#2435 (duplicate delivery is another race; not asserted here)',
            ],
        }),
        async ({ api }) => {
            // One issuance plus two parallel successor issuances (180 s each, awaited together) and the reads.
            test.setTimeout(480_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const a = await test.step('Fixture: an own issued certificate A', async () => issueOwnCertificate(api, ra, SPEC, { suffix: 'c36' }));
            const aDetail = await getCertificate(api, a.uuid);
            const csr = csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));

            const [r1, r2] = await test.step('Two identical POST …/{A}/renew via Promise.all → both 200 with different uuids', async () => {
                const both = await Promise.all([
                    renewOwn(api, a, ra, SPEC, { csrDerBase64: csr.derBase64, note: 'API-CERT-36 parallel renew 1' }),
                    renewOwn(api, a, ra, SPEC, { csrDerBase64: csr.derBase64, note: 'API-CERT-36 parallel renew 2' }),
                ]);
                for (const r of both) {
                    expect(r.status, r.text.slice(0, 300)).toBeLessThan(500);
                    expect(r.status, r.text.slice(0, 300)).toBe(200);
                    expect(r.successor, 'the answer names a successor').toBeTruthy();
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

    test(`API-CERT-36[complete]: two identical completions of one registered certificate never answer 5xx; the second is 200 or a 422 state guard; the result is one issued certificate with one serial and one issue event`,
        meta({
            id: 'API-CERT-36', prio: 'P1', issue: 'ilm#429',
            rule: [
                'cert-lifecycle §2.2 API-8 (the ISSUE action claims the certificate under a pessimistic lock; a second claim commits and returns: one serial, one issue event; HHH-20744 lock), §11 rule 10',
                'cert-lifecycle §6.2 PR-6 (completion = issue-existing with the CSR and the challenge)',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(300_000);
            const ra = await ensureRaProfileOrSkip(api, SPEC, (reason) => test.skip(true, reason));
            const reg = await registerOwn(api, ra, SPEC, { suffix: 'c36c', secret: newChallenge() });
            expect(reg.answer.status, reg.answer.text.slice(0, 300)).toBe(200);
            await waitForCertificateState(api, reg.cert!.uuid, 'registered', 30_000, { failOn: ['failed', 'rejected', 'issued'] });
            const csr = csrFromKey(newKeyPair(), reg.cn);
            const complete = () => issueExisting(api, reg.cert!, ra, { request: csr.derBase64, authorizationSecret: reg.secret });
            const [c1, c2] = await Promise.all([complete(), complete()]);
            for (const c of [c1, c2]) expect(c.status, c.text.slice(0, 300)).toBeLessThan(500);
            const statuses = [c1.status, c2.status].sort();
            expect(statuses[0]).toBe(200);
            expect([200, 422]).toContain(statuses[1]);
            if (statuses[1] === 422) expect([c1, c2].find((c) => c.status === 422)!.text).toMatch(/Cannot issue certificate with state|already has a signing request/);
            await waitForCertificateState(api, reg.cert!.uuid, 'issued', 180_000);
            await recordDerivedKeyOf(api, reg.cert!.uuid, reg.createdAfter, SPEC);
            const detail = await getCertificate(api, reg.cert!.uuid);
            expect(detail.serialNumber, 'one serial').toBeTruthy();
            const history = sortedHistory(await apiJson<Array<Record<string, unknown>>>(api, 'GET', `/api/v1/certificates/${reg.cert!.uuid}/history`));
            expect(history.filter((h) => h.event === EVENT_CODES.ISSUE && h.status === 'SUCCESS' && String(h.message ?? '').startsWith('Issued using RA Profile')), 'exactly one issue event').toHaveLength(1);
        });
});
