/**
 * API-WFL-22 — notification profile validation matrix, one request per row, nothing created. ilm#434.
 * A refused request that persisted a profile anyway is recorded in the ledger before the assertion fails.
 */
import { expect, test } from '../../../fixtures/regressionFixtures';
import { createOwnGroup } from '../../../utils/regression/ownGroups';
import { createOwnInstance, mentions } from '../../../utils/regression/events/notificationInstances';
import { createOwnInternalProfile, probeProfile, profileBody, recordNamed } from '../../../utils/regression/events/notificationProfiles';
import { EMAIL_TEMPLATE, emailAttributes, reservedSender } from '../../../utils/regression/events/notificationAttributes';
import { findNotificationConnector, instanceDefinitions } from '../../../utils/regression/events/notificationConnector';
import { createOwnUser } from '../../../utils/regression/ownUsers';
import { errorShapeOf } from '../../../utils/regression/events/workflowRequests';
import { testMeta, tags, type Needs } from '../../../utils/regression/tags';
import { ownName } from '../../../utils/regression/ledger/runState';
import { ApiAnswer } from '../../../utils/regression/apiReads';

type Api = Parameters<typeof findNotificationConnector>[0];
type Json = Record<string, any>;

/** Sends one profile request; a refused request that left a profile behind is recorded before the caller asserts. */
async function refuse(api: Api, spec: string, body: Json): Promise<ApiAnswer> {
    const sent = await probeProfile(api, spec, body);
    if (typeof body.name === 'string') expect(await recordNamed(api, 'profiles', body.name, spec), 'the refused request created nothing').toEqual([]);
    return sent;
}

function expect422(sent: ApiAnswer, text: string | RegExp): void {
    expect(sent.status, `refused with 422: ${sent.text.slice(0, 300)}`).toBe(422);
    expect(errorShapeOf(sent), '422 is a JSON array of strings').toBe('array');
    expect(mentions(sent, text), `${String(text)} among ${JSON.stringify(sent.json)}`).toBe(true);
}

test.describe('Notification profile validation (nothing created)', { tag: tags.api }, () => {
    const rowMeta = (row: string, rule: string, needs: Needs[] = []) => testMeta({ id: 'API-WFL-22', row, prio: 'P1', issue: 'ilm#434', needs, rule: [`${rule} (NotificationProfileUpdateRequestDto, NotificationProfileServiceImpl)`] });
    const RECIPIENT_REQUIRED = 'Recipient UUID is required when recipient type is not Owner, None, Default or Object';

    test('recipient type USER without recipient uuids is refused', rowMeta('a', RECIPIENT_REQUIRED), async ({ api, own }) => {
        expect422(await refuse(api, own.spec, profileBody(ownName('wf22-a'), { recipientType: 'user', internal: true })), RECIPIENT_REQUIRED);
    });

    test('recipient type OWNER with recipient uuids is refused with the same (misleading) message', rowMeta('b', RECIPIENT_REQUIRED), async ({ api, own }) => {
        const user = await createOwnUser(api, own.spec, 'wf22-user');
        expect422(await refuse(api, own.spec, profileBody(ownName('wf22-b'), { recipientType: 'owner', recipients: [user], internal: true })), RECIPIENT_REQUIRED);
    });

    for (const type of ['none', 'default', 'object'] as const) {
        test(`recipient type ${type} with internal notification is refused`, rowMeta('c', 'Cannot send internal notification to recipient of type None, Default or Object'), async ({ api, own }) => {
            expect422(await refuse(api, own.spec, profileBody(ownName('wf22-c'), { recipientType: type, internal: true })), 'Cannot send internal notification to recipient of type None, Default or Object');
        });
    }

    test('a profile with neither an instance nor internal notification is refused', rowMeta('d', 'Notification instance and/or internal notification is required'), async ({ api, own }) => {
        expect422(await refuse(api, own.spec, profileBody(ownName('wf22-d'), { recipientType: 'owner', internal: false })), 'Notification instance and/or internal notification is required');
    });

    test('a profile without a recipient type is refused', rowMeta('e', 'Recipient type is required'), async ({ api, own }) => {
        const body = profileBody(ownName('wf22-e'), { recipientType: 'owner', internal: true });
        delete body.recipientType;
        expect422(await refuse(api, own.spec, body), 'Recipient type is required');
    });

    test('a blank name is refused and the list names the name property', rowMeta('f', 'name must not be blank'), async ({ api, own }) => {
        expect422(await refuse(api, own.spec, profileBody('', { recipientType: 'owner', internal: true })), /name/i);
    });

    test('a frequency that is not whole days and hours is refused', rowMeta('g', 'Frequency can only contain days and hours.'), async ({ api, own }) => {
        expect422(await refuse(api, own.spec, profileBody(ownName('wf22-g'), { recipientType: 'owner', internal: true, frequency: 'PT30M' })), 'Frequency can only contain days and hours.');
    });

    for (const repetitions of [0, -1]) {
        test(`repetitions ${repetitions} is refused`, rowMeta('h', 'must be greater than 0'), async ({ api, own }) => {
            expect422(await refuse(api, own.spec, profileBody(ownName('wf22-h'), { recipientType: 'owner', internal: true, repetitions })), 'must be greater than 0');
        });
    }

    test('an unknown recipient type code and an unknown data category code are refused with 400', rowMeta('i', '400 Unable to read HTTP message'), async ({ api, own }) => {
        // Both are enums on the wire: an unknown code never reaches the service (whose "Unknown … code" texts are for programmatic
        // callers), the message converter fails first and the advice answers 400 `{"message":"Unable to read HTTP message"}`.
        const unknownType = { ...profileBody(ownName('wf22-i1'), { recipientType: 'owner', internal: true }), recipientType: 'bogus' };
        const unknownCategory = profileBody(ownName('wf22-i2'), { recipientType: 'owner', internal: true, categories: ['bogus'] });
        for (const body of [unknownType, unknownCategory]) {
            const sent = await refuse(api, own.spec, body);
            expect(sent.status, `refused with 400: ${sent.text.slice(0, 300)}`).toBe(400);
            expect(sent.json, 'the body is the single-message error').toEqual({ message: 'Unable to read HTTP message' });
        }
    });

    test('an unknown user, group or role uuid is refused with 404 naming the type and the uuid', rowMeta('j', "404 Object of type '<Type>' identified by <uuid> is not found."), async ({ api, own }) => {
        for (const [type, label] of [['user', 'User'], ['group', 'Group'], ['role', 'Role']] as const) {
            const probe = api.probeUuid();
            const sent = await refuse(api, own.spec, profileBody(ownName(`wf22-j-${type}`), { recipientType: type, recipients: [{ uuid: probe }], internal: true }));
            expect(sent.status, sent.text.slice(0, 300)).toBe(404);
            expect(mentions(sent, `Object of type '${label}' identified by ${probe} is not found.`), JSON.stringify(sent.json)).toBe(true);
        }
    });

    test('an unknown notification instance uuid is refused with 404', rowMeta('j', "404 Object of type 'NotificationInstanceReference' identified by <uuid> is not found."), async ({ api, own }) => {
        const probe = api.probeUuid();
        const sent = await refuse(api, own.spec, profileBody(ownName('wf22-j-inst'), { recipientType: 'owner', instance: { uuid: probe } }));
        expect(sent.status, sent.text.slice(0, 300)).toBe(404);
        expect(mentions(sent, `Object of type 'NotificationInstanceReference' identified by ${probe} is not found.`), JSON.stringify(sent.json)).toBe(true);
    });

    test('a second profile with the name of an existing one is refused with 409', rowMeta('k', 'Notification profile with name <name> already exists.'), async ({ api, own }) => {
        const group = await createOwnGroup(api, own.spec, 'wf22-k-group');
        const seed = await createOwnInternalProfile(api, own.spec, 'wf22-seed', { recipientType: 'group', recipients: [group] });
        const sent = await probeProfile(api, own.spec, profileBody(seed.name, { recipientType: 'group', recipients: [group], internal: true }));
        expect(sent.status, sent.text.slice(0, 300)).toBe(409);
        expect(errorShapeOf(sent)).toBe('message');
        expect(sent.json.message).toBe(`Notification profile with name ${seed.name} already exists.`);
        expect(await recordNamed(api, 'profiles', seed.name, own.spec), 'exactly the seed profile carries the name').toEqual([seed.uuid]);
    });

    test('a null entry in eventDataCategories is refused', rowMeta('l', 'Event data categories must not contain null entries'), async ({ api, own }) => {
        const body = { ...profileBody(ownName('wf22-l'), { recipientType: 'owner', internal: true }), eventDataCategories: [null] };
        const sent = await refuse(api, own.spec, body);
        expect(sent.status, sent.text.slice(0, 300)).toBe(422);
        expect(errorShapeOf(sent)).toBe('array');
    });

    test('with an instance, a USER profile without recipients is still refused and the instance is accepted', rowMeta('d', 'instance accepted, recipients still required', ['email-provider']), async ({ api, own }) => {
        const connector = await findNotificationConnector(api, 'EMAIL');
        expect(connector, 'the e-mail notification connector the declared need resolved').toBeTruthy();
        const instance = await createOwnInstance(api, own.spec, 'wf22-inst', { connector: connector!, attributes: emailAttributes(await instanceDefinitions(api, connector!), { sender: reservedSender(), subject: 'QA API-WFL-22', template: EMAIL_TEMPLATE }) });
        expect422(await refuse(api, own.spec, profileBody(ownName('wf22-inst-user'), { recipientType: 'user', instance })), RECIPIENT_REQUIRED);
    });
});
