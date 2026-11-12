/**
 * Unit tests of the RA-profile schema helpers: the required attributes of a schema, the authority order and the
 * lazy choice of an authority with a required attribute. No environment, no network.
 */
import { expect, test } from '@playwright/test';
import { authorityCandidates, chooseAuthorityWithRequiredAttribute, requiredRaProfileAttributes } from '../../utils/regression/inventory/raProfileSchema';

test.describe.configure({ timeout: 60_000 });

test('RA-profile helpers (pure): required attributes of a schema, the authority order, the lazy choice', async () => {
    const schema = [
        { type: 'data', name: 'a', contentType: 'string', properties: { label: 'A', required: true, readOnly: false, visible: true } },
        { type: 'data', name: 'b', contentType: 'object', properties: { label: 'B', required: true, list: true } },
        { type: 'data', name: 'c', contentType: 'string', properties: { label: 'C', required: false } },
        { type: 'data', name: 'd', contentType: 'string', properties: { label: 'D', required: true, readOnly: true } },
        { type: 'data', name: 'e', contentType: 'string', properties: { label: 'E', required: true, visible: false } },
        { type: 'info', name: 'f', contentType: 'string', properties: { label: 'F', required: true } },
        { type: 'data', name: 'g', contentType: 'string', properties: { required: true }, attributeCallback: { callbackMethod: 'x' } },
    ];
    expect(requiredRaProfileAttributes(schema)).toEqual([
        { name: 'a', label: 'A', contentType: 'string', select: false },
        { name: 'b', label: 'B', contentType: 'object', select: true },
        { name: 'g', label: 'g', contentType: 'string', select: true },
    ]);
    expect(requiredRaProfileAttributes(undefined)).toEqual([]);

    const authorities = [
        { uuid: 'u1', name: 'one', status: 'connected' },
        { uuid: 'u2', name: 'two', status: 'disconnected' },
        { uuid: 'u3', name: 'three', status: 'connected' },
        { uuid: 'u4', name: 'own', status: 'connected' },
    ];
    expect(authorityCandidates(authorities).map((a) => a.uuid)).toEqual(['u1', 'u3', 'u4']);
    expect(authorityCandidates(authorities, 'u4').map((a) => a.uuid), 'the run\'s own first').toEqual(['u4', 'u1', 'u3']);
    expect(authorityCandidates(authorities, 'u2').map((a) => a.uuid), 'an own authority that is not connected is still tried first').toEqual(['u2', 'u1', 'u3', 'u4']);
    const asked: string[] = [];
    const schemas: Record<string, unknown[] | undefined> = { u1: [], u3: schema, u4: schema };
    const choice = await chooseAuthorityWithRequiredAttribute(authorities, async (uuid) => { asked.push(uuid); return schemas[uuid] as never; });
    expect(choice).toMatchObject({ uuid: 'u3', name: 'three' });
    expect(asked, 'schemas are read lazily, one at a time, never a disconnected authority\'s').toEqual(['u1', 'u3']);
    expect(await chooseAuthorityWithRequiredAttribute(authorities, async () => undefined)).toBeUndefined();
});
