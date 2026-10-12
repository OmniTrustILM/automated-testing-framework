import { AdminApi } from './adminApi';
import { AttributeDefinition, definitionNamed, requestAttribute } from './attributes';
import { config, NamedUuid } from './env';

/** The vault and vault profile the suite keeps its token PIN in carry this name. */
const SUITE_NAME = 'key-onboarding';

/** The token and its profile are named after the token they address. A changed configuration then gets a token of its own. */
const TOKEN_NAME = `${SUITE_NAME}-${config.pkcs11Profile}-${config.pkcs11Token}`;

const SECRET_ACTIVATION_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

interface ConnectorItem {
  uuid: string;
  name: string;
  url: string;
  version: string;
  status: string;
  interfaces: Array<{ uuid: string; code: string; features?: string[] }>;
}

interface Named {
  uuid: string;
  name: string;
  enabled?: boolean;
}

async function connectorAt(api: AdminApi, name: string, url: string): Promise<ConnectorItem> {
  const find = async () =>
    (await api.listItems<ConnectorItem>('/v2/connectors/list')).find(
      (connector) => connector.url === url && connector.version === 'v2',
    );
  let connector = await find();
  if (!connector) {
    const uniqueName = `${name}@${new URL(url).host}`;
    await api.post('/v2/connectors', { name: uniqueName, url, authType: 'none', customAttributes: [], version: 'v2' });
    connector = await find();
  }
  if (!connector) {
    throw new Error(`Connector at ${url} was registered but is not listed`);
  }
  if (connector.status === 'waitingForApproval') {
    await api.patch(`/v2/connectors/${connector.uuid}/approve`);
  }
  return connector;
}

function interfaceOf(connector: ConnectorItem, code: string): { uuid: string; features?: string[] } {
  const found = connector.interfaces.find((candidate) => candidate.code === code);
  if (!found) {
    throw new Error(`Connector ${connector.name} exposes no '${code}' interface`);
  }
  return found;
}

function named<T extends Named>(items: T[], name: string): T | undefined {
  return items.find((item) => item.name === name);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function uriNamesToken(uri: string, label: string): boolean {
  const pathAttributes = uri.replace(/^pkcs11:/, '').split('?')[0].split(';');
  return pathAttributes.some((attribute) => attribute.startsWith('token=') && decodeURIComponent(attribute.slice('token='.length)) === label);
}

async function vaultProfile(api: AdminApi): Promise<{ vault: NamedUuid; profile: NamedUuid }> {
  const connector = await connectorAt(api, 'common-credential-provider-v2', config.vaultConnectorUrl);
  let vault = named(await api.listItems<Named>('/v1/vaults/list'), SUITE_NAME);
  if (!vault) {
    vault = await api.post<Named>('/v1/vaults', {
      connectorUuid: connector.uuid,
      interfaceUuid: interfaceOf(connector, 'secret').uuid,
      name: SUITE_NAME,
      attributes: [],
      customAttributes: [],
    });
  }
  const vaultUuid = vault.uuid;
  const profiles = await api.listItems<Named & { vaultInstance: { uuid: string } }>('/v1/vaultProfiles/list');
  let profile: Named | undefined = profiles.find(
    (candidate) => candidate.name === SUITE_NAME && candidate.vaultInstance.uuid === vaultUuid,
  );
  if (!profile) {
    profile = await api.post<Named>(`/v1/vaults/${vaultUuid}/vaultProfiles`, {
      name: SUITE_NAME,
      description: '',
      attributes: [],
      customAttributes: [],
    });
  }
  if (!profile.enabled) {
    await api.patch(`/v1/vaults/${vaultUuid}/vaultProfiles/${profile.uuid}/enable`);
  }
  return { vault: { name: vault.name, uuid: vaultUuid }, profile: { name: profile.name, uuid: profile.uuid } };
}

async function pinSecret(api: AdminApi): Promise<NamedUuid> {
  const name = `${TOKEN_NAME}-pin`;
  let secret = named(await api.listItems<Named>('/v1/secrets'), name);
  if (!secret) {
    const { vault, profile } = await vaultProfile(api);
    secret = await api.post<Named>(`/v1/vaults/${vault.uuid}/vaultProfiles/${profile.uuid}/secrets`, {
      name,
      description: 'PKCS#11 token user PIN',
      secret: { type: 'generic', content: config.tokenPin },
      attributes: [],
      customAttributes: [],
    });
  }
  const deadline = Date.now() + SECRET_ACTIVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await api.get<{ state: string; enabled: boolean }>(`/v1/secrets/${secret.uuid}`);
    if (current.state === 'active' && current.enabled) {
      return { name, uuid: secret.uuid };
    }
    if (current.state === 'active') {
      await api.patch(`/v1/secrets/${secret.uuid}/enable`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Secret ${name} did not become active and enabled within ${SECRET_ACTIVATION_TIMEOUT_MS} ms`);
}

/** The token is addressed by the connector's config profile, the PKCS#11 URI of a token it offers, and the PIN secret. */
async function tokenAttributes(api: AdminApi, connector: ConnectorItem, pin: NamedUuid) {
  const definitions = await api.get<AttributeDefinition[]>(`/v1/tokens/${connector.uuid}/attributes`);
  const profile = requestAttribute(definitionNamed(definitions, 'profile'), [{ data: config.pkcs11Profile }]);
  const tokenDefinition = definitionNamed(definitions, 'token');
  const offered = await api.post<Array<{ data: string; reference?: string }>>(`/v2/connectors/${connector.uuid}/callback`, {
    name: tokenDefinition.name,
    uuid: tokenDefinition.uuid,
    interfaceUuid: interfaceOf(connector, 'cryptography').uuid,
    attributes: [profile],
  });
  const matches = offered.filter((item) => uriNamesToken(item.data, config.pkcs11Token));
  if (matches.length !== 1) {
    throw new Error(`Profile ${config.pkcs11Profile} offers ${matches.length} tokens labelled ${config.pkcs11Token}`);
  }
  const token = requestAttribute(tokenDefinition, [{ data: matches[0].data, reference: matches[0].reference }]);
  const pinAttribute = requestAttribute(definitionNamed(definitions, 'pin'), [
    { data: { resource: 'secrets', uuid: pin.uuid, name: pin.name } },
  ]);
  return [profile, token, pinAttribute];
}

/** The suite's token on the PKCS#11 connector, and an enabled token profile under it. */
export async function provisionToken(api: AdminApi): Promise<{ token: NamedUuid; tokenProfile: NamedUuid }> {
  const connector = await connectorAt(api, 'pkcs11-cryptography-provider', config.pkcs11ConnectorUrl);
  if (!interfaceOf(connector, 'cryptography').features?.includes('keyList')) {
    throw new Error(`Connector ${connector.name} does not advertise the keyList feature`);
  }
  let token = named(await api.get<Named[]>('/v1/tokens'), TOKEN_NAME);
  if (!token) {
    const pin = await pinSecret(api);
    token = await api.post<Named>('/v1/tokens', {
      name: TOKEN_NAME,
      connectorUuid: connector.uuid,
      attributes: await tokenAttributes(api, connector, pin),
      customAttributes: [],
    });
  }
  const tokenUuid = token.uuid;
  const profiles = await api.get<Array<Named & { tokenInstanceUuid: string }>>('/v1/tokenProfiles');
  let profile: Named | undefined = profiles.find(
    (candidate) => candidate.name === TOKEN_NAME && candidate.tokenInstanceUuid === tokenUuid,
  );
  if (!profile) {
    profile = await api.post<Named>(`/v1/tokens/${tokenUuid}/tokenProfiles`, {
      name: TOKEN_NAME,
      description: '',
      attributes: [],
      customAttributes: [],
      usage: ['sign', 'verify', 'encrypt', 'decrypt'],
    });
  }
  if (!profile.enabled) {
    await api.patch(`/v1/tokens/${tokenUuid}/tokenProfiles/${profile.uuid}/enable`);
  }
  return { token: { name: token.name, uuid: tokenUuid }, tokenProfile: { name: profile.name, uuid: profile.uuid } };
}
