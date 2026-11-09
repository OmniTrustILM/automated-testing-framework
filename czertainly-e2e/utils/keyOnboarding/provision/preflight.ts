/**
 * preflight — does this tier have what the key onboarding block builds on? Read-only; the block never registers or approves a connector.
 * `offlineBlocker` decides without a request, `runnerBlocker` asks the runner only (docker locally; on a shared tier the pinned cluster,
 * kubectl, the pod and exec rights and one running sidecar pod), `preflight` reads the platform. A reason names the variable, never the value.
 */
import { Logger } from '../../Logger';
import { isLocalTier } from '../../regression/tier/kind';
import { hasLocalProof } from '../../regression/tier/localProof';
import { Admin, TierError } from '../../devBlocks/provision/transport';
import { registerCallbackTarget } from '../../regression/guard/callbackTargets';
import type { GuardedApi } from '../../regression/guard/types';
import { AttributeDefinition, requestAttribute } from '../attributes';
import type { KeyOnboardingConfig } from '../config';
import type { NamedUuid } from '../types';
import { defaultDockerRunner, DockerRunner, dockerAvailable, sidecarRunning } from './docker';
import { mayDeleteOwn } from '../../regression/ledger/ownership';
import { runId as currentRun } from '../../regression/ledger/runState';
import { isDryRun } from '../../regression/run/flags';
import { findUuidsInBody } from '../../regression/guard/bodies';
import { canI, clusterKubectl, connectorTargetProblem, KubectlRunner, kubectlAvailable, sidecarPod } from './kubectl';
import { runLabelPrefix } from './plant';

type Json = Record<string, any>;

const logger = new Logger('KeyOnboardingSetup');

export type RequestAttribute = ReturnType<typeof requestAttribute>;

export interface ConnectorRef extends NamedUuid {
    interfaceUuid: string;
}

export interface Prerequisites {
    pkcs11: ConnectorRef;
    vault: ConnectorRef;
    tokenForm: { profile: RequestAttribute; token: RequestAttribute; pin: AttributeDefinition };
}

export type PreflightResult = { status: 'ok'; prerequisites: Prerequisites } | { status: 'unavailable'; reason: string };

export function offlineBlocker(cfg: KeyOnboardingConfig, env: NodeJS.ProcessEnv = process.env, runId: string = currentRun()): string | undefined {
    if (isLocalTier(env) && !hasLocalProof(env)) {
        return 'no authenticated local-backend proof for this run (API-GEN-33[guard] in the snapshot project must run first): planting with docker needs a proven local stack';
    }
    if (!cfg.tokenPin) return 'KO_TOKEN_PIN is not set: the token\'s user PIN has no default';
    if (!/^[\x20-\x7e]+$/.test(cfg.tokenPin)) {
        return 'KO_TOKEN_PIN has a character outside printable ASCII: the scrubber of the logs covers printable ASCII PINs only; use another PIN';
    }
    if (pinLooksLikeAnId(cfg.tokenPin)) {
        return 'KO_TOKEN_PIN has a shape the guard reads as an object id (a uuid or a 24-character base64 value) in the PIN secret\'s body: its refusal would quote it; use another PIN';
    }
    const prefix = runLabelPrefix(runId);
    if (typeof prefix !== 'string') return `the run could not remove the key pairs it plants: ${prefix.refused}`;
    if (!mayDeleteOwn(env)) return 'the run could not remove the key pairs it plants: API_DELETE_OWN is off (a hand-set REG_RUN_ID turns it off unless API_DELETE_OWN=1)';
    if (isDryRun(env)) return 'the run could not remove the key pairs it plants: API_TEARDOWN_DRY_RUN is on';
    return undefined;
}

/** Whether the guard would read the PIN as an object id in the PIN secret's body (and then name it in its refusal). */
export function pinLooksLikeAnId(pin: string): boolean {
    const found = findUuidsInBody({ name: 'x', description: '', secret: { type: 'generic', content: pin }, attributes: [], customAttributes: [] });
    return found.canonical.length > 0 || found.nonCanonical.length > 0;
}

export interface RunnerTools {
    docker?: DockerRunner;
    kubectl?: KubectlRunner;
}

export async function runnerBlocker(cfg: KeyOnboardingConfig, tools: RunnerTools = {}, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
    if (cfg.mode === 'cluster') {
        const kubectl = clusterKubectl(tools.kubectl, env);
        if ('reason' in kubectl) return kubectl.reason;
        const target = connectorTargetProblem(cfg.pkcs11ConnectorUrl, cfg.kube);
        if (target) return target;
        const ns = cfg.kube.namespace;
        if (!(await kubectlAvailable(kubectl))) return 'kubectl is not available on the runner (planting key pairs on a shared tier execs into the SoftHSM sidecar)';
        if (!(await canI(kubectl, 'get', 'pods', ns)) || !(await canI(kubectl, 'list', 'pods', ns))) {
            return 'the runner may not get and list pods in the namespace KO_KUBE_NAMESPACE names (gitops#56 grants it on develop-01)';
        }
        if (!(await canI(kubectl, 'create', 'pods/exec', ns)) || !(await canI(kubectl, 'get', 'pods/exec', ns))) {
            return 'the runner may not exec into pods in the namespace KO_KUBE_NAMESPACE names (kubectl auth can-i create / get pods/exec: no; gitops#56 grants it on develop-01)';
        }
        const found = await sidecarPod(kubectl, cfg.kube);
        return 'reason' in found ? found.reason : undefined;
    }
    const docker = tools.docker ?? defaultDockerRunner(env);
    if (!(await dockerAvailable(docker))) return 'docker is not available on the runner (planting key pairs on the token needs a docker daemon)';
    if (!(await sidecarRunning(docker, cfg.sidecarContainer))) return 'the SoftHSM sidecar container KO_SIDECAR_CONTAINER names is not running';
    return undefined;
}

const interfaceOf = (row: Json, code: string): Json | undefined => ((row.interfaces ?? []) as Json[]).find((i) => i.code === code);

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

function definitionNamed(defs: AttributeDefinition[], name: string, form: string): AttributeDefinition {
    const def = defs.find((d) => d.name === name);
    if (!def?.uuid) {
        logger.warn(`the ${form} offers: ${defs.map((d) => d.name).join(', ') || 'nothing'}`);
        throw new TierError(`the ${form} offers no attribute '${name}' (the offered ones are in the setup log)`);
    }
    return def;
}

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

/** The token form: the profile item, and the token item the `token` callback offers, which must name exactly one token. */
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

export async function discoverConnectors(admin: Admin, cfg: KeyOnboardingConfig): Promise<{ pkcs11: ConnectorRef; vault: ConnectorRef } | { reason: string }> {
    const rows = await admin.listItems<Json>('/v2/connectors/list');

    const pkcs11Row = connectorAt(rows, cfg.pkcs11ConnectorUrl, 'PKCS#11 cryptography-provider', 'KO_PKCS11_CONNECTOR_URL');
    if (typeof pkcs11Row === 'string') return { reason: pkcs11Row };
    const cryptography = interfaceOf(pkcs11Row, 'cryptography');
    if (!cryptography?.uuid || !((cryptography.features ?? []) as string[]).includes('keyList')) {
        logger.warn(`the PKCS#11 connector's interfaces: ${JSON.stringify(pkcs11Row.interfaces ?? [])}`);
        return { reason: 'the PKCS#11 connector at KO_PKCS11_CONNECTOR_URL does not advertise the keyList feature on its cryptography interface' };
    }
    const pkcs11: ConnectorRef = { name: String(pkcs11Row.name ?? ''), uuid: String(pkcs11Row.uuid), interfaceUuid: String(cryptography.uuid) };

    const vaultRow = connectorAt(rows, cfg.vaultConnectorUrl, 'credential-provider', 'KO_VAULT_CONNECTOR_URL');
    if (typeof vaultRow === 'string') return { reason: vaultRow };
    const secret = interfaceOf(vaultRow, 'secret');
    if (!secret?.uuid) return { reason: 'the credential-provider connector at KO_VAULT_CONNECTOR_URL exposes no secret interface' };
    const vault: ConnectorRef = { name: String(vaultRow.name ?? ''), uuid: String(vaultRow.uuid), interfaceUuid: String(secret.uuid) };
    return { pkcs11, vault };
}

export async function preflight(admin: Admin, cfg: KeyOnboardingConfig, tools: RunnerTools, env: NodeJS.ProcessEnv, api: GuardedApi, runId: string = currentRun()): Promise<PreflightResult> {
    const unavailable = (reason: string): PreflightResult => ({ status: 'unavailable', reason });
    const blocked = offlineBlocker(cfg, env, runId) ?? (await runnerBlocker(cfg, tools, env));
    if (blocked) return unavailable(blocked);
    try {
        const found = await discoverConnectors(admin, cfg);
        if ('reason' in found) return unavailable(found.reason);
        const { pkcs11, vault } = found;
        // The only pre-existing object an attribute callback of this setup may name: the connector just found (the guard's POST_CALLBACK rule).
        registerCallbackTarget(api, 'connector', pkcs11.uuid);
        const form = await tokenForm(admin, cfg, pkcs11);
        if (typeof form === 'string') return unavailable(form);
        return { status: 'ok', prerequisites: { pkcs11, vault, tokenForm: form } };
    } catch (e) {
        if (e instanceof TierError) return unavailable(`preflight: ${e.message}`);
        throw e;
    }
}
