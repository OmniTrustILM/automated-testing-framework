/**
 * The pure helpers of the events area: workflow request builders (trigger body, Set field items, condition items), the
 * association ledger notes, the event labels, the absence window, and the notification request attributes (the connector's
 * uuid per content type of the webhook template attribute, e-mail / webhook attributes, ISO-8601 durations). No network: a change
 * in a builder fails here before it fails a run against a tier.
 */
import { expect, test } from '@playwright/test';
import { durationSeconds } from '../../utils/regression/events/notificationProfiles';
import { emailAttributes, webhookAttributes, webhookTemplateAttribute } from '../../utils/regression/events/notificationAttributes';
import { associationKey } from '../../utils/regression/events/eventAssociations';
import { assertHeldFor, firingsOfObject } from '../../utils/regression/events/eventHistory';
import { EVENT, EVENT_LABEL } from '../../utils/regression/events/eventVocabulary';
import { conditionItem, sendNotificationItem, setCustomAttributeAction, setGroupsAction, setOwnerAction, setRaProfileAction, triggerBody } from '../../utils/regression/events/workflowObjects';
import { errorShapeOf, errorTexts } from '../../utils/regression/events/workflowRequests';
import { parseAssociationNote } from '../../utils/regression/events/workflowTeardown';
import { runId } from '../../utils/regression/ledger/runState';
import { contentOf } from './helpers/contentOf';

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
    expect(triggerBody({}).description).toContain(runId());
});

test('Set field items: group list, owner (or null), RA profile, custom attribute identifier and string data, notification', () => {
    expect(setGroupsAction(['g1', 'g2'])).toEqual({ fieldSource: 'property', fieldIdentifier: 'GROUP_NAME', data: ['g1', 'g2'] });
    expect(setOwnerAction('u1')).toMatchObject({ fieldIdentifier: 'OWNER', data: 'u1' });
    expect(setOwnerAction(null).data).toBeNull();
    expect(setRaProfileAction('p1')).toMatchObject({ fieldIdentifier: 'RA_PROFILE_NAME', data: 'p1' });
    // core ActionServiceImpl: `<name>|<CONTENT TYPE ENUM NAME>`, the data a string
    expect(setCustomAttributeAction('marker', 'string', 42)).toEqual({ fieldSource: 'custom', fieldIdentifier: 'marker|STRING', data: '42' });
    expect(sendNotificationItem('np1')).toEqual({ notificationProfileUuid: 'np1' });
});

test('a condition item without a value carries no value key (the no-operand operators)', () => {
    expect(conditionItem('property', 'COMMON_NAME', 'EQUALS', 'x')).toEqual({ fieldSource: 'property', fieldIdentifier: 'COMMON_NAME', operator: 'EQUALS', value: 'x' });
    expect('value' in conditionItem('property', 'COMMON_NAME', 'EMPTY')).toBe(false);
    expect(conditionItem('property', 'COMMON_NAME', 'EQUALS', '')).toMatchObject({ value: '' });
    expect(conditionItem('property', 'COMMON_NAME', 'EQUALS', 0)).toMatchObject({ value: 0 });
});

test('every event has the label the platform prints in its messages', () => {
    for (const code of Object.values(EVENT)) expect(EVENT_LABEL[code], `label of ${code}`).toBeTruthy();
    expect(EVENT_LABEL[EVENT.uploaded]).toBe('Certificate uploaded');
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

test('the webhook template attribute: the connector uuid per content type, codeblock content with a base64 template', () => {
    const json = webhookTemplateAttribute('JSON', '{"a":"${event}"}');
    expect(json.name).toBe('data_contentTemplate_json');
    // Java UUID.nameUUIDFromBytes of the connector's template uuid + the content type code (webhook Attributes.java)
    expect(json.uuid).toBe('77ddf598-724a-31d4-943b-79ee71c854c5');
    expect(webhookTemplateAttribute('XML', '<a/>').uuid).toBe('610ed4fa-0b1f-33a9-9a31-0be332673a58');
    expect(webhookTemplateAttribute('RAW_JSON', '{}').uuid).toBe('07ea053b-3515-3ce8-a8a5-acfca3d4ed15');
    expect(json.contentType).toBe('codeblock');
    expect(contentOf(json)[0].data.language).toBe('json');
    expect(Buffer.from(contentOf(json)[0].data.code, 'base64').toString('utf8')).toBe('{"a":"${event}"}');
    expect(contentOf(webhookTemplateAttribute('XML', '<a/>'))[0].data.language).toBe('xml');
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
    expect(contentOf(all[2])[0].data).toMatchObject({ language: 'html' });
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

test('firingsOfObject: the firings whose objects include the uuid, in page order; none for another object or an empty page', () => {
    const firing = (startedAt: string, uuids: string[]) => ({
        startedAt, status: 'finished' as const, resource: 'certificates', objectsEvaluated: uuids.length, objectsMatched: uuids.length, objectsIgnored: 0,
        objectHistories: { items: uuids.map((objectUuid) => ({ objectUuid })), itemsPerPage: 10, pageNumber: 1, totalPages: 1, totalItems: uuids.length },
    });
    const page = { items: [firing('t3', ['b']), firing('t2', ['a', 'c']), firing('t1', ['a'])] };
    expect(firingsOfObject(page, 'a').map((f) => f.startedAt)).toEqual(['t2', 't1']);
    expect(firingsOfObject(page, 'b').map((f) => f.startedAt)).toEqual(['t3']);
    expect(firingsOfObject(page, 'z')).toEqual([]);
    expect(firingsOfObject({ items: [] }, 'a')).toEqual([]);
    expect(firingsOfObject({ items: [{ ...firing('t0', []), objectHistories: undefined as never /* a firing the platform sent without the field the type requires */ }] }, 'a')).toEqual([]);
});
