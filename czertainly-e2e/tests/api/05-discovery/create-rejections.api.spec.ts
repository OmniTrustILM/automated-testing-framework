/**
 * API-DISC-01 — A refused discovery create answers the exact status and text of DiscoveryServiceImpl.createDiscovery and stores no run. ilm#432.
 * Targets are documentation ranges and nothing is started; the duplicate row's seed run is the one object created (ledger, completed).
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { EVENT, EVENT_LABEL } from '../../../utils/regression/events/eventVocabulary';
import { createOwnTrigger } from '../../../utils/regression/events/workflowObjects';
import { errorShapeOf } from '../../../utils/regression/events/workflowRequests';
import { expectRefused } from '../../../utils/regression/errorContract';
import { createOwnDiscovery, DiscoveryConnector, discoveryBody, findDiscoveriesByName, findDiscoveryConnectors, Generation, generationGate, probeDiscovery, runDefinitions, v1Attributes, v2Attributes, waitForCompleted } from '../../../utils/regression/discovery/discoveryApi';
import { DARK_SMALL } from '../../../utils/regression/discovery/tlsTarget';
import { testMeta, tags } from '../../../utils/regression/tags';
import { ownName } from '../../../utils/regression/ledger/runState';
import type { JsonObject } from '../../../utils/regression/json';
import { API_VARIANTS_TEST_MS, DISCOVERY_SEED_RUN_WAIT_MS } from '../../../utils/regression/timeouts';

type Api = Parameters<typeof findDiscoveryConnectors>[0];

/** The connector of a generation; the row's declared need has already skipped the test when the tier lacks it. */
async function connectorOf(api: Api, generation: Generation): Promise<DiscoveryConnector> {
    const tier = await findDiscoveryConnectors(api);
    expect(generationGate(tier, generation), `the ${generation} discovery connector the declared need resolved`).toBeUndefined();
    return tier[generation]!;
}

/** The first generation the tier has, for rows that read the same for both; skips with both gates when it has neither. */
async function anyConnectorOf(api: Api): Promise<DiscoveryConnector> {
    const tier = await findDiscoveryConnectors(api);
    const connector = tier.v1 ?? tier.v2;
    test.skip(!connector, `${generationGate(tier, 'v1')}; ${generationGate(tier, 'v2')}`);
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

interface RefusedRow {
    row: string;
    title: string;
    rule: string;
    /** Unset: the row reads the same for both generations. */
    generation?: Generation;
    body: (c: DiscoveryConnector, name: string, attributes: JsonObject[], api: Api) => JsonObject;
    refused: (c: DiscoveryConnector, body: JsonObject) => { status: number; text: string | RegExp };
}

const without = (body: JsonObject, key: string): JsonObject => {
    const { [key]: _dropped, ...rest } = body;
    return rest;
};

const REFUSED_ROWS: RefusedRow[] = [
    {
        row: 'b', title: 'a create without `connectorUuid` is refused with 422', rule: '422 Connector UUID is empty',
        body: (c, name, attributes) => without(discoveryBody(c, name, attributes), 'connectorUuid'),
        refused: () => ({ status: 422, text: 'Connector UUID is empty' }),
    },
    {
        row: 'c', title: 'an unknown connector uuid is refused with 404', rule: "404 Object of type 'Connector' identified by <uuid> is not found.",
        body: (c, name, attributes, api) => discoveryBody({ ...c, uuid: api.probeUuid() }, name, attributes),
        refused: (_c, body) => ({ status: 404, text: `Object of type 'Connector' identified by ${String(body.connectorUuid)} is not found.` }),
    },
    {
        row: 'd', title: 'a `connectorUuid` that is not a UUID answers 400 and never 500', rule: '400 The request could not be processed.',
        body: (c, name, attributes) => discoveryBody({ ...c, uuid: 'not-a-uuid' }, name, attributes),
        refused: () => ({ status: 400, text: 'The request could not be processed.' }),
    },
    {
        row: 'e', title: 'a v1 connector with `resources` is refused with 422', rule: 'v1 implements only certificates', generation: 'v1',
        body: (c, name, attributes) => discoveryBody(c, name, attributes, { body: { resources: ['certificates'] } }),
        refused: (c) => ({ status: 422, text: `Connector ${c.uuid} implements only the v1 discovery interface, which discovers certificates only` }),
    },
    {
        // an empty map is no attribute: the platform refuses a NON-empty map, so one entry is sent
        row: 'f', title: 'a v1 connector with `resourceAttributes` is refused with 422', rule: 'v1 has no per-resource attributes', generation: 'v1',
        body: (c, name, attributes) => discoveryBody(c, name, attributes, { body: { resourceAttributes: { certificates: attributes } } }),
        refused: (c) => ({ status: 422, text: `Connector ${c.uuid} implements only the v1 discovery interface, which has no per-resource attributes` }),
    },
    {
        row: 'g', title: 'a v2 create without `resources` is refused with 422', rule: 'resources is required', generation: 'v2',
        body: (c, name, attributes) => without(discoveryBody(c, name, attributes), 'resources'),
        refused: (c) => ({ status: 422, text: `resources is required for connector ${c.uuid}, which discovers several kinds` }),
    },
    {
        // a bean-validation message (`@Size` on DiscoveryDto.resources): the handler prints "<field> <message>"
        row: 'h', title: 'a v2 create with an empty `resources` list is refused with 422', rule: 'resources must name at least one', generation: 'v2',
        body: (c, name, attributes) => discoveryBody(c, name, attributes, { resources: [] }),
        refused: () => ({ status: 422, text: /(^|\s)resources must name at least one resource type when supplied$/ }),
    },
    {
        row: 'i', title: 'a v2 create for a resource the connector does not discover is refused with 422', rule: 'does not discover', generation: 'v2',
        body: (c, name, attributes) => discoveryBody(c, name, attributes, { resources: ['secrets'] }),
        refused: (c) => ({ status: 422, text: new RegExp(`^Connector ${c.uuid} does not discover \\[.+\\]$`) }),
    },
    {
        row: 'j', title: '`resourceAttributes` for a resource the run does not target is refused with 422', rule: 'resourceAttributes carries attributes for', generation: 'v2',
        body: (c, name, attributes) => discoveryBody(c, name, attributes, { resources: ['certificates'], body: { resourceAttributes: { keys: [] } } }),
        refused: () => ({ status: 422, text: /^resourceAttributes carries attributes for \[.+\], which this discovery does not target$/ }),
    },
];

test.describe('Create-time rejections of a discovery', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string, generation?: Generation) =>
        testMeta({ id: 'API-DISC-01', prio: 'P1', issue: 'ilm#432', needs: generation ? [`${generation}-discovery`] : [], rule: [`DiscoveryServiceImpl.createDiscovery rejection row ${row}: ${rule}`] });

    test('a second run with the name of an existing run is refused with 409', rowMeta('a', '409 already exists'), async ({ api, own }) => {
        test.setTimeout(API_VARIANTS_TEST_MS);
        const c = await anyConnectorOf(api);
        const seed = await createOwnDiscovery(api, own.spec, 'disc01-seed', { connector: c, target: { hosts: [DARK_SMALL], parallel: 10 } });
        const sent = await probeDiscovery(api, own.spec, discoveryBody(c, seed.name, await validAttributes(api, c)));
        expectRefused(sent, { status: 409, text: `Object of type 'Discovery' identified by ${seed.name} already exists.`, among: true });
        expect(errorShapeOf(sent), '409 is a {message} body').toBe('message');
        expect((await findDiscoveriesByName(api, seed.name)).map((r) => r.uuid), 'exactly the seed run carries the name').toEqual([seed.uuid]);
        await waitForCompleted(api, seed.uuid, DISCOVERY_SEED_RUN_WAIT_MS);
    });

    for (const r of REFUSED_ROWS) {
        test(r.title, rowMeta(r.row, r.rule, r.generation), async ({ api, own }) => {
            const c = r.generation ? await connectorOf(api, r.generation) : await anyConnectorOf(api);
            const name = ownName(`disc01-${r.row}`);
            const body = r.body(c, name, await validAttributes(api, c), api);
            expectRefused(await probeDiscovery(api, own.spec, body), { ...r.refused(c, body), among: true });
            await expectNoRun(api, name);
        });
    }

    test('v2 attribute content without `"version":"v3"` is refused with 422, not 500', rowMeta('k', '422 not 500', 'v2'), async ({ api, own }) => {
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

    test('`triggers` naming a trigger of another resource or another event are refused with 422', rowMeta('l', 'trigger resource / event mismatch'), async ({ api, own }) => {
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
