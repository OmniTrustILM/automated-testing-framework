/**
 * REG-WFL-18 — a PLATFORM-level ignore trigger with a custom-attribute condition on `Certificate uploaded`: the upload that carries
 * the value is rejected (not in the inventory, the upload Event History is Finished with the object ignored, the message carries the
 * certificate's info); the upload without the value is stored and the action trigger still runs (ilm#438 steps 12–13; T14 W24–W27;
 * TW24; ilm#171 sc. 8–12).
 *
 * `@local` (platform-level replace-all; guard 3: the list is read first and restored empty in `finally`). Request attributes are
 * judged BEFORE the certificate is stored, so the rejected upload leaves no object; its answer is NOT a 2xx and names the Certificate
 * Uploaded Event History (T14 W26: today it is an HTTP 500 "Certificate error occurred: Certificate was not uploaded. See Certificate
 * Uploaded Event History for more details."; whether 422 was intended is the open question T14 C2 — the status code is NOT pinned, only
 * "not 2xx" and the text).
 *   rejected upload   no certificate with its fingerprint; a platform firing Finished with Obj. Ignored ≥ 1 whose trigger message
 *                     names the certificate's common name
 *   accepted upload   stored (2xx), the Set field of the action trigger visible on it (own attribute = marker), history rows: ignore
 *                     false / false, action true / true
 * Own objects only (an accepted upload is an own certificate, a rejected one is never stored — a 2xx answer for it is recorded and fails).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnCustomAttribute, customAttributeValue, getCertificateDetail } from '../../utils/regression/eventsDrivers';
import { countCertificates } from '../../utils/regression/discoveryApi';
import { selfSignedPem, sha256FingerprintOfPem } from '../../utils/regression/pki';
import { recordCreated, RUN_ID } from '../../utils/regression/regressionRun';
import { getGuardedApiContext } from '../../utils/regression/guardedApi';
import type { GuardedApi } from '../../utils/regression/guardedApi';
import { describeLocal } from '../../utils/regression/tier';
import {
    conditionItem, createOwnChain, EVENT, getFirings, getObjectHistory, getPlatformAssociations, platformAssociate, pollUntil, sendJson, setCustomAttribute, wfName,
} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-18';

test.describe('@regression REG-WFL-18 platform ignore trigger on uploads', () => {
    describeLocal(test);
    // `@local` rows lift the guard's ownership rule on a proven local stack only (`localStack`, `describeLocal`): the guarded
    // context is built per test here, since a spec may not `test.use` the guard options.
    let api: GuardedApi;
    test.beforeEach(async ({ request, env }) => {
        api = await getGuardedApiContext(request, env, { localStack: true });
    });
    test.afterEach(async () => {
        await api?.dispose();
    });

    test('REG-WFL-18: the upload carrying the rejected value is not stored; the other upload is stored and its action trigger runs',
        meta({
            id: 'REG-WFL-18', prio: 'P1', issue: 'ilm#438', local: true,
            rule: [
                'T14 W24 (ignore stage first: a match → the certificate is not stored; request custom attributes are available to the condition), W26 (the rejected sync upload answers an error naming the Certificate Uploaded Event History), W27 (history: ignored → Finished, objects ignored 1)',
                'core#1441 AC ("rejected certificates are visible in event history with certificate info"); ilm#171 sc. 8–12; T14 TW24',
            ],
        }),
        async () => {
            test.setTimeout(480_000);
            const existing = await getPlatformAssociations(api, EVENT.uploaded);
            test.skip(existing.length > 0, `guard 3: ${existing.length} platform-level trigger(s) already listen on Certificate uploaded; the row stays out of that event`);
            const reject = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf18-reject', resources: ['certificates'] });
            const mark = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf18-mark', resources: ['certificates'] });
            const marker = `kept-${Date.now().toString(36)}`;
            const ignore = await createOwnChain(api, SPEC, {
                suffix: 'wf18-ign', event: EVENT.uploaded, ignore: true, items: [conditionItem('custom', `${reject.attributeName}|STRING`, 'EQUALS', 'reject')],
            });
            const action = await createOwnChain(api, SPEC, { suffix: 'wf18-act', event: EVENT.uploaded, executionItems: [setCustomAttribute(mark.attributeName, 'STRING', marker)] });

            try {
                const assoc = await platformAssociate(api, SPEC, EVENT.uploaded, [ignore.trigger, action.trigger]);
                expect(assoc.status, assoc.text.slice(0, 300)).toBeLessThan(300);

                const upload = async (cn: string, customAttributes: unknown[]) => {
                    const { pem } = selfSignedPem(cn);
                    const sent = await sendJson(api, 'POST', '/api/v1/certificates/upload', { certificate: Buffer.from(pem).toString('base64'), customAttributes });
                    // Ledger before assertion: an accepted upload is an own certificate whatever the test expected.
                    if (sent.status >= 200 && sent.status < 300 && typeof sent.json?.uuid === 'string') recordCreated('certificates', { uuid: sent.json.uuid, name: cn }, SPEC, 'upload (REG-WFL-18)');
                    return { sent, fingerprint: sha256FingerprintOfPem(pem), uuid: sent.json?.uuid as string | undefined };
                };

                const rejectedCn = `${wfName('wf18-rejected')}.example.test`;
                let rejectedFingerprint = '';
                await test.step('The upload that carries the rejected value is refused and names the Event History; nothing is stored', async () => {
                    const rejected = await upload(rejectedCn, [{ uuid: reject.uuid, name: reject.attributeName, contentType: 'string', content: [{ data: 'reject' }] }]);
                    rejectedFingerprint = rejected.fingerprint;
                    expect(rejected.sent.status, `not a 2xx (the status code itself is T14 C2, not pinned): ${rejected.sent.text.slice(0, 300)}`).toBeGreaterThanOrEqual(400);
                    expect(rejected.sent.text, 'the answer names the Certificate Uploaded Event History').toMatch(/Certificate Uploaded Event History/);
                    expect(await countCertificates(api, [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: rejected.fingerprint }]), 'a search by fingerprint finds nothing').toBe(0);
                });

                const namesTheRejected = (f: { objectHistories: { items: unknown[] } }) => {
                    const text = JSON.stringify(f.objectHistories.items).toLowerCase();
                    return text.includes(rejectedCn.toLowerCase()) || text.includes(rejectedFingerprint);
                };
                await test.step('The platform firing for the upload is Finished with an ignored object whose message names the certificate', async () => {
                    const hit = await pollUntil(
                        async () => (await getFirings(api, { event: EVENT.uploaded, pageSize: 25 })).page?.items ?? [],
                        (items) => items.some((f) => f.objectsIgnored >= 1 && namesTheRejected(f)),
                        { what: 'a firing with the rejected certificate ignored' },
                    );
                    const firing = hit.find((f) => f.objectsIgnored >= 1 && namesTheRejected(f))!;
                    expect(firing.status, 'an ignored upload is a Finished firing, not Failed').toBe('finished');
                });

                await test.step('The upload without the value is stored and the action trigger still runs', async () => {
                    const keptCn = `${wfName('wf18-kept')}.example.test`;
                    const kept = await upload(keptCn, []);
                    expect(kept.sent.status, kept.sent.text.slice(0, 300)).toBeLessThan(300);
                    const detail = await pollUntil(() => getCertificateDetail(api, kept.uuid!), (d) => customAttributeValue(d, mark.attributeName) === marker, { what: 'the action trigger effect' });
                    expect(customAttributeValue(detail, mark.attributeName)).toBe(marker);
                    const rows = (await getObjectHistory(api, 'certificates', kept.uuid!)).rows;
                    const ignoreRow = rows.find((r) => r.trigger.uuid === ignore.trigger.uuid);
                    const actionRow = rows.find((r) => r.trigger.uuid === action.trigger.uuid);
                    expect({ matched: ignoreRow?.conditionsMatched, performed: ignoreRow?.actionsPerformed }, 'the ignore trigger did not match').toEqual({ matched: false, performed: false });
                    expect({ matched: actionRow?.conditionsMatched, performed: actionRow?.actionsPerformed }, 'the action trigger ran').toEqual({ matched: true, performed: true });
                    expect(RUN_ID).toBeTruthy();
                });
            } finally {
                await platformAssociate(api, SPEC, EVENT.uploaded, []);
            }
            expect(await getPlatformAssociations(api, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
        });
});
