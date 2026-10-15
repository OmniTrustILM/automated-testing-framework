/**
 * REG-WFL-15 — Event History paging over MORE THAN ONE PAGE of firings in one own scope: pages are distinct, the page size is
 * respected (not the whole history), the pages add up (ilm#438 steps 19–20, 22; T14 W29–W31; Hibernate 7.4 HHH-20943 / HHH-20911
 * risk: a page size that is ignored returns everything).
 *
 * Driver: 31 challenge-protected pre-registrations on an own RA profile (`Certificate registered`: no CA call on an authority
 * without registration support, T14 0.1 guard 4) and ONE own trigger on that event associated on the RA profile: 31 firings, one
 * object each. The oracle is the number the test created, never a baseline:
 *   for each page size in {1, 10, 31, 32, 50}: every page has at most `pageSize` items, the pages walk `totalItems` = 31 firings
 *   with no repeated firing (identified by its object, one placeholder per firing), the sum of `objectsEvaluated` is 31, firings
 *   come newest first (by start time), no firing is Failed; a page beyond the last is EMPTY and not an error.
 * `objectsPagination` (objects inside a firing) defaults to 10 and is respected. If the run RA profile's authority cannot
 * pre-register, the first register answers a 4xx and the test skips with that text (deploy gate).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnRaProfileOrSkip, registerPlaceholder } from '../../utils/regression/eventsDrivers';
import { associateTriggers, createOwnChain, EVENT, Firing, getFirings, setCustomAttribute, waitForFinishedFirings, getPlatformTriggerGate} from '../../utils/regression/workflowApi';
import { createOwnCustomAttribute } from '../../utils/regression/eventsDrivers';
import { meta } from '../../utils/regression/tags';

const SPEC = 'REG-WFL-15';
const FIRINGS = 31;

test.describe('@regression REG-WFL-15 Event History paging', () => {
    test(`REG-WFL-15: ${FIRINGS} firings page distinctly for page sizes 1, 10, 31, 32 and 50 and add up to the number created`,
        meta({
            id: 'REG-WFL-15', prio: 'P1', issue: 'ilm#438',
            rule: [
                'T14 W29–W31 (firings newest first; `pagination` for firings, `objectsPagination` for objects; counts per firing), TW33',
                'ilm#438 steps 19–20, 22; Hibernate 7.4 HHH-20943 / HHH-20911 (a page size ignored returns the whole history)',
            ],
        }),
        async ({ api }) => {
            test.setTimeout(900_000);
            const platformGate = await getPlatformTriggerGate(api, [EVENT.registered]);
            test.skip(platformGate !== undefined, platformGate ?? '');
            const ra = await createOwnRaProfileOrSkip(api, SPEC, 'wf15-ra', (reason) => test.skip(true, reason));
            const attr = await createOwnCustomAttribute(api, SPEC, { suffix: 'wf15-mark', resources: ['certificates'] });
            const chain = await createOwnChain(api, SPEC, { suffix: 'wf15', event: EVENT.registered, executionItems: [setCustomAttribute(attr.attributeName, 'STRING', 'fired')] });
            const sent = await associateTriggers(api, SPEC, { event: EVENT.registered, resource: 'raProfiles', object: ra, triggers: [chain.trigger] });
            expect(sent.status, sent.text.slice(0, 300)).toBeLessThan(300);
            const scope = { resource: 'raProfiles' as const, objectUuid: ra.uuid };

            await test.step(`Register ${FIRINGS} placeholders (one firing each)`, async () => {
                const first = await registerPlaceholder(api, SPEC, ra, 'wf15-p0');
                test.skip(!first.ref, `deploy gate: the run RA profile's authority cannot pre-register (answer ${first.status}: ${first.text.slice(0, 160)})`);
                for (let i = 1; i < FIRINGS; i++) {
                    const r = await registerPlaceholder(api, SPEC, ra, `wf15-p${i}`);
                    expect(r.ref, `pre-registration ${i}: ${r.status} ${r.text.slice(0, 160)}`).toBeTruthy();
                }
            });

            await test.step(`All ${FIRINGS} firings finished (asynchronous: polled), none Failed`, async () => {
                const page = await waitForFinishedFirings(api, { event: EVENT.registered, scope, pageSize: 50 }, FIRINGS, { timeoutMs: 300_000 });
                expect(page.totalItems).toBe(FIRINGS);
            });

            for (const pageSize of [1, 10, 31, 32, 50]) {
                await test.step(`Page size ${pageSize}: every page ≤ ${pageSize}, distinct firings, Σ items = ${FIRINGS}, newest first, none Failed`, async () => {
                    const pages = Math.ceil(FIRINGS / pageSize);
                    const seen: Firing[] = [];
                    for (let page = 1; page <= pages; page++) {
                        const r = await getFirings(api, { event: EVENT.registered, scope, page, pageSize });
                        expect(r.status, `page ${page} of size ${pageSize}: ${r.text.slice(0, 200)}`).toBe(200);
                        const got = r.page!;
                        expect(got.totalItems, 'the total does not depend on the page size').toBe(FIRINGS);
                        expect(got.items.length, `page ${page} holds at most ${pageSize} firings (a page size that is ignored returns everything)`).toBeLessThanOrEqual(pageSize);
                        if (page < pages) expect(got.items.length, `a full page ${page}`).toBe(pageSize);
                        for (const f of got.items) expect(f.objectHistories.items.length, 'objectsPagination defaults to 10 and is respected').toBeLessThanOrEqual(10);
                        seen.push(...got.items);
                    }
                    const ids = seen.map((f) => String(f.objectHistories.items[0]?.objectUuid ?? `${f.startedAt}`));
                    expect(new Set(ids).size, 'no firing repeats across pages (one placeholder per firing)').toBe(FIRINGS);
                    expect(seen).toHaveLength(FIRINGS);
                    expect(seen.reduce((n, f) => n + f.objectsEvaluated, 0), 'Σ objectsEvaluated = number of placeholders').toBe(FIRINGS);
                    expect(seen.every((f) => f.status === 'finished'), 'no firing Failed or still in progress').toBe(true);
                    const starts = seen.map((f) => Date.parse(f.startedAt));
                    expect(starts, 'newest first').toEqual([...starts].sort((a, b) => b - a));
                    const beyond = await getFirings(api, { event: EVENT.registered, scope, page: pages + 1, pageSize });
                    expect(beyond.status, 'a page beyond the last is not an error').toBe(200);
                    expect(beyond.page?.items, 'a page beyond the last is empty').toEqual([]);
                });
            }
        });
});
