/**
 * REG-WFL-18 — A platform-level ignore trigger on uploads (local stack). ilm#438, ilm#171, core#1441.
 *
 * WHAT: 1. A platform ignore trigger with the condition "custom attribute equals reject" and an action trigger (Set field marker) are
 *          associated on `Certificate uploaded`.
 *       2. The upload that carries the value is refused (not a 2xx; the answer names the Certificate Uploaded Event History), and a search
 *          by fingerprint finds nothing.
 *       3. The platform firing for it is finished with an ignored object whose message names the certificate.
 *       4. The upload without the value is stored, the action trigger runs (marker set), the ignore row is false / false and the action
 *          row true / true.
 * WHY: the ignore stage runs first and a match rejects the certificate; rejected certificates stay visible in the event history with their
 *      certificate info (core#1441), and an ignored upload is a finished firing, not a failed one.
 * HOW: `@local`: the platform association is replace-all, so the list is read first, a stack with a platform-level trigger already
 *      listening is skipped, and the list is restored empty in `finally` (the platform calls go through the `localApi` fixture). The exact
 *      status of the rejected upload is not pinned (any 4xx or 5xx). Request custom attributes are available to the condition. Every
 *      accepted upload is recorded in the ledger before any assertion; own objects only.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { customAttributeValue } from '../../../utils/regression/customAttributes';
import { getCertificateDetail } from '../../../utils/regression/events/workflowFixtures';
import { countCertificates } from '../../../utils/regression/discovery/discoveryApi';
import { selfSignedPem, sha256FingerprintOfPem } from '../../../utils/regression/pkiBuilders';
import { ownCommonName } from '../../../utils/regression/ledger/runState';
import { describeLocalOnly } from '../../../utils/regression/tier/localProof';
import { getPlatformAssociations, platformAssociate } from '../../../utils/regression/events/eventAssociations';
import { getFirings, getObjectHistory } from '../../../utils/regression/events/eventHistory';
import { EVENT } from '../../../utils/regression/events/eventVocabulary';
import { conditionItem, createOwnChain, setCustomAttributeAction } from '../../../utils/regression/events/workflowObjects';
import { sendJson } from '../../../utils/regression/events/workflowRequests';
import { pollUntil } from '../../../utils/regression/wait';
import { testMeta, tags } from '../../../utils/regression/tags';
import { SLOW_LIFECYCLE_MS } from '../../../utils/regression/timeouts';
import { uniqueSuffix } from '../../../utils/regression/text';

test.describe('Platform ignore trigger on uploads', { tag: tags.regression }, () => {
    describeLocalOnly(test);

    test('only the upload without the ignored value is stored and runs its action trigger',
        testMeta({
            id: 'REG-WFL-18', prio: 'P2', issue: 'ilm#438', local: true,
            rule: [
                'ignore stage first: a match → the certificate is not stored; request custom attributes are available to the condition; the rejected sync upload answers an error naming the Certificate Uploaded Event History; history: ignored → Finished, objects ignored 1',
                'core#1441 AC ("rejected certificates are visible in event history with certificate info"); ilm#171 scenarios 8–12',
            ],
        }),
        async ({ api, localApi, own, needs }) => {
            test.setTimeout(SLOW_LIFECYCLE_MS);
            await needs.platformTriggersFree(EVENT.uploaded);
            const reject = await own.customAttribute('wf18-reject', { resources: ['certificates'] });
            const mark = await own.customAttribute('wf18-mark', { resources: ['certificates'] });
            const marker = `kept-${uniqueSuffix()}`;
            const ignore = await createOwnChain(api, own.spec, 'wf18-ign', { event: EVENT.uploaded, ignore: true, items: [conditionItem('custom', `${reject.attributeName}|STRING`, 'EQUALS', 'reject')] });
            const action = await createOwnChain(api, own.spec, 'wf18-act', { event: EVENT.uploaded, executionItems: [setCustomAttributeAction(mark.attributeName, 'STRING', marker)] });

            try {
                const assoc = await platformAssociate(localApi, own.spec, EVENT.uploaded, [ignore.trigger, action.trigger]);
                expect(assoc.status, assoc.text.slice(0, 300)).toBeLessThan(300);

                const upload = async (cn: string, customAttributes: unknown[]) => {
                    const { pem } = selfSignedPem(cn);
                    const sent = await sendJson(localApi, 'POST', '/api/v1/certificates/upload', { certificate: Buffer.from(pem).toString('base64'), customAttributes });
                    // Ledger before assertion: an accepted upload is an own certificate whatever the test expected.
                    own.probe('certificates', sent, { name: cn, note: 'upload (REG-WFL-18)' });
                    return { sent, fingerprint: sha256FingerprintOfPem(pem), uuid: sent.json?.uuid as string | undefined };
                };

                const rejectedCn = ownCommonName('wf18-rej');
                let rejectedFingerprint = '';
                await test.step('The upload that carries the rejected value is refused and names the Event History; nothing is stored', async () => {
                    const rejected = await upload(rejectedCn, [{ uuid: reject.uuid, name: reject.attributeName, contentType: 'string', content: [{ data: 'reject' }] }]);
                    rejectedFingerprint = rejected.fingerprint;
                    expect(rejected.sent.status, `not a 2xx (the status code itself is an open question, not pinned): ${rejected.sent.text.slice(0, 300)}`).toBeGreaterThanOrEqual(400);
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
                    const keptCn = ownCommonName('wf18-ok');
                    const kept = await upload(keptCn, []);
                    expect(kept.sent.status, kept.sent.text.slice(0, 300)).toBeLessThan(300);
                    const detail = await pollUntil(() => getCertificateDetail(api, kept.uuid!), (d) => customAttributeValue(d, mark.attributeName) === marker, { what: 'the action trigger effect' });
                    expect(customAttributeValue(detail, mark.attributeName)).toBe(marker);
                    const rows = (await getObjectHistory(api, 'certificates', kept.uuid!)).rows;
                    const ignoreRow = rows.find((r) => r.trigger.uuid === ignore.trigger.uuid);
                    const actionRow = rows.find((r) => r.trigger.uuid === action.trigger.uuid);
                    expect({ matched: ignoreRow?.conditionsMatched, performed: ignoreRow?.actionsPerformed }, 'the ignore trigger did not match').toEqual({ matched: false, performed: false });
                    expect({ matched: actionRow?.conditionsMatched, performed: actionRow?.actionsPerformed }, 'the action trigger ran').toEqual({ matched: true, performed: true });
                });
            } finally {
                await platformAssociate(localApi, own.spec, EVENT.uploaded, []);
            }
            expect(await getPlatformAssociations(localApi, EVENT.uploaded), 'the platform list is restored (empty)').toEqual([]);
        });
});
