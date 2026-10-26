import { APIRequestContext, APIResponse, request as playwrightRequest } from '@playwright/test';
import { AttributeDefinition, definitionNamed, MetadataAttribute, offered, requestAttribute } from './attributes';
import { adminCertificateHeader, config } from './env';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** The connector's listing limit, which bounds every page of token keys Core serves. */
export const MAX_TOKEN_KEYS_PER_PAGE = 1000;

const LIST_PAGE_SIZE = 1000;

const CREATED_KEY_PAIR = { algorithm: 'ECDSA', curve: 'P-256' };

const WHOLE_KEY: string[] = [];

const COMPROMISE_REASON = 'disclosure';

/** Calls the ILM API with the administrator's client certificate. */
export class AdminApi {
  private constructor(private readonly request: APIRequestContext) {}

  static async open(): Promise<AdminApi> {
    const pfxPath = process.env.ADMIN_CLIENT_P12;
    const authentication = pfxPath
      ? {
          clientCertificates: [
            { origin: new URL(config.ilmHost).origin, pfxPath, passphrase: process.env.ADMIN_CLIENT_P12_PASSWORD },
          ],
        }
      : { extraHTTPHeaders: { 'ssl-client-cert': adminCertificateHeader() } };
    const context = await playwrightRequest.newContext({
      baseURL: config.ilmHost,
      ignoreHTTPSErrors: true,
      ...authentication,
    });
    return new AdminApi(context);
  }

  dispose(): Promise<void> {
    return this.request.dispose();
  }

  raw(method: Method, apiPath: string, body?: unknown): Promise<APIResponse> {
    const options = body === undefined ? {} : { data: body };
    return this.request.fetch(`/api${apiPath}`, { method, ...options });
  }

  private async json<T>(method: Method, apiPath: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, apiPath, body);
    if (!response.ok()) {
      throw new Error(`${method} ${apiPath} failed with HTTP ${response.status()}: ${await response.text()}`);
    }
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  get<T>(apiPath: string): Promise<T> {
    return this.json<T>('GET', apiPath);
  }

  post<T>(apiPath: string, body?: unknown): Promise<T> {
    return this.json<T>('POST', apiPath, body);
  }

  patch<T>(apiPath: string, body?: unknown): Promise<T> {
    return this.json<T>('PATCH', apiPath, body);
  }

  /** Every item of a POST .../list style endpoint, read page by page. */
  async listItems<T>(apiPath: string): Promise<T[]> {
    const items: T[] = [];
    for (let pageNumber = 1; ; pageNumber++) {
      const page = await this.post<{ items?: T[]; totalPages?: number }>(apiPath, {
        itemsPerPage: LIST_PAGE_SIZE,
        pageNumber,
        filters: [],
      });
      items.push(...(page.items ?? []));
      if (pageNumber >= (page.totalPages ?? 1)) return items;
    }
  }

  tokenKeys(tokenUuid: string, profileUuid: string, pageNumber: number, itemsPerPage: number): Promise<TokenKeyPage> {
    return this.get<TokenKeyPage>(
      `/v1/tokens/${tokenUuid}/tokenProfiles/${profileUuid}/tokenKeys?pageNumber=${pageNumber}&itemsPerPage=${itemsPerPage}`,
    );
  }

  /** Every key pair on the token, read page by page. */
  async allTokenKeys(tokenUuid: string, profileUuid: string): Promise<TokenKey[]> {
    const keys: TokenKey[] = [];
    for (let pageNumber = 1; ; pageNumber++) {
      const page = await this.tokenKeys(tokenUuid, profileUuid, pageNumber, MAX_TOKEN_KEYS_PER_PAGE);
      keys.push(...page.items);
      if (pageNumber >= page.totalPages) return keys;
    }
  }

  onboardTokenKeys(
    tokenUuid: string,
    profileUuid: string,
    keys: TokenKeySelection[],
    customAttributes: unknown[] = [],
  ): Promise<OnboardingResults> {
    return this.post<OnboardingResults>(`/v1/tokens/${tokenUuid}/tokenProfiles/${profileUuid}/tokenKeys/onboard`, {
      keys,
      customAttributes,
    });
  }

  /**
   * Creates a key pair on the token through Core. The curve is a child of the key spec group, which Core learns from
   * the callback the key form makes once an algorithm is chosen.
   */
  async createKeyPair(tokenUuid: string, profileUuid: string, name: string): Promise<KeyDetail> {
    const keyPairs = `/v1/tokens/${tokenUuid}/tokenProfiles/${profileUuid}/keys/keyPair`;
    const definitions = await this.get<AttributeDefinition[]>(`${keyPairs}/attributes`);
    const algorithmDefinition = definitionNamed(definitions, 'keyAlgorithm');
    const algorithm = requestAttribute(algorithmDefinition, [offered(algorithmDefinition, CREATED_KEY_PAIR.algorithm)]);
    const keySpec = definitionNamed(definitions, 'keySpec');
    const keySpecDefinitions = await this.post<AttributeDefinition[]>(`/v1/keys/${profileUuid}/callback`, {
      uuid: keySpec.uuid,
      name: keySpec.name,
      attributes: [algorithm],
    });
    const curveDefinition = definitionNamed(keySpecDefinitions, 'ecCurve');
    const curve = requestAttribute(curveDefinition, [offered(curveDefinition, CREATED_KEY_PAIR.curve)]);
    return this.post<KeyDetail>(keyPairs, { name, attributes: [algorithm, curve], customAttributes: [] });
  }

  /** Deletes the key from its token and from the inventory. */
  async deleteKey(keyUuid: string): Promise<void> {
    await this.json<void>('DELETE', `/v1/keys/${keyUuid}`, WHOLE_KEY);
  }

  /** Enables every item of the key. An onboarded key starts disabled. */
  async enableKey(keyUuid: string): Promise<void> {
    await this.patch<void>(`/v1/keys/${keyUuid}/enable`, WHOLE_KEY);
  }

  /** Every key item in the inventory, read page by page. */
  async allKeyItems(): Promise<KeyItemSummary[]> {
    const items: KeyItemSummary[] = [];
    for (let pageNumber = 1; ; pageNumber++) {
      const page = await this.post<KeyItemPage>('/v1/keys', { itemsPerPage: LIST_PAGE_SIZE, pageNumber, filters: [] });
      items.push(...page.cryptographicKeys);
      if (pageNumber >= page.totalPages) return items;
    }
  }

  removeKeyFromInventory(keyUuid: string): Promise<APIResponse> {
    return this.raw('PATCH', `/v1/keys/${keyUuid}/removeFromInventory`);
  }

  removeKeysFromInventory(keyUuids: string[]): Promise<BulkActionMessage[]> {
    return this.patch<BulkActionMessage[]>('/v1/keys/removeFromInventory', keyUuids);
  }

  async compromiseKey(keyUuid: string): Promise<void> {
    await this.patch<void>(`/v1/keys/${keyUuid}/compromise`, { reason: COMPROMISE_REASON });
  }

  /** Uploads a certificate, which brings its public key into the inventory as a key of its own. */
  async uploadCertificate(certificate: string): Promise<CertificateDetail> {
    const { uuid } = await this.post<{ uuid: string }>('/v1/certificates/upload', { certificate, customAttributes: [] });
    return this.get<CertificateDetail>(`/v1/certificates/${uuid}`);
  }

  /** The key custom attribute of this name, created as an optional text attribute when it is missing. */
  async keyCustomAttribute(name: string): Promise<AttributeDefinition> {
    const existing = (await this.get<Array<{ uuid: string; name: string; enabled: boolean }>>('/v1/attributes/custom')).find(
      (candidate) => candidate.name === name,
    );
    if (!existing) {
      await this.post('/v1/attributes/custom', { name, label: name, contentType: 'string', resources: ['keys'] });
    } else if (!existing.enabled) {
      await this.patch(`/v1/attributes/custom/${existing.uuid}/enable`);
    }
    return definitionNamed(await this.get<AttributeDefinition[]>('/v1/attributes/custom/resources/keys'), name);
  }
}

export interface TokenKey {
  keyPairMeta?: MetadataAttribute[];
  label?: string;
  keyAlgorithm: string;
  length?: number | null;
  status:
    | 'onboardable'
    | 'onboardableIntoKey'
    | 'inInventory'
    | 'inInventoryWithoutToken'
    | 'importInProgress'
    | 'noPublicKey'
    | 'noUsableId'
    | 'unsupportedKeyType'
    | 'unreadable'
    | 'gone';
  fingerprint?: string;
  suggestedName?: string;
  inventoryKeyUuid?: string;
  inventoryKeyName?: string;
  reason?: string;
}

export interface TokenKeyPage {
  items: TokenKey[];
  pageNumber: number;
  itemsPerPage: number;
  totalPages: number;
  totalItems: number;
}

export interface TokenKeySelection {
  keyPairMeta: MetadataAttribute[];
  name?: string;
}

export interface OnboardingResult {
  keyPairMeta: MetadataAttribute[];
  onboarded: boolean;
  intoExistingKey: boolean;
  keyUuid?: string;
  keyName?: string;
  reason?: string;
}

export interface OnboardingResults {
  results: OnboardingResult[];
}

export interface KeyItem {
  uuid: string;
  type: 'Public' | 'Private' | 'Secret';
  keyAlgorithm: string;
  length?: number | null;
  keyData?: string;
  state: string;
  enabled: boolean;
  exportable?: boolean;
}

export interface KeyDetail {
  uuid: string;
  name: string;
  owner?: string;
  tokenProfileUuid?: string;
  items: KeyItem[];
  customAttributes?: Array<{ name: string; content?: Array<{ data: unknown }> }>;
  removableFromInventory: boolean;
}

export interface KeyItemSummary {
  uuid: string;
  keyWrapperUuid: string;
  removableFromInventory: boolean;
}

export interface KeyItemPage {
  cryptographicKeys: KeyItemSummary[];
  totalPages: number;
}

export interface CertificateDetail {
  uuid: string;
  commonName: string;
  privateKeyAvailability: boolean;
  key?: { uuid: string; name: string };
}

export interface BulkActionMessage {
  uuid: string;
  name: string;
  message: string;
}
