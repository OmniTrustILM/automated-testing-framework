/**
 * API-CERT-36 — Two simultaneous operations on one own certificate (ilm#429). Renew takes no predecessor lock, so two
 * renews are two successors; the CA may refuse the second one for the same end entity.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { EVENT_CODES, historyOf, relationsOf } from '../../../utils/regression/lifecycle/certificateHistory';
import { issueExisting, renewOwnCertificate } from '../../../utils/regression/lifecycle/certificateOperations';
import { newChallenge, registerOwnCertificate } from '../../../utils/regression/lifecycle/preRegistration';
import { csrFromKeyWithSubject, newKeyPair, csrFromKey, sansOfDetail } from '../../../utils/regression/pkiBuilders';
import { waitIssued } from '../../../utils/regression/ownCertificates';
import { getCertificate } from '../../../utils/regression/apiReads';
import { testMeta, tags } from '../../../utils/regression/tags';
import { LONG_TEST_MS, QUICK_STATE_WAIT_MS, SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { waitForCertificateState } from '../../../utils/regression/wait/certificateState';
import { authorityConnectorName } from '../../../utils/regression/config/authorities';
import { DEFAULT_EJBCA_CONNECTOR } from '../../../utils/regression/run/settings';

/** EJBCA's answer when two operations edit one end entity at once: the second transaction is rolled back. */
const EJBCA_END_ENTITY_RACE = /EjbcaException.*Could not commit transaction/;

test.describe('Concurrent certificate operations', { tag: tags.api }, () => {
    test('two simultaneous identical renews give two successors, at least one issued, and no 5xx',
        testMeta({
            id: 'API-CERT-36', row: 'renew', prio: 'P1', issue: 'ilm#429', needs: 'ca',
            rule: [
                'no predecessor lock, one successor per call: two parallel renews create two successors (ilm#429 step 6: "the same outcome as on the baseline"); asserted: no 5xx, two renewal successors, at least one issued, the other issued too',
                'EJBCA-NG only: the second may fail with EJBCA\'s rollback of the shared end entity in its history (the CA\'s answer, not a stuck or lost successor); any other failure fails the test',
                'a failed successor loses its relation and A records the failed renew (core#1120): A lists only the issued successors',
                'ilm#424 (Hibernate 7.4.8+ lock, HHH-20744: the migration must not turn the parallel path into a 5xx), core#2435 (duplicate delivery is another race; not asserted here)',
            ],
        }),
        async ({ api, own, ownRaProfile }, testInfo) => {
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

            await test.step('Both successors settle, at least one issued, a failed one only as EJBCA\'s rollback; two renewal successors; A stays issued', async () => {
                const outcomes = await Promise.all([r1, r2].map(async (r) => {
                    try {
                        await waitIssued(api, r.successor!.uuid);
                        return 'issued';
                    } catch (e) {
                        if (/reached "failed"/.test(String(e))) return 'failed';
                        throw e;
                    }
                }));
                for (const r of [r1, r2]) await own.derivedKey(r.successor!.uuid, r.createdAfter);
                expect(outcomes, 'at least one renew issues its successor').toContain('issued');
                const failedAt = outcomes.indexOf('failed');
                // Core drops a failed successor's relation and records the failed renew on A (core#1120).
                const linked = [r1, r2].filter((_, i) => outcomes[i] === 'issued').map((r) => r.successor!.uuid);
                if (failedAt >= 0) {
                    const connector = await authorityConnectorName(api, ra.authorityUuid);
                    const reasons = (await historyOf(api, [r1, r2][failedAt].successor!.uuid))
                        .filter((h) => h.event === EVENT_CODES.ISSUE && h.status === 'FAILED').map((h) => String(h.message ?? ''));
                    expect(connector === DEFAULT_EJBCA_CONNECTOR && reasons.some((m) => EJBCA_END_ENTITY_RACE.test(m)),
                        `only EJBCA-NG may refuse the second renew, with its end-entity rollback; ${connector}: ${JSON.stringify(reasons).slice(0, 300)}`).toBe(true);
                    const failedRenews = (await historyOf(api, a.uuid)).filter((h) => h.event === EVENT_CODES.RENEW && h.status === 'FAILED');
                    expect(failedRenews, 'A\'s history records the failed renew').toHaveLength(1);
                    testInfo.annotations.push({ type: 'ca-refused-parallel-renew', description: 'partial: EJBCA rolled back the second renew of the shared end entity' });
                } else {
                    const [d1, d2] = await Promise.all([getCertificate(api, r1.successor!.uuid), getCertificate(api, r2.successor!.uuid)]);
                    expect(d1.serialNumber).not.toBe(d2.serialNumber);
                }
                const rel = await relationsOf(api, a.uuid);
                expect(rel.successors.map((s) => s.uuid).sort(), 'A lists its issued successors as renewals').toEqual([...linked].sort());
                expect(rel.successors.map((s) => s.relationType)).toEqual(linked.map(() => 'renewal'));
                expect((await getCertificate(api, a.uuid)).state).toBe('issued');
            });
        });

    test('two simultaneous completions give one issued certificate and no 5xx',
        testMeta({
            id: 'API-CERT-36', row: 'complete', prio: 'P1', issue: 'ilm#429', needs: 'ca',
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
                const history = await historyOf(api, reg.cert!.uuid);
                expect(history.filter((h) => h.event === EVENT_CODES.ISSUE && h.status === 'SUCCESS' && String(h.message ?? '').startsWith('Issued using RA Profile')), 'exactly one issue event').toHaveLength(1);
            });
        });
});
