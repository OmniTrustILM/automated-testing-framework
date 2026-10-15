/**
 * API-WFL-22 — the notification profile validation matrix, one request each, NOTHING created (ilm#434 steps 4–5; T10 R12–R14, R20;
 * P-02…P-04, P-06). Texts of `NotificationProfileUpdateRequestDto` (HTTP 422, a JSON array of "<property> <message>") and of
 * `NotificationProfileServiceImpl`:
 *   a  recipient type USER, no uuids                    "Recipient UUID is required when recipient type is not Owner, None, Default or Object"
 *   b  recipient type OWNER with uuids                  the same message (the text is misleading, T10 E10: asserted as is)
 *   c  NONE, DEFAULT or OBJECT with internal true       "Cannot send internal notification to recipient of type None, Default or Object"
 *   d  no instance and internal false                   "Notification instance and/or internal notification is required"
 *   e  recipient type missing                           "Recipient type is required"
 *   f  blank name (create)                              422, the list names `name`
 *   g  frequency PT30M                                  "Frequency can only contain days and hours."
 *   h  repetitions 0 and -1                             "must be greater than 0"
 *   i  unknown recipient code / unknown category code   400 {"message":"Unable to read HTTP message"} (the enum is read by Jackson before
 *                                                       any service code runs: `ExceptionHandlingAdvice` HttpMessageNotReadable)
 *   j  unknown instance, user, group, role uuid         404 "Object of type '<Type>' identified by <uuid> is not found."
 *   k  duplicate profile name                           409 "Notification profile with name <name> already exists."
 *   l  a null entry in `eventDataCategories`            "Event data categories must not contain null entries"
 * Rows that need an instance (j's instance, d's counterpart) use ONE own e-mail instance and are `@needs:email-provider`; every
 * other row needs no connector. A refused create that persisted something anyway (a 404 after the save) is recorded before the
 * assertion fails. Recipients are OWN objects or probe uuids (the guard types `recipientUuids`).
 */
import { expect, test } from '../../fixtures/testFixtures';
import { createOwnGroup } from '../../utils/regression/eventsDrivers';
import {
    createOwnInstance, createOwnInternalProfile, EMAIL_TEMPLATE, emailAttributes, findNotificationConnector, instanceDefinitions, mentions, probeProfile, profileBody, recordNamed,
    reservedSender,
} from '../../utils/regression/notificationApi';
import { createOwnUser } from '../../utils/regression/regressionApi';
import { errorShapeOf, Sent, wfName } from '../../utils/regression/workflowApi';
import { meta, tags } from '../../utils/regression/tags';

const SPEC = 'API-WFL-22';
type Api = Parameters<typeof findNotificationConnector>[0];
type Json = Record<string, any>;

/** Sends one profile request; a refused request that left a profile behind is recorded before the caller asserts. */
async function refuse(api: Api, body: Json): Promise<Sent> {
    const sent = await probeProfile(api, body, SPEC);
    if (typeof body.name === 'string') expect(await recordNamed(api, 'profiles', body.name, SPEC), 'the refused request created nothing').toEqual([]);
    return sent;
}

function expect422(sent: Sent, text: string | RegExp): void {
    expect(sent.status, `refused with 422: ${sent.text.slice(0, 300)}`).toBe(422);
    expect(errorShapeOf(sent), '422 is a JSON array of strings').toBe('array');
    expect(mentions(sent, text), `${String(text)} among ${JSON.stringify(sent.json)}`).toBe(true);
}

test.describe('API-WFL-22 notification profile validation (nothing created)', { tag: tags.api }, () => {
    const m = (row: string, rule: string, needs: string[] = []) => meta({ id: 'API-WFL-22', prio: 'P1', issue: 'ilm#434', needs, rule: [`T10 R12–R14 / R20 (NotificationProfileUpdateRequestDto, NotificationProfileServiceImpl): P-N22 row ${row}: ${rule}`] });
    const RECIPIENT_REQUIRED = 'Recipient UUID is required when recipient type is not Owner, None, Default or Object';

    test('API-WFL-22[a]: recipient type USER without recipient uuids is refused', m('a', RECIPIENT_REQUIRED), async ({ api }) => {
        expect422(await refuse(api, profileBody(wfName('wf22-a'), { recipientType: 'user', internal: true })), RECIPIENT_REQUIRED);
    });

    test('API-WFL-22[b]: recipient type OWNER with recipient uuids is refused with the same (misleading) message', m('b', RECIPIENT_REQUIRED), async ({ api }) => {
        const user = await createOwnUser(api, 'wf22-user', SPEC);
        expect422(await refuse(api, profileBody(wfName('wf22-b'), { recipientType: 'owner', recipients: [user], internal: true })), RECIPIENT_REQUIRED);
    });

    for (const type of ['none', 'default', 'object'] as const) {
        test(`API-WFL-22[c:${type}]: recipient type ${type} with internal notification is refused`, m('c', 'Cannot send internal notification to recipient of type None, Default or Object'), async ({ api }) => {
            expect422(await refuse(api, profileBody(wfName('wf22-c'), { recipientType: type, internal: true })), 'Cannot send internal notification to recipient of type None, Default or Object');
        });
    }

    test('API-WFL-22[d]: a profile with neither an instance nor internal notification is refused', m('d', 'Notification instance and/or internal notification is required'), async ({ api }) => {
        expect422(await refuse(api, profileBody(wfName('wf22-d'), { recipientType: 'owner', internal: false })), 'Notification instance and/or internal notification is required');
    });

    test('API-WFL-22[e]: a profile without a recipient type is refused', m('e', 'Recipient type is required'), async ({ api }) => {
        const body = profileBody(wfName('wf22-e'), { recipientType: 'owner', internal: true });
        delete body.recipientType;
        expect422(await refuse(api, body), 'Recipient type is required');
    });

    test('API-WFL-22[f]: a blank name is refused and the list names the name property', m('f', 'name must not be blank'), async ({ api }) => {
        expect422(await refuse(api, profileBody('', { recipientType: 'owner', internal: true })), /name/i);
    });

    test('API-WFL-22[g]: a frequency that is not whole days and hours is refused', m('g', 'Frequency can only contain days and hours.'), async ({ api }) => {
        expect422(await refuse(api, profileBody(wfName('wf22-g'), { recipientType: 'owner', internal: true, frequency: 'PT30M' })), 'Frequency can only contain days and hours.');
    });

    for (const repetitions of [0, -1]) {
        test(`API-WFL-22[h:${repetitions}]: repetitions ${repetitions} is refused`, m('h', 'must be greater than 0'), async ({ api }) => {
            expect422(await refuse(api, profileBody(wfName('wf22-h'), { recipientType: 'owner', internal: true, repetitions })), 'must be greater than 0');
        });
    }

    test('API-WFL-22[i]: an unknown recipient type code and an unknown data category code are refused with 400', m('i', '400 Unable to read HTTP message'), async ({ api }) => {
        // Both are enums on the wire: an unknown code never reaches the service (whose "Unknown … code" texts are for programmatic callers),
        // the message converter fails first and the advice answers 400 `{"message":"Unable to read HTTP message"}`.
        const unknownType = { ...profileBody(wfName('wf22-i1'), { recipientType: 'owner', internal: true }), recipientType: 'bogus' };
        const unknownCategory = profileBody(wfName('wf22-i2'), { recipientType: 'owner', internal: true, categories: ['bogus'] });
        for (const body of [unknownType, unknownCategory]) {
            const sent = await refuse(api, body);
            expect(sent.status, `refused with 400: ${sent.text.slice(0, 300)}`).toBe(400);
            expect(sent.json, 'the body is the single-message error').toEqual({ message: 'Unable to read HTTP message' });
        }
    });

    test('API-WFL-22[j]: an unknown user, group or role uuid is refused with 404 naming the type and the uuid', m('j', "404 Object of type '<Type>' identified by <uuid> is not found."), async ({ api }) => {
        for (const [type, label] of [['user', 'User'], ['group', 'Group'], ['role', 'Role']] as const) {
            const probe = api.probeUuid();
            const sent = await refuse(api, profileBody(wfName(`wf22-j-${type}`), { recipientType: type, recipients: [{ uuid: probe }], internal: true }));
            expect(sent.status, sent.text.slice(0, 300)).toBe(404);
            expect(mentions(sent, `Object of type '${label}' identified by ${probe} is not found.`), JSON.stringify(sent.json)).toBe(true);
        }
    });

    test('API-WFL-22[j-instance]: an unknown notification instance uuid is refused with 404', m('j', "404 Object of type 'NotificationInstanceReference' identified by <uuid> is not found."), async ({ api }) => {
        const probe = api.probeUuid();
        const sent = await refuse(api, profileBody(wfName('wf22-j-inst'), { recipientType: 'owner', instance: { uuid: probe } }));
        expect(sent.status, sent.text.slice(0, 300)).toBe(404);
        expect(mentions(sent, `Object of type 'NotificationInstanceReference' identified by ${probe} is not found.`), JSON.stringify(sent.json)).toBe(true);
    });

    test('API-WFL-22[k]: a second profile with the name of an existing one is refused with 409', m('k', 'Notification profile with name <name> already exists.'), async ({ api }) => {
        const group = await createOwnGroup(api, SPEC, 'wf22-k-group');
        const seed = await createOwnInternalProfile(api, SPEC, { suffix: 'wf22-seed', recipientType: 'group', recipients: [group] });
        const sent = await probeProfile(api, profileBody(seed.name, { recipientType: 'group', recipients: [group], internal: true }), SPEC);
        expect(sent.status, sent.text.slice(0, 300)).toBe(409);
        expect(errorShapeOf(sent)).toBe('message');
        expect(sent.json.message).toBe(`Notification profile with name ${seed.name} already exists.`);
        expect(await recordNamed(api, 'profiles', seed.name, SPEC), 'exactly the seed profile carries the name').toEqual([seed.uuid]);
    });

    test('API-WFL-22[l]: a null entry in eventDataCategories is refused', m('l', 'Event data categories must not contain null entries'), async ({ api }) => {
        const body = { ...profileBody(wfName('wf22-l'), { recipientType: 'owner', internal: true }), eventDataCategories: [null] };
        const sent = await refuse(api, body);
        expect(sent.status, sent.text.slice(0, 300)).toBe(422);
        expect(errorShapeOf(sent)).toBe('array');
    });

    test('API-WFL-22[instance-rows]: with an e-mail instance, a USER profile without recipients is still refused and the instance reference is accepted', m('d', 'instance accepted, recipients still required', ['email-provider']), async ({ api }) => {
        const connector = await findNotificationConnector(api, 'EMAIL');
        test.skip(!connector || !!connector.unhealthy, 'deploy gate: no healthy e-mail notification connector on this tier (@needs:email-provider)');
        const instance = await createOwnInstance(api, SPEC, { suffix: 'wf22-inst', connector: connector!, attributes: emailAttributes(await instanceDefinitions(api, connector!), { sender: reservedSender(), subject: 'QA API-WFL-22', template: EMAIL_TEMPLATE }) });
        expect422(await refuse(api, profileBody(wfName('wf22-inst-user'), { recipientType: 'user', instance })), RECIPIENT_REQUIRED);
    });
});
