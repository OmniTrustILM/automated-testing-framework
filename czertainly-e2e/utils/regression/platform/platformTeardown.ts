/**
 * platformTeardown — the teardown handlers of the platform objects (entities, locations, secrets, vault profiles,
 * vault instances, compliance profiles). The registry (runTeardown HANDLER_MODULES) loads this module; each removal
 * proves the object's absence afterwards.
 */
import type { TeardownHandler } from '../teardown/runTeardown';
import { deleteAndVerify, removeComplianceProfile } from '../teardown/teardownHandlers';

const parent = (line: { parents?: Record<string, string | string[]> }, key: string): string | undefined => {
    const v = line.parents?.[key];
    return Array.isArray(v) ? v[0] : v;
};

export const teardownHandlers: Record<string, TeardownHandler> = {
    secrets: {
        action: 'delete (DELETE /secrets/{uuid}), absence proven by GET /secrets/{uuid}',
        async remove(ctx, line) {
            await deleteAndVerify(ctx, { uuid: line.uuid, what: `secret ${line.uuid}`, detailUrl: `/api/v1/secrets/${line.uuid}` });
        },
    },
    vaultProfiles: {
        action: 'delete (DELETE /vaults/{vault}/vaultProfiles/{uuid}), absence proven by the same detail URL',
        async remove(ctx, line) {
            const vault = parent(line, 'vault') ?? ctx.live?.vaultInstanceUuid ?? ctx.live?.vaultUuid;
            if (!vault) throw new Error(`vault profile ${line.uuid}: no vault known (ledger parents or detail)`);
            await deleteAndVerify(ctx, { uuid: line.uuid, what: `vault profile ${line.uuid}`, detailUrl: `/api/v1/vaults/${vault}/vaultProfiles/${line.uuid}` });
        },
    },
    vaultInstances: {
        action: 'delete (DELETE /vaults/{uuid}), absence proven by GET /vaults/{uuid}',
        async remove(ctx, line) {
            await deleteAndVerify(ctx, { uuid: line.uuid, what: `vault instance ${line.uuid}`, detailUrl: `/api/v1/vaults/${line.uuid}` });
        },
    },
    complianceProfiles: {
        action: 'read associations, remove the own RA profiles\' associations (DELETE /v2/complianceProfiles/{uuid}/associations/raProfiles/{ra}), DELETE /v1/complianceProfiles/{uuid}; on a refusal DELETE /v2/complianceProfiles/force [uuid] (BulkActionMessageDto list checked); absence by GET /v1/complianceProfiles/{uuid}',
        async remove(ctx, line) {
            await removeComplianceProfile(ctx, line.uuid);
        },
    },
    locations: {
        action: 'delete (DELETE /entities/{entity}/locations/{uuid}), absence proven by the same detail URL',
        async remove(ctx, line) {
            const entity = parent(line, 'entity') ?? ctx.live?.entityInstanceUuid;
            if (!entity) throw new Error(`location ${line.uuid}: no entity known (ledger parents or detail)`);
            await deleteAndVerify(ctx, { uuid: line.uuid, what: `location ${line.uuid}`, detailUrl: `/api/v1/entities/${entity}/locations/${line.uuid}` });
        },
    },
    entities: {
        action: 'delete (DELETE /entities/{uuid}), absence proven by GET /entities/{uuid}',
        async remove(ctx, line) {
            await deleteAndVerify(ctx, { uuid: line.uuid, what: `entity ${line.uuid}`, detailUrl: `/api/v1/entities/${line.uuid}` });
        },
    },
};
