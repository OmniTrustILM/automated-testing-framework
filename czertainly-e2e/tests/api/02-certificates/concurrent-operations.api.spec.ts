/**
 * API-CERT-36 — Two simultaneous operations on one own certificate. ilm#429.
 *
 * WHAT: 1. Two identical renews sent together → both 200 with different uuids; both successors reach issued with different serials, both
 *          relations are renewal, exactly two successors exist and the predecessor stays issued.
 *       2. Two identical completions of a registered certificate sent together → one 200 and the other 200 or the 422 state guard;
 *          the certificate ends issued with one serial and exactly one issue event in its history.
 * WHY: renew takes no predecessor lock, so two renews are two successors (ilm#429 closing comment), while issuing claims the
 *      certificate under a pessimistic lock, so a second claim returns without a second issuance. The migration to a newer Hibernate
 *      must not turn a parallel path into a 5xx (ilm#424). Duplicate delivery is another race (core#2435) and is not asserted.
 * HOW: only own certificates are touched (own RA profile, own keys); the successors and the derived keys are recorded in the ledger
 *      before the assertions. The completion walk is issue-existing with the CSR and the challenge, after a register call without a
 *      path that the guard does not list yet.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { EVENT_CODES, historyOf, relationsOf, sortedHistory } from '../../../utils/regression/lifecycle/certificateHistory';
import { issueExisting, renewOwnCertificate } from '../../../utils/regression/lifecycle/certificateOperations';
import { newChallenge, registerOwnCertificate } from '../../../utils/regression/lifecycle/preRegistration';
import { csrFromKeyWithSubject, newKeyPair, csrFromKey, sansOfDetail } from '../../../utils/regression/pkiBuilders';
import { waitIssued } from '../../../utils/regression/ownCertificates';
import { getCertificate } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LONG_TEST_MS, QUICK_STATE_WAIT_MS, SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';

test.describe('Concurrent certificate operations', { tag: tags.api }, () => {
    test('two simultaneous identical renews give two issued successors and no 5xx',
        testMeta({
            id: 'API-CERT-36', row: 'renew', prio: 'P1', issue: 'ilm#429',
            rule: [
                'no predecessor lock, one successor per call: two parallel renews create two issued successors (ilm#429 closing comment); asserted: no 5xx, two successors, both consistent',
                'ilm#424 (Hibernate 7.4.8+ lock, HHH-20744: the migration must not turn the parallel path into a 5xx), core#2435 (duplicate delivery is another race; not asserted here)',
            ],
        }),
        async ({ api, own, ownRaProfile }) => {
            // One issuance plus two parallel successor issuances (180 s each, awaited together) and the reads.
            test.setTimeout(SLOW_LIFECYCLE_MS);
            const ra = ownRaProfile;
            const a = await test.step('Fixture: an own issued certificate A', async () => own.certificate.issue(ra, { suffix: 'c36' }));
            const aDetail = await getCertificate(api, a.uuid);
            const csr = csrFromKeyWithSubject(a.keys, String(aDetail.subjectDn), sansOfDetail(aDetail.subjectAlternativeNames));

            const [r1, r2] = await test.step('Two identical POST …/{A}/renew via Promise.all → both 200 with different uuids', async () => {
                const both = await Promise.all([
                    renewOwnCertificate(api, a, ra, own.spec, { csrDerBase64: csr.derBase64, note: 'API-CERT-36 parallel renew 1' }),
                    renewOwnCertificate(api, a, ra, own.spec, { csrDerBase64: csr.derBase64, note: 'API-CERT-36 parallel renew 2' }),
                ]);
                for (const r of both) {
                    expect(r.status, r.text.slice(0, 300)).toBe(200);
                    expect(r.successor?.uuid, 'the answer names a successor').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                }
                expect(both[0].successor!.uuid).not.toBe(both[1].successor!.uuid);
                return both;
            });

            await test.step('Both successors reach issued with different serials; both relations are renewal; exactly two successors; A stays issued', async () => {
                await Promise.all([r1, r2].map((r) => waitIssued(api, r.successor!.uuid)));
                for (const r of [r1, r2]) await own.derivedKey(r.successor!.uuid, r.createdAfter);
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
        async ({ api, own, ownRaProfile }) => {
            test.setTimeout(LONG_TEST_MS);
            const ra = ownRaProfile;
            const reg = await test.step('Fixture: a registered certificate with a challenge', async () => {
                const r = await registerOwnCertificate(api, ra, own.spec, { suffix: 'c36c', secret: newChallenge() });
                expect(r.answer.status, r.answer.text.slice(0, 300)).toBe(200);
                await waitForCertificateState(api, r.cert!.uuid, 'registered', QUICK_STATE_WAIT_MS, { failOn: ['failed', 'rejected', 'issued'] });
                return r;
            });
            const csr = csrFromKey(newKeyPair(), reg.cn);
            await test.step('Two identical completions via Promise.all: one 200, the other 200 or the 422 state guard', async () => {
                const complete = () => issueExisting(api, reg.cert!, ra, { request: csr.derBase64, authorizationSecret: reg.secret });
                const [c1, c2] = await Promise.all([complete(), complete()]);
                // Exact oracle: one 200 and the other 200 or the 422 state guard (a 5xx fails here too).
                const statuses = [c1.status, c2.status].sort();
                expect(statuses[0], 'one completion is accepted').toBe(200);
                expect([200, 422], 'the other is accepted or refused by the state guard').toContain(statuses[1]);
                if (statuses[1] === 422) expect([c1, c2].find((c) => c.status === 422)!.text).toMatch(/Cannot issue certificate with state|already has a signing request/);
            });
            await test.step('The certificate ends issued with one serial and exactly one issue event', async () => {
                await waitIssued(api, reg.cert!.uuid);
                await own.derivedKey(reg.cert!.uuid, reg.createdAfter);
                const detail = await getCertificate(api, reg.cert!.uuid);
                expect(String(detail.serialNumber ?? ''), 'one serial (hex)').toMatch(/^[0-9a-f]+$/i);
                const history = sortedHistory(await historyOf(api, reg.cert!.uuid));
                expect(history.filter((h) => h.event === EVENT_CODES.ISSUE && h.status === 'SUCCESS' && String(h.message ?? '').startsWith('Issued using RA Profile')), 'exactly one issue event').toHaveLength(1);
            });
        });
});
