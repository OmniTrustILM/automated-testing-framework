/**
 * objects — the run's own platform objects of the key onboarding block, in the source suite's order: the vault
 * instance, the vault profile, the PIN secret, the token on the PKCS#11 connector and its token profile.
 *
 * WHAT: each create sends the source suite's body under a run-prefixed name and is recorded right after it answered:
 * `vaultInstances`, `vaultProfiles` ← vault, `secrets` ← vaultProfile, `tokens`, `tokenProfiles` ← token (the parents
 * the teardown handlers read: platform/platformTeardown.ts, teardown/teardownHandlers.ts).
 * WHY: the source suite found or created fixed-name objects (`key-onboarding`, `key-onboarding-<profile>-<token>`) and
 * kept them between runs; the block creates its own per run and touches nothing else, so the block teardown (and the
 * run-end teardown as the safety net) can delete them. The PIN is KO_TOKEN_PIN: it goes to the vault in the secret's
 * body and nowhere else (no ledger line, no summary, no reason carries it).
 * HOW: enables and the secret's wait come after the ledger line; every failure the tier decides is a TierError.
 */
import type { OwnRef, Ref } from '../../regression/ledger/ledger';
import { TierError } from '../../devBlocks/provision/transport';
import { requestAttribute } from '../attributes';
import { recordOwn, SetupContext, uuidOf } from './context';
import type { ConnectorRef, Prerequisites } from './preflight';

type Json = Record<string, any>;

/** `POST /v1/vaults`: the run's vault instance on the credential provider's secret interface. */
export async function createVaultInstance(ctx: SetupContext, connector: ConnectorRef, name: string): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', '/v1/vaults', {
        connectorUuid: connector.uuid, interfaceUuid: connector.interfaceUuid, name, attributes: [], customAttributes: [],
    });
    return recordOwn('vaultInstances', { uuid: uuidOf(created.body, `vault instance '${name}'`), name }, `key onboarding vault instance on ${connector.name}`, undefined, created.serverAt);
}

/** `POST /v1/vaults/{vault}/vaultProfiles`, then enabled. */
export async function createVaultProfile(ctx: SetupContext, vault: Ref, name: string): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', `/v1/vaults/${vault.uuid}/vaultProfiles`, { name, description: '', attributes: [], customAttributes: [] });
    const ref = recordOwn('vaultProfiles', { uuid: uuidOf(created.body, `vault profile '${name}'`), name }, `key onboarding vault profile under vault ${vault.name}`, { vault: vault.uuid }, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/vaults/${vault.uuid}/vaultProfiles/${ref.uuid}/enable`);
    return ref;
}

/**
 * The token's user PIN as a generic secret; core activates a secret asynchronously once the vault wrote it, so the
 * secret is read until it is active and enabled, and enabled once it is active (the source suite's loop).
 */
export async function createPinSecret(ctx: SetupContext, vault: Ref, vaultProfile: OwnRef, name: string): Promise<OwnRef> {
    const pin = ctx.cfg.tokenPin;
    if (!pin) throw new Error('KO_TOKEN_PIN is not set; the preflight refuses this before any request');
    const created = await ctx.admin.request('POST', `/v1/vaults/${vault.uuid}/vaultProfiles/${vaultProfile.uuid}/secrets`, {
        name,
        description: 'PKCS#11 token user PIN',
        secret: { type: 'generic', content: pin },
        attributes: [],
        customAttributes: [],
    });
    const ref = recordOwn('secrets', { uuid: uuidOf(created.body, `PIN secret '${name}'`), name }, 'key onboarding token PIN secret', { vaultProfile: vaultProfile.uuid }, created.serverAt);
    let last: Json | undefined;
    for (let attempt = 0; attempt < ctx.poll.secretAttempts; attempt++) {
        last = await ctx.admin.get<Json>(`/v1/secrets/${ref.uuid}`);
        const state = String(last?.state ?? '').toLowerCase();
        if (state === 'active' && last?.enabled === true) return ref;
        if (state === 'failed') throw new TierError('the PIN secret is failed (the vault did not store it)');
        if (state === 'active') await ctx.admin.request('PATCH', `/v1/secrets/${ref.uuid}/enable`);
        if (ctx.poll.secretIntervalMs > 0) await new Promise((r) => setTimeout(r, ctx.poll.secretIntervalMs));
    }
    throw new TierError(`the PIN secret is not active and enabled after ${ctx.poll.secretAttempts} reads (last state '${String(last?.state ?? '')}', enabled ${String(last?.enabled)})`);
}

/** `POST /v1/tokens`: the token addressed by the connector's profile, the token URI and the PIN secret. */
export async function createToken(ctx: SetupContext, pre: Prerequisites, pin: OwnRef, name: string): Promise<OwnRef> {
    const { profile, token, pin: pinDef } = pre.tokenForm;
    const pinAttribute = requestAttribute(pinDef, [{ data: { resource: 'secrets', uuid: pin.uuid, name: pin.name } }]);
    const created = await ctx.admin.request('POST', '/v1/tokens', {
        name, connectorUuid: pre.pkcs11.uuid, attributes: [profile, token, pinAttribute], customAttributes: [],
    });
    return recordOwn('tokens', { uuid: uuidOf(created.body, `token '${name}'`), name }, `key onboarding token on ${pre.pkcs11.name}`, undefined, created.serverAt);
}

/** `POST /v1/tokens/{token}/tokenProfiles`: sign / verify / encrypt / decrypt, then enabled. */
export async function createTokenProfile(ctx: SetupContext, token: OwnRef, name: string): Promise<OwnRef> {
    const created = await ctx.admin.request('POST', `/v1/tokens/${token.uuid}/tokenProfiles`, {
        name, description: '', attributes: [], customAttributes: [], usage: ['sign', 'verify', 'encrypt', 'decrypt'],
    });
    const ref = recordOwn('tokenProfiles', { uuid: uuidOf(created.body, `token profile '${name}'`), name }, 'key onboarding token profile', { token: token.uuid }, created.serverAt);
    await ctx.admin.request('PATCH', `/v1/tokens/${token.uuid}/tokenProfiles/${ref.uuid}/enable`);
    return ref;
}
