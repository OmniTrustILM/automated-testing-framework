/**
 * Events / discovery area (ilm#424 Phase 7): the PURE helpers of the area's request builders and the TLS scan target.
 * No network beyond 127.0.0.1 (the target's own listeners), no environment: the shapes the specs send are pinned here so a
 * change in a builder fails a unit test before it fails a run against a tier.
 * - workflowApi: trigger body (type event / manual), Set field items (custom identifier `name|CONTENTTYPE`, data as a string),
 *   association ledger notes (parseAssociationNote), event / resource code tables are complete;
 * - notificationApi: Java `UUID.nameUUIDFromBytes` (the webhook template attribute's uuid), e-mail / webhook request attributes,
 *   ISO-8601 durations;
 * - discoveryApi: the v1 (`ip`, `port`, `allPorts`, `data_parallel_executions`) and v2 (`version: v3`, one content item per entry)
 *   attribute shapes, the generation-dependent body, `isSubsequence`, `fingerprintSet`;
 * - tlsTarget: the deploy gate texts, a served chain read back over a real TLS handshake on loopback, distinct leaves.
 */
import { expect, test } from '@playwright/test';
import * as tls from 'tls';
import * as crypto from 'crypto';
import {
    DiscoveryConnector, discoveryBody, fingerprintSet, isSubsequence, v1Attributes, v2Attributes,
} from '../../utils/regression/discoveryApi';
import {
    durationSeconds, emailAttributes, nameUuidFromBytes, webhookAttributes, webhookTemplateAttribute, WEBHOOK_TEMPLATE_UUID,
} from '../../utils/regression/notificationApi';
import { scanHost, scanTargetProblem, startTlsTarget } from '../../utils/regression/tlsTarget';
import {
    assertHeldFor, associationKey, conditionItem, errorShapeOf, errorTexts, EVENT, EVENT_LABEL, EVENT_RESOURCE, sendNotificationItem, setCustomAttribute, setGroups,
    setOwner, setRaProfile, triggerBody,
} from '../../utils/regression/workflowApi';
import { parseAssociationNote } from '../../utils/workflowUtils';
import { regName, RUN_ID } from '../../utils/regression/regressionRun';

type Json = Record<string, any>;

// ------------------------------------------------------------------ workflow builders

test('a trigger with an event is type event; without one it is manual and carries no event', () => {
    const withEvent = triggerBody({ event: EVENT.actionPerformed, rules: [{ uuid: 'r1' }], actions: [{ uuid: 'a1' }] });
    expect(withEvent).toMatchObject({ type: 'event', event: 'certificate_action_performed', resource: 'certificates', ignoreTrigger: false, rulesUuids: ['r1'], actionsUuids: ['a1'] });
    const manual = triggerBody({});
    expect(manual.type).toBe('manual');
    expect('event' in manual).toBe(false);
    expect(manual).toMatchObject({ rulesUuids: [], actionsUuids: [] });
    expect(triggerBody({ event: EVENT.uploaded, ignore: true }).ignoreTrigger).toBe(true);
    expect(triggerBody({}).description).toContain(RUN_ID);
});

test('Set field items: group list, owner (or null), RA profile, custom attribute identifier and string data, notification', () => {
    expect(setGroups(['g1', 'g2'])).toEqual({ fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', data: ['g1', 'g2'] });
    expect(setOwner('u1')).toMatchObject({ fieldIdentifier: 'OWNER', data: 'u1' });
    expect(setOwner(null).data).toBeNull();
    expect(setRaProfile('p1')).toMatchObject({ fieldIdentifier: 'RA_PROFILE_NAME', data: 'p1' });
    // core ActionServiceImpl: `<name>|<CONTENT TYPE ENUM NAME>`, the data a string
    expect(setCustomAttribute('marker', 'string', 42)).toEqual({ fieldSource: 'custom', fieldIdentifier: 'marker|STRING', data: '42' });
    expect(sendNotificationItem('np1')).toEqual({ notificationProfileUuid: 'np1' });
});

test('a condition item without a value carries no value key (the no-operand operators)', () => {
    expect(conditionItem('property', 'COMMON_NAME', 'EQUALS', 'x')).toEqual({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'EQUALS', value: 'x' });
    expect('value' in conditionItem('property', 'COMMON_NAME', 'EMPTY')).toBe(false);
    expect(conditionItem('property', 'COMMON_NAME', 'EQUALS', '')).toMatchObject({ value: '' });
    expect(conditionItem('property', 'COMMON_NAME', 'EQUALS', 0)).toMatchObject({ value: 0 });
});

test('every event has a label and the resource whose objects it fires on', () => {
    for (const code of Object.values(EVENT)) {
        expect(EVENT_LABEL[code], `label of ${code}`).toBeTruthy();
        expect(EVENT_RESOURCE[code], `resource of ${code}`).toBeTruthy();
    }
    expect(EVENT_RESOURCE[EVENT.uploaded]).toBe('certificates');
});

test('association notes round-trip: key, parse, and a malformed note parses to nothing', () => {
    const key = associationKey(EVENT.actionPerformed, 'groups', 'obj-1');
    expect(key).toBe('certificate_action_performed|groups|obj-1');
    expect(parseAssociationNote(`${key} object-level association of own triggers on an own groups`)).toEqual({ event: 'certificate_action_performed', resource: 'groups', objectUuid: 'obj-1' });
    expect(parseAssociationNote('only-two|parts')).toBeUndefined();
    expect(parseAssociationNote(undefined)).toBeUndefined();
    expect(parseAssociationNote('')).toBeUndefined();
});

test('error texts: array bodies, message bodies, anything else', () => {
    const sent = (json: unknown, text = ''): any => ({ status: 422, text, json, headers: {} });
    expect(errorTexts(sent(['a', 'b']))).toEqual(['a', 'b']);
    expect(errorShapeOf(sent(['a']))).toBe('array');
    expect(errorTexts(sent({ message: 'm' }))).toEqual(['m']);
    expect(errorShapeOf(sent({ message: 'm' }))).toBe('message');
    expect(errorShapeOf(sent({ other: 1 }))).toBe('other');
});

// ------------------------------------------------------------------ absence window

test('assertHeldFor reads through the whole window and once at its end; a violation fails at the first read that sees it', async () => {
    let reads = 0;
    const startedAt = Date.now();
    const total = await assertHeldFor({ forMs: 120, everyMs: 30 }, async () => {
        reads += 1;
    });
    expect(total).toBe(reads);
    expect(reads, 'several reads inside the window, not one sleep and one look').toBeGreaterThanOrEqual(3);
    expect(Date.now() - startedAt, 'the window is kept').toBeGreaterThanOrEqual(110);

    let seen = 0;
    const t0 = Date.now();
    await expect(assertHeldFor({ forMs: 5_000, everyMs: 20 }, async () => {
        seen += 1;
        if (seen === 3) throw new Error('a second run appeared');
    })).rejects.toThrow('a second run appeared');
    expect(seen, 'stopped at the violating read').toBe(3);
    expect(Date.now() - t0, 'failed long before the window ended').toBeLessThan(1_000);
});

// ------------------------------------------------------------------ notification builders

test('nameUuidFromBytes is Java UUID.nameUUIDFromBytes (version 3, IETF variant)', () => {
    expect(nameUuidFromBytes(Buffer.from(''))).toBe('d41d8cd9-8f00-3204-a980-0998ecf8427e'); // the well-known empty-input vector
    const u = nameUuidFromBytes(Buffer.from('abc'));
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(nameUuidFromBytes(Buffer.from('abc'))).toBe(u);
});

test('the webhook template attribute: uuid derived per content type, codeblock content with a base64 template', () => {
    const json = webhookTemplateAttribute('JSON', '{"a":"${event}"}');
    expect(json.name).toBe('data_contentTemplate_json');
    expect(json.uuid).toBe(nameUuidFromBytes(Buffer.from(`${WEBHOOK_TEMPLATE_UUID}json`)));
    expect(json.contentType).toBe('codeblock');
    expect(json.content[0].data.language).toBe('json');
    expect(Buffer.from(json.content[0].data.code, 'base64').toString('utf8')).toBe('{"a":"${event}"}');
    expect(webhookTemplateAttribute('XML', '<a/>').content[0].data.language).toBe('xml');
    expect(webhookTemplateAttribute('RAW_JSON', '{}').name).toBe('data_contentTemplate_raw_json');
});

const EMAIL_DEFS: Json[] = [
    { uuid: 'u-sender', name: 'data_senderEmailAddress', contentType: 'string' },
    { uuid: 'u-subject', name: 'data_emailSubject', contentType: 'string' },
    { uuid: 'u-template', name: 'data_emailContentTemplate', contentType: 'codeblock' },
];
const WEBHOOK_DEFS: Json[] = [
    { uuid: 'u-url', name: 'data_webhookUrl', contentType: 'string' },
    { uuid: 'u-ct', name: 'data_contentType', contentType: 'string', content: [{ reference: 'json', data: 'JSON' }, { reference: 'xml', data: 'XML' }, { reference: 'raw_json', data: 'RAW_JSON' }] },
];

test('e-mail attributes: only the given values are sent (negative cases leave one out); the template is a base64 html codeblock', () => {
    const all = emailAttributes(EMAIL_DEFS, { sender: 'a@example.test', subject: 's', template: '<p/>' });
    expect(all.map((a) => a.name)).toEqual(['data_senderEmailAddress', 'data_emailSubject', 'data_emailContentTemplate']);
    expect(all[2].content[0].data).toMatchObject({ language: 'html' });
    expect(emailAttributes(EMAIL_DEFS, { sender: 'a@example.test' }).map((a) => a.name)).toEqual(['data_senderEmailAddress']);
    expect(emailAttributes(EMAIL_DEFS, {})).toEqual([]);
    expect(() => emailAttributes([], { sender: 'a@example.test' })).toThrow(/offers no attribute data_senderEmailAddress/);
});

test('webhook attributes: the content type reference comes from the live definition; RAW_JSON sends no template', () => {
    const json = webhookAttributes(WEBHOOK_DEFS, { url: 'https://x.example.test/h', contentType: 'JSON', template: '{}' });
    expect(json.map((a) => a.name)).toEqual(['data_webhookUrl', 'data_contentType', 'data_contentTemplate_json']);
    expect(json[1].content).toEqual([{ reference: 'json', data: 'JSON' }]);
    const raw = webhookAttributes(WEBHOOK_DEFS, { url: 'https://x.example.test/h', contentType: 'RAW_JSON', template: '{}' });
    expect(raw.map((a) => a.name)).toEqual(['data_webhookUrl', 'data_contentType']);
    expect(webhookAttributes(WEBHOOK_DEFS, { contentType: 'XML', template: '<a/>' }).map((a) => a.name)).toEqual(['data_contentType', 'data_contentTemplate_xml']);
});

test('durations: ISO-8601 days / hours / minutes / seconds and plain numbers; anything else is undefined', () => {
    expect(durationSeconds('P1DT12H')).toBe(129600);
    expect(durationSeconds('PT30M')).toBe(1800);
    expect(durationSeconds('PT1.5S')).toBe(1.5);
    expect(durationSeconds('P2D')).toBe(172800);
    expect(durationSeconds(90)).toBe(90);
    expect(durationSeconds('soon')).toBeUndefined();
    expect(durationSeconds(null)).toBeUndefined();
});

// ------------------------------------------------------------------ discovery builders

const V1_DEFS: Json[] = [
    { uuid: 'd-ip', name: 'ip', contentType: 'string' },
    { uuid: 'd-port', name: 'port', contentType: 'string' },
    { uuid: 'd-all', name: 'allPorts', contentType: 'boolean' },
    { uuid: 'd-par', name: 'data_parallel_executions', contentType: 'integer' },
];
const V2_DEFS: Json[] = [
    { uuid: 'e-hosts', name: 'data_hosts', contentType: 'string' },
    { uuid: 'e-ports', name: 'data_ports', contentType: 'string' },
    { uuid: 'e-par', name: 'data_parallelExecutions', contentType: 'integer' },
];
const V1: DiscoveryConnector = { uuid: 'c1', name: 'n', generation: 'v1', kind: 'IP-Hostname' } as DiscoveryConnector;
const V2: DiscoveryConnector = { uuid: 'c2', name: 'n', generation: 'v2', interfaceUuid: 'i2' } as DiscoveryConnector;

test('v1 attributes: one comma-separated ip value, ports, allPorts, parallel; unset fields are left out', () => {
    const a = v1Attributes(V1_DEFS, { hosts: ['192.0.2.1', '192.0.2.2'], ports: ['443', '8443'], allPorts: false, parallel: 3 });
    expect(a.map((x) => [x.name, x.content[0].data])).toEqual([['ip', '192.0.2.1,192.0.2.2'], ['port', '443,8443'], ['allPorts', false], ['data_parallel_executions', 3]]);
    expect(a.every((x) => !('version' in x))).toBe(true);
    expect(v1Attributes(V1_DEFS, {})).toEqual([]);
    expect(() => v1Attributes([], { hosts: ['x'] })).toThrow(/offers no attribute ip/);
});

test('v2 attributes: version v3, one content item per entry with its content type', () => {
    const a = v2Attributes(V2_DEFS, { hosts: ['192.0.2.0/24', '198.51.100.0/24'], ports: ['443'], parallel: 5 });
    expect(a[0]).toMatchObject({ version: 'v3', name: 'data_hosts', contentType: 'string' });
    expect(a[0].content).toEqual([{ contentType: 'string', data: '192.0.2.0/24' }, { contentType: 'string', data: '198.51.100.0/24' }]);
    expect(a[2]).toMatchObject({ name: 'data_parallelExecutions', contentType: 'integer', content: [{ contentType: 'integer', data: 5 }] });
    expect(v2Attributes(V2_DEFS, { hosts: [] })[0].content).toEqual([]);
});

test('the discovery body depends on the generation: v1 kind, v2 interface + resources; triggers and overrides are applied', () => {
    const b1 = discoveryBody(V1, 'n1', [], { triggers: [{ uuid: 't1' }] });
    expect(b1).toMatchObject({ name: 'n1', connectorUuid: 'c1', kind: 'IP-Hostname', triggers: ['t1'] });
    expect('interfaceUuid' in b1 || 'resources' in b1).toBe(false);
    const b2 = discoveryBody(V2, 'n2', []);
    expect(b2).toMatchObject({ connectorUuid: 'c2', interfaceUuid: 'i2', resources: ['certificates'] });
    expect('kind' in b2).toBe(false);
    expect('triggers' in b2).toBe(false);
    expect(discoveryBody(V2, 'n2', [], { resources: ['keys'], body: { name: 'override' } })).toMatchObject({ name: 'override', resources: ['keys'] });
});

test('isSubsequence keeps order and allows gaps; fingerprintSet normalises, de-duplicates and sorts', () => {
    expect(isSubsequence(['inProgress', 'completed'], ['inProgress', 'processing', 'completed'])).toBe(true);
    expect(isSubsequence(['completed', 'inProgress'], ['inProgress', 'completed'])).toBe(false);
    expect(isSubsequence([], ['a'])).toBe(true);
    expect(isSubsequence(['a'], [])).toBe(false);
    expect(fingerprintSet([{ fingerprint: 'AB:CD' }, { fingerprint: 'abcd' }, { fingerprint: '01 02' }, {}])).toEqual(['0102', 'abcd']);
});

// ------------------------------------------------------------------ TLS scan target

test('the scan target deploy gate: unset, malformed and valid REG_SCAN_HOST', () => {
    expect(scanTargetProblem({})).toMatch(/^deploy gate: no scan target \(REG_SCAN_HOST unset\)/);
    expect(scanTargetProblem({ REG_SCAN_HOST: 'localhost' })).toMatch(/neither a dotted host name nor an IP address/);
    expect(scanTargetProblem({ REG_SCAN_HOST: 'runner.qa.example.test' })).toBeUndefined();
    expect(scanTargetProblem({ REG_SCAN_HOST: '127.0.0.1' })).toBeUndefined();
    expect(scanHost({ REG_SCAN_HOST: '  h.example.test ' })).toBe('h.example.test');
    expect(scanHost({})).toBe('');
});

test('startTlsTarget without a scan host refuses with the deploy gate text and opens nothing', async () => {
    await expect(startTlsTarget({ env: {} })).rejects.toThrow(/deploy gate: no scan target/);
});

/** The chain a listener really serves: a TLS handshake on loopback, certificates read from the socket (no verification). */
async function servedOn(port: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
            const out: string[] = [];
            let c: tls.DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
            const seen = new Set<string>();
            while (c && c.raw && !seen.has(c.fingerprint256)) {
                seen.add(c.fingerprint256);
                out.push(crypto.createHash('sha256').update(c.raw).digest('hex'));
                c = c.issuerCertificate && c.issuerCertificate !== c ? c.issuerCertificate : undefined;
            }
            socket.end();
            resolve(out);
        });
        socket.on('error', reject);
    });
}

test('a target with an intermediate serves leaf + intermediate; its own fingerprints equal what a client reads', async () => {
    const target = await startTlsTarget({ env: { REG_SCAN_HOST: '127.0.0.1', REG_SCAN_BIND: '127.0.0.1' }, listeners: 1 });
    try {
        expect(target.ports).toHaveLength(1);
        expect(target.host).toBe('127.0.0.1');
        expect(target.served[0].map((c) => c.role)).toEqual(['leaf', 'intermediate']);
        const read = await servedOn(target.ports[0]);
        expect(read.slice(0, 2).sort()).toEqual(target.servedFingerprints());
        expect(target.served[0][0].commonName.startsWith(regName(''))).toBe(true);
        expect(target.portsAttribute()).toBe(String(target.ports[0]));
        expect(target.ipAttribute()).toBe('127.0.0.1');
    } finally {
        await target.close();
        await target.close(); // idempotent
    }
});

test('distinct leaves: 3 listeners / 2 distinct leaves repeat leaf 1; no intermediate serves the leaf alone', async () => {
    const target = await startTlsTarget({ env: { REG_SCAN_HOST: '127.0.0.1', REG_SCAN_BIND: '127.0.0.1' }, listeners: 3, distinctLeaves: 2, withIntermediate: false, stem: 'unit' });
    try {
        expect(target.ports).toHaveLength(3);
        expect(new Set(target.ports).size).toBe(3);
        expect(target.served.every((chain) => chain.length === 1)).toBe(true);
        const leafPrints = target.served.map((c) => c[0].fingerprint);
        expect(new Set(leafPrints).size).toBe(2);
        expect(leafPrints[2]).toBe(leafPrints[0]);
        expect(target.distinct()).toHaveLength(2);
        expect(await servedOn(target.ports[1])).toEqual([leafPrints[1]]);
    } finally {
        await target.close();
    }
});

test('a client cannot reach a closed target (the listeners are gone after close)', async () => {
    const target = await startTlsTarget({ env: { REG_SCAN_HOST: '127.0.0.1', REG_SCAN_BIND: '127.0.0.1' } });
    const port = target.ports[0];
    await target.close();
    await expect(servedOn(port)).rejects.toThrow();
});
