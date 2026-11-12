/**
 * The resource-type registry against the guard's literal tables. The guard (`guard/routes.ts`, `guard/allowLists.ts`) stays
 * literal and deny-by-default: nothing is generated from the registry. This file proves the two agree: every ledger type the
 * guard names as a target, bulk route type, body reference or created object is a registry type, so it has a teardown step
 * and a proof of ownership (a live read or an id-named ledger line), and every allow-listed create names the registry type
 * it makes. Adding an allow-listed create without naming its type here fails the last test.
 */
import { expect, test } from '@playwright/test';
import { POST_CREATE } from '../../utils/regression/guard/allowLists';
import { BODY_FIELD_TYPES, BULK_ROUTES, LIST_BODY_TYPES, RESOURCE_TYPES, TARGET_TYPES } from '../../utils/regression/guard/routes';
import { ID_NAMED, LIVE_READS } from '../../utils/regression/ledger/ownership';
import { RESOURCE_REGISTRY } from '../../utils/regression/resourceTypes';
import { deleteStepOf } from '../../utils/regression/teardown/runTeardown';

const REGISTERED = new Set<string>(RESOURCE_REGISTRY.map((e) => e.type));

/** The ledger type each allow-listed create path makes (`null`: it creates nothing the suite owns). */
const CREATED_TYPES: Record<string, string | readonly string[] | null> = {
    '/v1/roles': 'roles', '/v1/groups': 'groups', '/v1/users': 'users', '/v1/credentials': 'credentials', '/v1/authorities': 'authorities',
    '/v1/authorities/{id}/raProfiles': 'raProfiles', '/v1/acmeProfiles': 'acmeProfiles', '/v1/scepProfiles': 'scepProfiles', '/v1/cmpProfiles': 'cmpProfiles',
    '/v1/tokens': 'tokens', '/v1/tokens/{id}/tokenProfiles': 'tokenProfiles', '/v1/tokens/{id}/tokenProfiles/{id}/keys/[A-Za-z]+': ['keys', 'keyItems'],
    '/v1/discoveries': 'discoveries', '/v1/attributes/custom': 'customAttributes', '/v1/notificationInstances': 'notificationInstances',
    '/v1/notificationProfiles': 'notificationProfiles', '/v1/workflows/(triggers|rules|conditions|actions|executions)': ['triggers', 'rules', 'conditions', 'actions', 'executions'],
    '/v1/entities': 'entities', '/v1/entities/{id}/locations': 'locations', '/v1/vaults': 'vaultInstances', '/v1/vaults/{id}/vaultProfiles': 'vaultProfiles',
    '/v1/vaults/{id}/vaultProfiles/{id}/secrets': 'secrets', '/v1/complianceProfiles': 'complianceProfiles', '/v1/approvalProfiles': 'approvalProfiles',
    '/v1/connectors': 'connectors', '/v1/certificates/upload': 'certificates', '/v1/certificates/upload/async': 'certificates',
    '/v2/operations/authorities/{id}/raProfiles/{id}/certificates': 'certificates', '/v1/workflows/events': 'eventAssociations',
    '/v1/inspections': null, '/v1/certificates/import': 'certificates', '/v2/operations/authorities/{id}/raProfiles/{id}/certificates/register': 'certificates',
    '/v2/connectors': 'connectors', '/v2/complianceProfiles': 'complianceProfiles',
    '/v1/timeQualityConfigurations': 'timeQualityConfigurations', '/v1/tspProfiles': 'tspProfiles', '/v1/signingProfiles': 'signingProfiles',
};

test('every ledger type the guard names is a registry type with a teardown step and a proof of ownership', () => {
    const named = new Map<string, string>();
    const add = (type: string | null | undefined, where: string) => { if (type) named.set(type, `${named.get(type) ?? ''} ${where}`.trim()); };
    for (const [k, t] of Object.entries(TARGET_TYPES)) add(t, `TARGET_TYPES.${k}`);
    for (const [k, t] of Object.entries(RESOURCE_TYPES)) add(t, `RESOURCE_TYPES.${k}`);
    for (const r of BULK_ROUTES) add(r.type, `BULK_ROUTES ${r.method} ${r.path}`);
    for (const [k, t] of Object.entries(BODY_FIELD_TYPES)) add(t, `BODY_FIELD_TYPES.${k}`);
    for (const r of LIST_BODY_TYPES) add(r.type, `LIST_BODY_TYPES ${r.method} ${r.path}`);
    expect(named.size, 'the guard names ledger types').toBeGreaterThan(30);
    for (const [type, where] of named) {
        expect(REGISTERED.has(type), `${type} (${where}) is a registry type`).toBe(true);
        expect(deleteStepOf(type), `${type} has a teardown step`).toBeLessThan(99);
        expect(Object.hasOwn(LIVE_READS, type) || ID_NAMED.has(type), `${type} has a live read or is id-named`).toBe(true);
    }
});

test('every allow-listed create names the registry type it makes', () => {
    expect([...POST_CREATE].sort(), 'POST_CREATE and the table of this test list the same paths').toEqual(Object.keys(CREATED_TYPES).sort());
    for (const [path, types] of Object.entries(CREATED_TYPES)) {
        for (const type of types === null ? [] : typeof types === 'string' ? [types] : types) {
            expect(REGISTERED.has(type), `${path} makes ${type}, a registry type`).toBe(true);
            expect(deleteStepOf(type), `${type} (made by ${path}) has a teardown step`).toBeLessThan(99);
        }
    }
});
