/**
 * API-DISC-01 — the create-time rejection matrix of a discovery (ilm#432 steps 1–2, 8; T8 rules 6–15, B2 rules 6–15): every row
 * is refused with the exact status and text of `DiscoveryServiceImpl.createDiscovery` / `validateRequestedResources` and creates
 * NOTHING (a search by the request name finds no run), except the one own seed run the duplicate-name row needs.
 *
 *   a  duplicate name (the own seed run)              409 "Object of type 'Discovery' identified by <name> already exists."
 *   b  `connectorUuid` omitted                        422 "Connector UUID is empty"
 *   c  unknown connector uuid                         404 "Object of type 'Connector' identified by <uuid> is not found."
 *   d  `connectorUuid` not a UUID                     400 "The request could not be processed." (never 500)
 *   e  v1 connector with `resources`                  422 "Connector <uuid> implements only the v1 discovery interface, which discovers certificates only"
 *   f  v1 connector with `resourceAttributes`         422 "Connector <uuid> implements only the v1 discovery interface, which has no per-resource attributes"
 *   g  v2, `resources` omitted                        422 "resources is required for connector <uuid>, which discovers several kinds"
 *   h  v2, `resources: []`                            422 "resources must name at least one resource type when supplied"
 *   i  v2, a resource the connector does not discover 422 "Connector <uuid> does not discover [<labels>]"
 *   j  v2, `resourceAttributes` for an untargeted resource  422 "resourceAttributes carries attributes for [<labels>], which this discovery does not target"
 *   k  v2 attribute content without `"version":"v3"`  422 (never 500; core#2429 item 2)
 *   l  `triggers` naming a Discovery-resource trigger / a trigger of another event   422 "Trigger '<n>' is for different resource|event …"
 * Targets: RFC 5737 documentation ranges only; both generations (`@needs:v1-discovery`, `@needs:v2-discovery`): a missing
 * generation skips its rows with the named deploy gate. Rows c and d are the same for both generations and run on the one
 * that exists.
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnTrigger, errorShapeOf, errorTexts, EVENT, EVENT_LABEL, Sent } from '../../utils/regression/workflowApi';
import {
    createOwnDiscovery, DiscoveryConnector, discoveryBody, findDiscoveriesByName, findDiscoveryConnectors, Generation, generationGate, probeCreateDiscovery, runDefinitions,
    v1Attributes, v2Attributes, waitForCompleted,
} from '../../utils/regression/discoveryApi';
import { DARK_SMALL } from '../../utils/regression/tlsTarget';
import { wfName } from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-DISC-01';
type Api = Parameters<typeof findDiscoveryConnectors>[0];

/** The connector of a generation, or a skip with the named deploy gate (a skip is never coverage). */
async function connectorOrSkip(api: Api, g: Generation): Promise<DiscoveryConnector> {
    const tier = await findDiscoveryConnectors(api);
    const gate = generationGate(tier, g);
    test.skip(gate !== undefined, gate ?? '');
    return tier[g]!;
}

/** The first generation the tier has (rows that read the same for both). */
async function anyConnectorOrSkip(api: Api): Promise<DiscoveryConnector> {
    const tier = await findDiscoveryConnectors(api);
    const c = tier.v1 ?? tier.v2;
    test.skip(!c, `deploy gate: ${tier.problems.v1}; ${tier.problems.v2} (@needs:v1-discovery @needs:v2-discovery)`);
    return c!;
}

async function validAttributes(api: Api, c: DiscoveryConnector) {
    const defs = await runDefinitions(api, c);
    const target = { hosts: [DARK_SMALL], parallel: 10 };
    return c.generation === 'v1' ? v1Attributes(defs, target) : v2Attributes(defs, target);
}

function expectRefused(sent: Sent, status: number, text: string | RegExp): void {
    expect(sent.status, `answered ${status}: ${sent.text.slice(0, 300)}`).toBe(status);
    const texts = errorTexts(sent);
    if (typeof text === 'string') expect(texts).toContain(text);
    else expect(texts.some((t) => text.test(t)), `a message matches ${String(text)} among ${JSON.stringify(texts)}`).toBe(true);
    expect(sent.status, 'never a server error').toBeLessThan(500);
}

async function expectNoRun(api: Api, name: string): Promise<void> {
    expect(await findDiscoveriesByName(api, name), 'a search by the request name finds no run').toEqual([]);
}

test.describe('API-DISC-01 discovery create-time rejections', { tag: tags.api }, () => {
    const m = (row: string, rule: string, needs: string[]) =>
        meta({ id: 'API-DISC-01', prio: 'P1', issue: 'ilm#432', needs, rule: [`T8 B2 rules 6–15 (DiscoveryServiceImpl.createDiscovery): P-D1 row ${row}: ${rule}`] });

    test('API-DISC-01[a]: a second run with the name of an existing run is refused with 409', m('a', '409 already exists', ['v1-discovery', 'v2-discovery']), async ({ api }) => {
        test.setTimeout(180_000);
        const c = await anyConnectorOrSkip(api);
        const seed = await createOwnDiscovery(api, SPEC, c, { suffix: 'disc01-seed', target: { hosts: [DARK_SMALL], parallel: 10 } });
        const sent = await probeCreateDiscovery(api, discoveryBody(c, seed.name, await validAttributes(api, c)), SPEC);
        expectRefused(sent, 409, `Object of type 'Discovery' identified by ${seed.name} already exists.`);
        expect(errorShapeOf(sent), '409 is a {message} body').toBe('message');
        expect((await findDiscoveriesByName(api, seed.name)).map((r) => r.uuid), 'exactly the seed run carries the name').toEqual([seed.uuid]);
        await waitForCompleted(api, seed.uuid, 150_000);
    });

    test('API-DISC-01[b]: a create without `connectorUuid` is refused with 422', m('b', '422 Connector UUID is empty', ['v1-discovery', 'v2-discovery']), async ({ api }) => {
        const c = await anyConnectorOrSkip(api);
        const name = wfName('disc01-b');
        const body = discoveryBody(c, name, await validAttributes(api, c));
        delete body.connectorUuid;
        expectRefused(await probeCreateDiscovery(api, body, SPEC), 422, 'Connector UUID is empty');
        await expectNoRun(api, name);
    });

    test('API-DISC-01[c]: an unknown connector uuid is refused with 404', m('c', "404 Object of type 'Connector' identified by <uuid> is not found.", ['v1-discovery', 'v2-discovery']), async ({ api }) => {
        const c = await anyConnectorOrSkip(api);
        const name = wfName('disc01-c');
        const unknown = api.probeUuid();
        expectRefused(await probeCreateDiscovery(api, discoveryBody({ ...c, uuid: unknown }, name, await validAttributes(api, c)), SPEC), 404, `Object of type 'Connector' identified by ${unknown} is not found.`);
        await expectNoRun(api, name);
    });

    test('API-DISC-01[d]: a `connectorUuid` that is not a UUID answers 400 and never 500', m('d', '400 The request could not be processed.', ['v1-discovery', 'v2-discovery']), async ({ api }) => {
        const c = await anyConnectorOrSkip(api);
        const name = wfName('disc01-d');
        expectRefused(await probeCreateDiscovery(api, discoveryBody({ ...c, uuid: 'not-a-uuid' }, name, await validAttributes(api, c)), SPEC), 400, 'The request could not be processed.');
        await expectNoRun(api, name);
    });

    test('API-DISC-01[e]: a v1 connector with `resources` is refused with 422', m('e', 'v1 implements only certificates', ['v1-discovery']), async ({ api }) => {
        const c = await connectorOrSkip(api, 'v1');
        const name = wfName('disc01-e');
        const body = discoveryBody(c, name, await validAttributes(api, c), { body: { resources: ['certificates'] } });
        expectRefused(await probeCreateDiscovery(api, body, SPEC), 422, `Connector ${c.uuid} implements only the v1 discovery interface, which discovers certificates only`);
        await expectNoRun(api, name);
    });

    test('API-DISC-01[f]: a v1 connector with `resourceAttributes` is refused with 422', m('f', 'v1 has no per-resource attributes', ['v1-discovery']), async ({ api }) => {
        const c = await connectorOrSkip(api, 'v1');
        const name = wfName('disc01-f');
        // An empty map is no attribute; the platform refuses a NON-empty map, so one entry is sent.
        const attributes = await validAttributes(api, c);
        const body = discoveryBody(c, name, attributes, { body: { resourceAttributes: { certificates: attributes } } });
        expectRefused(await probeCreateDiscovery(api, body, SPEC), 422, `Connector ${c.uuid} implements only the v1 discovery interface, which has no per-resource attributes`);
        await expectNoRun(api, name);
    });

    test('API-DISC-01[g]: a v2 create without `resources` is refused with 422', m('g', 'resources is required', ['v2-discovery']), async ({ api }) => {
        const c = await connectorOrSkip(api, 'v2');
        const name = wfName('disc01-g');
        const body = discoveryBody(c, name, await validAttributes(api, c));
        delete body.resources;
        expectRefused(await probeCreateDiscovery(api, body, SPEC), 422, `resources is required for connector ${c.uuid}, which discovers several kinds`);
        await expectNoRun(api, name);
    });

    test('API-DISC-01[h]: a v2 create with an empty `resources` list is refused with 422', m('h', 'resources must name at least one', ['v2-discovery']), async ({ api }) => {
        const c = await connectorOrSkip(api, 'v2');
        const name = wfName('disc01-h');
        // A bean-validation message (`@Size` on `DiscoveryDto.resources`): the handler prints "<field> <message>", so the field name leads the DTO's own text.
        expectRefused(await probeCreateDiscovery(api, discoveryBody(c, name, await validAttributes(api, c), { resources: [] }), SPEC), 422, /(^|\s)resources must name at least one resource type when supplied$/);
        await expectNoRun(api, name);
    });

    test('API-DISC-01[i]: a v2 create for a resource the connector does not discover is refused with 422', m('i', 'does not discover', ['v2-discovery']), async ({ api }) => {
        const c = await connectorOrSkip(api, 'v2');
        const name = wfName('disc01-i');
        const sent = await probeCreateDiscovery(api, discoveryBody(c, name, await validAttributes(api, c), { resources: ['secrets'] }), SPEC);
        expectRefused(sent, 422, new RegExp(`^Connector ${c.uuid} does not discover \\[.+\\]$`));
        await expectNoRun(api, name);
    });

    test('API-DISC-01[j]: `resourceAttributes` for a resource the run does not target is refused with 422', m('j', 'resourceAttributes carries attributes for', ['v2-discovery']), async ({ api }) => {
        const c = await connectorOrSkip(api, 'v2');
        const name = wfName('disc01-j');
        const body = discoveryBody(c, name, await validAttributes(api, c), { resources: ['certificates'], body: { resourceAttributes: { keys: [] } } });
        expectRefused(await probeCreateDiscovery(api, body, SPEC), 422, /^resourceAttributes carries attributes for \[.+\], which this discovery does not target$/);
        await expectNoRun(api, name);
    });

    test('API-DISC-01[k]: v2 attribute content without `"version":"v3"` is refused with 422, not 500', m('k', '422 not 500', ['v2-discovery']), async ({ api }) => {
        const c = await connectorOrSkip(api, 'v2');
        const name = wfName('disc01-k');
        const attributes = (await validAttributes(api, c)).map((a) => {
            const { version: _version, ...rest } = a as Record<string, unknown>;
            return rest;
        });
        const sent = await probeCreateDiscovery(api, discoveryBody(c, name, attributes), SPEC);
        expect(sent.status, `refused: ${sent.text.slice(0, 300)}`).toBe(422);
        await expectNoRun(api, name);
    });

    test('API-DISC-01[l]: `triggers` naming a trigger of another resource or another event are refused with 422', m('l', 'trigger resource / event mismatch', ['v1-discovery', 'v2-discovery']), async ({ api }) => {
        const c = await anyConnectorOrSkip(api);
        const discoveryTrigger = await createOwnTrigger(api, SPEC, { suffix: 'disc01-l1', resource: 'discoveries', event: EVENT.discoveryFinished, ignore: true });
        const uploadTrigger = await createOwnTrigger(api, SPEC, { suffix: 'disc01-l2', event: EVENT.uploaded, ignore: true });
        const attributes = await validAttributes(api, c);
        for (const [t, text] of [
            [discoveryTrigger, `Trigger '${discoveryTrigger.name}' is for different resource (Discovery) than event '${EVENT_LABEL[EVENT.discovered]}' (Certificate)`],
            [uploadTrigger, `Trigger '${uploadTrigger.name}' is for different event (${EVENT_LABEL[EVENT.uploaded]}) than event '${EVENT_LABEL[EVENT.discovered]}'`],
        ] as const) {
            const name = wfName('disc01-l');
            expectRefused(await probeCreateDiscovery(api, discoveryBody(c, name, attributes, { triggers: [t] }), SPEC), 422, text);
            await expectNoRun(api, name);
        }
    });
});
