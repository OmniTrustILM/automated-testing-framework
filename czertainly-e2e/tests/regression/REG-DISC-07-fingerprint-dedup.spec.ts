/**
 * REG-DISC-07 — fingerprint dedup (ilm#432 §9.5 rule 5; T8 I1, I4; B6 rule 40): a certificate already in the inventory is EXISTING
 * and never re-fires triggers; a second run on the same target onboards nothing. v1 runs against the run's own TLS target:
 *   snapshot: the target serves leaf A and leaf B; the test UPLOADS A first (own certificate X), B is new to the inventory
 *   run 1  row A `newlyDiscovered` false with `inventoryUuid` = X; row B NEW; `?newlyDiscovered=true` lists B only, `=false` lists A
 *          only; X gains the history entry "Discovered from Connector: <connector> via discovery: <name>"; the inventory holds
 *          exactly ONE certificate per served fingerprint afterwards (no duplicate of X)
 *   run 2  (new name, same target, an own trigger on Certificate discovered attached): all rows `newlyDiscovered` false, no new
 *          certificate, the trigger never fires (no firing in the run's scope, no row of the trigger on A or B), and the run
 *          ends "Discovery completed successfully"
 * `@needs:scan-target`, `@needs:v1-discovery`; B is a `derived` ledger line (and its key) deleted by uuid; X is an own upload.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnCustomAttribute } from '../../utils/regression/eventsDrivers';
import {
    countCertificates, createOwnDiscovery, findDiscoveryConnectors, generationGate, getCertificateHistory, getDiscovery, listDiscoveredCertificates, recordOnboarded, waitForCompleted,
} from '../../utils/regression/discoveryApi';
import { recordDerivedKeyOf, serverCreatedAfter, uploadOwnCertificate } from '../../utils/regression/regressionApi';
import { scanTargetProblem, startTlsTarget, TlsTarget } from '../../utils/regression/tlsTarget';
import { createOwnChain, EVENT, getFirings, getObjectHistory, setCustomAttribute, getPlatformTriggerGate} from '../../utils/regression/workflowApi';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-DISC-07';
const byFingerprint = (fp: string) => [{ fieldSource: 'property', fieldIdentifier: 'FINGERPRINT', condition: 'EQUALS', value: fp }];

test.describe('@regression REG-DISC-07 fingerprint dedup', () => {
    let target: TlsTarget | undefined;
    test.afterEach(async () => {
        await target?.close();
        target = undefined;
    });

    test('REG-DISC-07: an existing certificate is EXISTING and never re-fires; a second run onboards nothing',
        meta({
            id: 'REG-DISC-07', prio: 'P1', issue: 'ilm#432', needs: ['scan-target', 'v1-discovery'],
            rule: ['T8 B6 rule 40 (staging: fingerprint = SHA-256, existing → newlyDiscovered false, metadata + history updated, never fires CERTIFICATE_DISCOVERED), rule 41 (import of NEW only)', '§9.5 rule 5 (existing certificates are never imported twice or re-fire triggers); T8 I1, I4'],
        }),
        async ({ api }) => {
            test.setTimeout(480_000);
            const platformGate = await getPlatformTriggerGate(api, [EVENT.discovered]);
            test.skip(platformGate !== undefined, platformGate ?? '');
            const problem = scanTargetProblem();
            test.skip(!!problem, problem ?? '');
            const tier = await findDiscoveryConnectors(api);
            const gate = generationGate(tier, 'v1');
            test.skip(gate !== undefined, gate ?? '');
            target = await startTlsTarget({ listeners: 2, withIntermediate: false, stem: 'scan-dedup' });
            const [a, b] = target.served.map((chain) => chain[0]);
            const hosts = { hosts: [target.ipAttribute()], ports: target.ports.map(String), parallel: 1 };

            const x = await uploadOwnCertificate(api, a.pem, a.commonName, SPEC, 'the target\'s leaf A, uploaded before the run (EXISTING)');
            await recordDerivedKeyOf(api, x.uuid, await serverCreatedAfter(api), SPEC);
            expect(await countCertificates(api, byFingerprint(a.fingerprint)), 'A is in the inventory').toBe(1);
            expect(await countCertificates(api, byFingerprint(b.fingerprint)), 'B is new to the inventory').toBe(0);

            const run1 = await createOwnDiscovery(api, SPEC, tier.v1!, { suffix: 'disc07-1', target: hosts });
            await waitForCompleted(api, run1.uuid, 240_000);
            const onboarded = await recordOnboarded(api, SPEC, run1);

            await test.step('Run 1: A is EXISTING (the uploaded X), B is NEW; the filters split them', async () => {
                const rows = await listDiscoveredCertificates(api, run1.uuid);
                const rowA = rows.find((r) => r.fingerprint?.replace(/[:\s]/g, '').toLowerCase() === a.fingerprint)!;
                const rowB = rows.find((r) => r.fingerprint?.replace(/[:\s]/g, '').toLowerCase() === b.fingerprint)!;
                expect(rowA, 'row A').toBeTruthy();
                expect(rowB, 'row B').toBeTruthy();
                expect({ newly: rowA.newlyDiscovered, inventory: rowA.inventoryUuid }, 'A is EXISTING and points at the uploaded certificate').toEqual({ newly: false, inventory: x.uuid });
                expect(rowB.newlyDiscovered, 'B is NEW').toBe(true);
                expect((await listDiscoveredCertificates(api, run1.uuid, true)).map((r) => r.fingerprint?.replace(/[:\s]/g, '').toLowerCase())).toEqual([b.fingerprint]);
                expect((await listDiscoveredCertificates(api, run1.uuid, false)).map((r) => r.fingerprint?.replace(/[:\s]/g, '').toLowerCase())).toEqual([a.fingerprint]);
                expect(onboarded, 'only B is onboarded by the run').toEqual([rowB.inventoryUuid]);
            });

            await test.step('X gains the history entry of this discovery; the inventory holds exactly one certificate per served fingerprint', async () => {
                const history = await getCertificateHistory(api, x.uuid);
                expect(history.some((h) => new RegExp(`Discovered from Connector: .+ via discovery: ${run1.name}`).test(String(h.message ?? '')))).toBe(true);
                expect(await countCertificates(api, byFingerprint(a.fingerprint))).toBe(1);
                expect(await countCertificates(api, byFingerprint(b.fingerprint))).toBe(1);
            });

            await test.step('Run 2 with an own trigger on Certificate discovered: nothing is NEW, nothing fires', async () => {
                const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'disc07-mark', resources: ['certificates'] });
                const chain = await createOwnChain(api, SPEC, { suffix: 'disc07', event: EVENT.discovered, executionItems: [setCustomAttribute(attr.attributeName, 'STRING', 'fired')] });
                const run2 = await createOwnDiscovery(api, SPEC, tier.v1!, { suffix: 'disc07-2', target: hosts, triggers: [chain.trigger] });
                await waitForCompleted(api, run2.uuid, 240_000);
                const rows = await listDiscoveredCertificates(api, run2.uuid);
                expect(rows).toHaveLength(2);
                expect(rows.every((r) => r.newlyDiscovered === false), 'every row of run 2 is EXISTING').toBe(true);
                expect(await countCertificates(api, byFingerprint(a.fingerprint))).toBe(1);
                expect(await countCertificates(api, byFingerprint(b.fingerprint))).toBe(1);
                const detail = await getDiscovery(api, run2.uuid);
                expect(detail.message).toMatch(/^Discovery completed successfully\.?$/);
                const firings = await getFirings(api, { event: EVENT.discovered, scope: { resource: 'discoveries', objectUuid: run2.uuid } });
                expect(firings.page?.totalItems ?? 0, 'the trigger of run 2 never fired').toBe(0);
                for (const r of rows) expect((await getObjectHistory(api, 'certificates', String(r.inventoryUuid))).rows.filter((h) => h.trigger.uuid === chain.trigger.uuid), `no row of the trigger on ${r.commonName}`).toEqual([]);
            });
        });
});
