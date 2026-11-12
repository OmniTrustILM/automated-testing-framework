/**
 * API-DISC-01 — A create of a discovery is refused with the exact status and text, and creates nothing. ilm#432.
 *
 * WHAT: 1. A second run with the name of an existing run → 409 "Object of type 'Discovery' identified by <name> already exists."; exactly
 *          the first run carries the name.
 *       2. A create without connectorUuid → 422 "Connector UUID is empty"; an unknown connector → 404; a connectorUuid that is not a UUID →
 *          400 "The request could not be processed." (never 500).
 *       3. A v1 connector with `resources` or `resourceAttributes` → 422 (v1 discovers certificates only and has no per-resource
 *          attributes).
 *       4. A v2 create without `resources`, with an empty list, for a resource the connector does not discover, or with
 *          `resourceAttributes` for a resource the run does not target → 422.
 *       5. v2 attribute content without `"version":"v3"` → 422, not 500; `triggers` naming a trigger of another resource or another event →
 *          422.
 *       Every refused create is followed by a search by its name that finds no run.
 * WHY: DiscoveryServiceImpl.createDiscovery validates the request before it stores anything; the text of each refusal is part of the
 *      contract and the 4xx must not turn into a 5xx.
 * HOW: targets are documentation address ranges only and nothing is started; the one own discovery run the duplicate row needs is the only
 *      object created (recorded in the ledger and completed before the test ends). Both discovery generations are covered
 *      (`@needs:v1-discovery`, `@needs:v2-discovery`): a generation the tier lacks skips its rows with the named deploy gate, and a
 *      skip is never coverage.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { EVENT, EVENT_LABEL } from '../../../utils/regression/events/eventVocabulary';
import { createOwnTrigger } from '../../../utils/regression/events/workflowObjects';
import { errorShapeOf } from '../../../utils/regression/events/workflowRequests';
import { expectRefused } from '../../../utils/regression/errorContract';
import { createOwnDiscovery, DiscoveryConnector, discoveryBody, findDiscoveriesByName, findDiscoveryConnectors, Generation, generationGate, probeDiscovery, runDefinitions, v1Attributes, v2Attributes, waitForCompleted } from '../../../utils/regression/discovery/discoveryApi';
import { DARK_SMALL } from '../../../utils/regression/discovery/tlsTarget';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';
import { ownName } from '../../../utils/regression/ledger/runState';
import { API_VARIANTS_TEST_MS, DISCOVERY_SEED_RUN_WAIT_MS } from '../../../utils/regression/timeouts';

type Api = Parameters<typeof findDiscoveryConnectors>[0];

/** The connector of a generation; the row's declared need has already skipped the test when the tier lacks it. */
async function connectorOf(api: Api, generation: Generation): Promise<DiscoveryConnector> {
    const tier = await findDiscoveryConnectors(api);
    expect(generationGate(tier, generation), `the ${generation} discovery connector the declared need resolved`).toBeUndefined();
    return tier[generation]!;
}

/** The first generation the tier has (rows that read the same for both). */
async function anyConnectorOf(api: Api): Promise<DiscoveryConnector> {
    const tier = await findDiscoveryConnectors(api);
    const connector = tier.v1 ?? tier.v2;
    expect(connector, 'a discovery connector (the declared needs resolved both generations)').toBeTruthy();
    return connector!;
}

async function validAttributes(api: Api, c: DiscoveryConnector) {
    const defs = await runDefinitions(api, c);
    const target = { hosts: [DARK_SMALL], parallel: 10 };
    return c.generation === 'v1' ? v1Attributes(defs, target) : v2Attributes(defs, target);
}

async function expectNoRun(api: Api, name: string): Promise<void> {
    expect(await findDiscoveriesByName(api, name), 'a search by the request name finds no run').toEqual([]);
}

test.describe('Create-time rejections of a discovery', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string, needs: Needs[]) =>
        testMeta({ id: 'API-DISC-01', prio: 'P1', issue: 'ilm#432', needs, rule: [`DiscoveryServiceImpl.createDiscovery rejection row ${row}: ${rule}`] });

    test('a second run with the name of an existing run is refused with 409', rowMeta('a', '409 already exists', ['v1-discovery', 'v2-discovery']), async ({ api, own }) => {
        test.setTimeout(API_VARIANTS_TEST_MS);
        const c = await anyConnectorOf(api);
        const seed = await createOwnDiscovery(api, own.spec, 'disc01-seed', { connector: c, target: { hosts: [DARK_SMALL], parallel: 10 } });
        const sent = await probeDiscovery(api, own.spec, discoveryBody(c, seed.name, await validAttributes(api, c)));
        expectRefused(sent, { status: 409, text: `Object of type 'Discovery' identified by ${seed.name} already exists.`, among: true });
        expect(errorShapeOf(sent), '409 is a {message} body').toBe('message');
        expect((await findDiscoveriesByName(api, seed.name)).map((r) => r.uuid), 'exactly the seed run carries the name').toEqual([seed.uuid]);
        await waitForCompleted(api, seed.uuid, DISCOVERY_SEED_RUN_WAIT_MS);
    });

    test('a create without `connectorUuid` is refused with 422', rowMeta('b', '422 Connector UUID is empty', ['v1-discovery', 'v2-discovery']), async ({ api, own }) => {
        const c = await anyConnectorOf(api);
        const name = ownName('disc01-b');
        const body = discoveryBody(c, name, await validAttributes(api, c));
        delete body.connectorUuid;
        expectRefused(await probeDiscovery(api, own.spec, body), { status: 422, text: 'Connector UUID is empty', among: true });
        await expectNoRun(api, name);
    });

    test('an unknown connector uuid is refused with 404', rowMeta('c', "404 Object of type 'Connector' identified by <uuid> is not found.", ['v1-discovery', 'v2-discovery']), async ({ api, own }) => {
        const c = await anyConnectorOf(api);
        const name = ownName('disc01-c');
        const unknown = api.probeUuid();
        expectRefused(await probeDiscovery(api, own.spec, discoveryBody({ ...c, uuid: unknown }, name, await validAttributes(api, c))), { status: 404, text: `Object of type 'Connector' identified by ${unknown} is not found.`, among: true });
        await expectNoRun(api, name);
    });

    test('a `connectorUuid` that is not a UUID answers 400 and never 500', rowMeta('d', '400 The request could not be processed.', ['v1-discovery', 'v2-discovery']), async ({ api, own }) => {
        const c = await anyConnectorOf(api);
        const name = ownName('disc01-d');
        expectRefused(await probeDiscovery(api, own.spec, discoveryBody({ ...c, uuid: 'not-a-uuid' }, name, await validAttributes(api, c))), { status: 400, text: 'The request could not be processed.', among: true });
        await expectNoRun(api, name);
    });

    test('a v1 connector with `resources` is refused with 422', rowMeta('e', 'v1 implements only certificates', ['v1-discovery']), async ({ api, own }) => {
        const c = await connectorOf(api, 'v1');
        const name = ownName('disc01-e');
        const body = discoveryBody(c, name, await validAttributes(api, c), { body: { resources: ['certificates'] } });
        expectRefused(await probeDiscovery(api, own.spec, body), { status: 422, text: `Connector ${c.uuid} implements only the v1 discovery interface, which discovers certificates only`, among: true });
        await expectNoRun(api, name);
    });

    test('a v1 connector with `resourceAttributes` is refused with 422', rowMeta('f', 'v1 has no per-resource attributes', ['v1-discovery']), async ({ api, own }) => {
        const c = await connectorOf(api, 'v1');
        const name = ownName('disc01-f');
        // An empty map is no attribute; the platform refuses a NON-empty map, so one entry is sent.
        const attributes = await validAttributes(api, c);
        const body = discoveryBody(c, name, attributes, { body: { resourceAttributes: { certificates: attributes } } });
        expectRefused(await probeDiscovery(api, own.spec, body), { status: 422, text: `Connector ${c.uuid} implements only the v1 discovery interface, which has no per-resource attributes`, among: true });
        await expectNoRun(api, name);
    });

    test('a v2 create without `resources` is refused with 422', rowMeta('g', 'resources is required', ['v2-discovery']), async ({ api, own }) => {
        const c = await connectorOf(api, 'v2');
        const name = ownName('disc01-g');
        const body = discoveryBody(c, name, await validAttributes(api, c));
        delete body.resources;
        expectRefused(await probeDiscovery(api, own.spec, body), { status: 422, text: `resources is required for connector ${c.uuid}, which discovers several kinds`, among: true });
        await expectNoRun(api, name);
    });

    test('a v2 create with an empty `resources` list is refused with 422', rowMeta('h', 'resources must name at least one', ['v2-discovery']), async ({ api, own }) => {
        const c = await connectorOf(api, 'v2');
        const name = ownName('disc01-h');
        // A bean-validation message (`@Size` on `DiscoveryDto.resources`): the handler prints "<field> <message>", so the field name leads
        // the DTO's own text.
        expectRefused(await probeDiscovery(api, own.spec, discoveryBody(c, name, await validAttributes(api, c), { resources: [] })), { status: 422, text: /(^|\s)resources must name at least one resource type when supplied$/, among: true });
        await expectNoRun(api, name);
    });

    test('a v2 create for a resource the connector does not discover is refused with 422', rowMeta('i', 'does not discover', ['v2-discovery']), async ({ api, own }) => {
        const c = await connectorOf(api, 'v2');
        const name = ownName('disc01-i');
        const sent = await probeDiscovery(api, own.spec, discoveryBody(c, name, await validAttributes(api, c), { resources: ['secrets'] }));
        expectRefused(sent, { status: 422, text: new RegExp(`^Connector ${c.uuid} does not discover \\[.+\\]$`), among: true });
        await expectNoRun(api, name);
    });

    test('`resourceAttributes` for a resource the run does not target is refused with 422', rowMeta('j', 'resourceAttributes carries attributes for', ['v2-discovery']), async ({ api, own }) => {
        const c = await connectorOf(api, 'v2');
        const name = ownName('disc01-j');
        const body = discoveryBody(c, name, await validAttributes(api, c), { resources: ['certificates'], body: { resourceAttributes: { keys: [] } } });
        expectRefused(await probeDiscovery(api, own.spec, body), { status: 422, text: /^resourceAttributes carries attributes for \[.+\], which this discovery does not target$/, among: true });
        await expectNoRun(api, name);
    });

    test('v2 attribute content without `"version":"v3"` is refused with 422, not 500', rowMeta('k', '422 not 500', ['v2-discovery']), async ({ api, own }) => {
        const c = await connectorOf(api, 'v2');
        const name = ownName('disc01-k');
        const attributes = (await validAttributes(api, c)).map((a) => {
            const { version: _version, ...rest } = a as Record<string, unknown>;
            return rest;
        });
        const sent = await probeDiscovery(api, own.spec, discoveryBody(c, name, attributes));
        expect(sent.status, `refused: ${sent.text.slice(0, 300)}`).toBe(422);
        await expectNoRun(api, name);
    });

    test('`triggers` naming a trigger of another resource or another event are refused with 422', rowMeta('l', 'trigger resource / event mismatch', ['v1-discovery', 'v2-discovery']), async ({ api, own }) => {
        const c = await anyConnectorOf(api);
        const discoveryTrigger = await createOwnTrigger(api, own.spec, 'disc01-l1', { resource: 'discoveries', event: EVENT.discoveryFinished, ignore: true });
        const uploadTrigger = await createOwnTrigger(api, own.spec, 'disc01-l2', { event: EVENT.uploaded, ignore: true });
        const attributes = await validAttributes(api, c);
        for (const [t, text] of [
            [discoveryTrigger, `Trigger '${discoveryTrigger.name}' is for different resource (Discovery) than event '${EVENT_LABEL[EVENT.discovered]}' (Certificate)`],
            [uploadTrigger, `Trigger '${uploadTrigger.name}' is for different event (${EVENT_LABEL[EVENT.uploaded]}) than event '${EVENT_LABEL[EVENT.discovered]}'`],
        ] as const) {
            const name = ownName('disc01-l');
            expectRefused(await probeDiscovery(api, own.spec, discoveryBody(c, name, attributes, { triggers: [t] })), { status: 422, text, among: true });
            await expectNoRun(api, name);
        }
    });
});
