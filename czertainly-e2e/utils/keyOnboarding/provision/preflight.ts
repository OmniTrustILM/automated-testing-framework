/**
 * preflight — does this tier have what the key onboarding block builds on? Read-only.
 *
 * WHAT: `offlineBlocker` decides without a request and without docker (a shared tier, no local-backend proof for this
 * run, no KO_TOKEN_PIN); `runnerBlocker` asks docker only (a daemon answers, the sidecar KO_SIDECAR_CONTAINER names is
 * running); `preflight` then reads the platform: the PKCS#11 connector (v2) at KO_PKCS11_CONNECTOR_URL, connected,
 * with the `keyList` feature on its cryptography interface; the credential-provider connector (v2) at
 * KO_VAULT_CONNECTOR_URL, connected, with a `secret` interface; and the token KO_PKCS11_TOKEN among the tokens the
 * connector's profile KO_PKCS11_PROFILE offers (the token form's callback), resolved here so a tier without that token
 * gets no object created.
 * WHY: the source suite registered and approved the connectors it did not find; the block never does (create-only):
 * a missing or unapproved connector is a precise reason, the specs skip with it.
 * HOW: connectors are matched by URL and version as the source suite did (`POST /v2/connectors/list`). Every request
 * goes through `Admin` (guarded); a TierError of any read becomes the `unavailable` reason, a SetupError propagates.
 * A reason names the variable a value came from, never the value; the tier's own lists go to the log only.
 */
import { Logger } from '../../Logger';
import { isLocalTier } from '../../regression/tier/kind';
import { hasLocalProof } from '../../regression/tier/localProof';
import { Admin, TierError } from '../../devBlocks/provision/transport';
import { AttributeDefinition, requestAttribute } from '../attributes';
import type { KeyOnboardingConfig } from '../config';
import type { NamedUuid } from '../types';
import { DockerRunner, dockerAvailable, sidecarRunning } from './docker';

type Json = Record<string, any>;

const logger = new Logger('KeyOnboardingSetup');

export type RequestAttribute = ReturnType<typeof requestAttribute>;

export interface ConnectorRef extends NamedUuid {
    /** The uuid of the interface the block uses (`cryptography` on the PKCS#11 connector, `secret` on the vault one). */
    interfaceUuid: string;
}

export interface Prerequisites {
    pkcs11: ConnectorRef;
    vault: ConnectorRef;
    /** The token form of the PKCS#11 connector: the profile and token items, and the PIN definition the secret fills. */
    tokenForm: { profile: RequestAttribute; token: RequestAttribute; pin: AttributeDefinition };
}

export type PreflightResult = { status: 'ok'; prerequisites: Prerequisites } | { status: 'unavailable'; reason: string };

/** Why the block cannot run here, decided without a request and without docker; undefined when the checks may go on. */
export function offlineBlocker(cfg: KeyOnboardingConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!isLocalTier(env)) {
        return 'not a local stack (TIER_KIND is not local): no shared tier has the PKCS#11 connector with a SoftHSM token, and planting key pairs needs docker next to the stack';
    }
    if (!hasLocalProof(env)) {
        return 'no authenticated local-backend proof for this run (API-GEN-33[guard] in the snapshot project must run first): the setup\'s requests need localStack on a proven local stack';
    }
    if (!cfg.tokenPin) return 'KO_TOKEN_PIN is not set: the token\'s user PIN has no default';
    return undefined;
}

/** Why the runner cannot plant key pairs (docker only, no platform request); undefined when it can. */
export async function runnerBlocker(cfg: KeyOnboardingConfig, docker: DockerRunner): Promise<string | undefined> {
    if (!(await dockerAvailable(docker))) return 'docker is not available on the runner (planting key pairs on the token needs a docker daemon)';
    if (!(await sidecarRunning(docker, cfg.sidecarContainer))) return 'the SoftHSM sidecar container KO_SIDECAR_CONTAINER names is not running';
    return undefined;
}

const interfaceOf = (row: Json, code: string): Json | undefined => ((row.interfaces ?? []) as Json[]).find((i) => i.code === code);

/** The connected v2 connector at `url`; a registered one that is not connected, or none, is the reason. */
function connectorAt(rows: Json[], url: string, what: string, variable: string): Json | string {
    const candidates = rows.filter((c) => c.url === url && c.version === 'v2');
    const connected = candidates.find((c) => c.status === 'connected');
    if (connected) return connected;
    if (!candidates.length) {
        logger.warn(`no v2 connector is registered at ${url}; the registered ones: ${rows.map((c) => `${c.name} ${c.url} ${c.version}`).join(', ') || 'none'}`);
        return `no ${what} connector (v2) is registered at ${variable} (the setup never registers one)`;
    }
    const first = candidates[0];
    logger.warn(`the ${what} connector at ${url} is '${first.name}' (${first.uuid}), status ${first.status}`);
    if (first.status === 'waitingForApproval') {
        return `the ${what} connector at ${variable} is waiting for approval (the setup never approves a connector; approve it on the local stack and re-run)`;
    }
    return `the ${what} connector at ${variable} is ${first.status ?? 'in an unknown state'}, not connected`;
}

/** A definition of the connector's form by name, or a TierError naming it (what was offered goes to the log). */
function definitionNamed(defs: AttributeDefinition[], name: string, form: string): AttributeDefinition {
    const def = defs.find((d) => d.name === name);
    if (!def?.uuid) {
        logger.warn(`the ${form} offers: ${defs.map((d) => d.name).join(', ') || 'nothing'}`);
        throw new TierError(`the ${form} offers no attribute '${name}' (the offered ones are in the setup log)`);
    }
    return def;
}

/** True when a PKCS#11 URI's path names the token `label` (`pkcs11:…;token=<label>;…`, percent-decoded). */
export function uriNamesToken(uri: string, label: string): boolean {
    const pathAttributes = uri.replace(/^pkcs11:/, '').split('?')[0].split(';');
    return pathAttributes.some((attribute) => {
        if (!attribute.startsWith('token=')) return false;
        try {
            return decodeURIComponent(attribute.slice('token='.length)) === label;
        } catch {
            return false;
        }
    });
}

/**
 * The token form (`GET /v1/tokens/{connector}/attributes`): the profile item with KO_PKCS11_PROFILE, and the token item
 * the `token` callback offers for that profile, which must name exactly one token labelled KO_PKCS11_TOKEN.
 */
async function tokenForm(admin: Admin, cfg: KeyOnboardingConfig, pkcs11: ConnectorRef): Promise<Prerequisites['tokenForm'] | string> {
    const form = 'token form of the PKCS#11 connector';
    const defs = await admin.get<AttributeDefinition[]>(`/v1/tokens/${pkcs11.uuid}/attributes`);
    const profile = requestAttribute(definitionNamed(defs ?? [], 'profile', form), [{ data: cfg.pkcs11Profile }]);
    const tokenDef = definitionNamed(defs ?? [], 'token', form);
    const pin = definitionNamed(defs ?? [], 'pin', form);
    const { body: offered } = await admin.request<Array<{ data: string; reference?: string }>>('POST', `/v2/connectors/${pkcs11.uuid}/callback`, {
        name: tokenDef.name,
        uuid: tokenDef.uuid,
        interfaceUuid: pkcs11.interfaceUuid,
        attributes: [profile],
    });
    const matches = (offered ?? []).filter((item) => typeof item?.data === 'string' && uriNamesToken(item.data, cfg.pkcs11Token));
    if (matches.length !== 1) {
        logger.warn(`profile ${cfg.pkcs11Profile} offers ${matches.length} token(s) labelled ${cfg.pkcs11Token}; offered: ${(offered ?? []).map((o) => String(o?.data)).join(', ') || 'none'}`);
        return `the profile KO_PKCS11_PROFILE names offers ${matches.length} tokens labelled as KO_PKCS11_TOKEN says (exactly one is needed; the offered ones are in the setup log)`;
    }
    const token = requestAttribute(tokenDef, [{ data: matches[0].data, ...(matches[0].reference !== undefined ? { reference: matches[0].reference } : {}) }]);
    return { profile, token, pin };
}

/** The read-only preflight; see the file header. */
export async function preflight(admin: Admin, cfg: KeyOnboardingConfig, docker: DockerRunner, env: NodeJS.ProcessEnv = process.env): Promise<PreflightResult> {
    const unavailable = (reason: string): PreflightResult => ({ status: 'unavailable', reason });
    const blocked = offlineBlocker(cfg, env) ?? (await runnerBlocker(cfg, docker));
    if (blocked) return unavailable(blocked);
    try {
        const rows = await admin.listItems<Json>('/v2/connectors/list');

        const pkcs11Row = connectorAt(rows, cfg.pkcs11ConnectorUrl, 'PKCS#11 cryptography-provider', 'KO_PKCS11_CONNECTOR_URL');
        if (typeof pkcs11Row === 'string') return unavailable(pkcs11Row);
        const cryptography = interfaceOf(pkcs11Row, 'cryptography');
        if (!cryptography?.uuid || !((cryptography.features ?? []) as string[]).includes('keyList')) {
            logger.warn(`the PKCS#11 connector's interfaces: ${JSON.stringify(pkcs11Row.interfaces ?? [])}`);
            return unavailable('the PKCS#11 connector at KO_PKCS11_CONNECTOR_URL does not advertise the keyList feature on its cryptography interface');
        }
        const pkcs11: ConnectorRef = { name: String(pkcs11Row.name ?? ''), uuid: String(pkcs11Row.uuid), interfaceUuid: String(cryptography.uuid) };

        const vaultRow = connectorAt(rows, cfg.vaultConnectorUrl, 'credential-provider', 'KO_VAULT_CONNECTOR_URL');
        if (typeof vaultRow === 'string') return unavailable(vaultRow);
        const secret = interfaceOf(vaultRow, 'secret');
        if (!secret?.uuid) return unavailable('the credential-provider connector at KO_VAULT_CONNECTOR_URL exposes no secret interface');
        const vault: ConnectorRef = { name: String(vaultRow.name ?? ''), uuid: String(vaultRow.uuid), interfaceUuid: String(secret.uuid) };

        const form = await tokenForm(admin, cfg, pkcs11);
        if (typeof form === 'string') return unavailable(form);
        return { status: 'ok', prerequisites: { pkcs11, vault, tokenForm: form } };
    } catch (e) {
        if (e instanceof TierError) return unavailable(`preflight: ${e.message}`);
        throw e;
    }
}
