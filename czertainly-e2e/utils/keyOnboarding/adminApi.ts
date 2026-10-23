/**
 * adminApi — the admin API of the key onboarding specs.
 *
 * WHAT: `AdminApi` (raw / get / post / patch, token key listing, onboarding, key creation and removal, certificate upload,
 * the key custom attribute) and the response types the specs read.
 * WHY: the specs were written against this class; keeping its method names keeps their bodies unchanged.
 * HOW: ported from the developers' suite; it wraps `GuardedApi` instead of a client-certificate context (the framework
 * authenticates, and the guard judges ownership). Objects the platform creates are recorded by the caller right after
 * the answer: `keyCustomAttribute` hands the new attribute's uuid to `onCreated`, `uploadCertificate` records through
 * the framework's own-certificate helper.
 */
import type { APIResponse } from '@playwright/test';
import type { GuardedApi } from '../regression/guard/types';
import { uploadOwnCertificate } from '../regression/ownCertificates';
import { AttributeDefinition, definitionNamed, offered, requestAttribute } from './attributes';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** The connector's listing limit, which bounds every page of token keys Core serves. */
export const MAX_TOKEN_KEYS_PER_PAGE = 1000;

const LIST_PAGE_SIZE = 1000;

const CREATED_KEY_PAIR = { algorithm: 'ECDSA', curve: 'P-256' };

const WHOLE_KEY: string[] = [];

const COMPROMISE_REASON = 'disclosure';

/** Calls the ILM API through the guarded API of the regression framework (identity and ownership rules are the guard's). */
export class AdminApi {
  constructor(private readonly request: GuardedApi) {}

  async raw(method: Method, apiPath: string, body?: unknown): Promise<APIResponse> {
    const url = `/api${apiPath}`;
    const options = body === undefined ? {} : { data: body };
    switch (method) {
      case 'GET':
        return this.request.get(url);
      case 'POST':
        return this.request.post(url, options);
      case 'PATCH':
        return this.request.patch(url, options);
      case 'PUT':
        return this.request.put(url, options);
      case 'DELETE':
        return this.request.delete(url, options);
    }
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

  removeKeyFromInventory(keyUuid: string): Promise<APIResponse> {
    return this.raw('PATCH', `/v1/keys/${keyUuid}/removeFromInventory`);
  }

  removeKeysFromInventory(keyUuids: string[]): Promise<BulkActionMessage[]> {
    return this.patch<BulkActionMessage[]>('/v1/keys/removeFromInventory', keyUuids);
  }

  async compromiseKey(keyUuid: string): Promise<void> {
    await this.patch<void>(`/v1/keys/${keyUuid}/compromise`, { reason: COMPROMISE_REASON });
  }

  /**
   * Uploads a certificate (base64-encoded DER), which brings its public key into the inventory as a key of its own. The
   * framework helper records the certificate (its common name `name` carries the run prefix) and the key Core linked to it.
   */
  async uploadCertificate(certificate: string, name: string, spec: string): Promise<CertificateDetail> {
    const wrapped = certificate.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
    const pem = `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
    const { uuid } = await uploadOwnCertificate(this.request, pem, name, spec, 'uploaded certificate carrying a planted public key', []);
    return this.get<CertificateDetail>(`/v1/certificates/${uuid}`);
  }

  /**
   * Creates the key custom attribute of this run as an optional text attribute, hands its uuid to `onCreated` right after
   * the answer (the caller records it), and returns its definition. A pre-existing attribute is never read or enabled.
   */
  async keyCustomAttribute(name: string, onCreated: (uuid: string) => void): Promise<AttributeDefinition> {
    const created = await this.post<{ uuid: string }>('/v1/attributes/custom', {
      name,
      label: name,
      contentType: 'string',
      resources: ['keys'],
    });
    onCreated(created.uuid);
    return definitionNamed(await this.get<AttributeDefinition[]>('/v1/attributes/custom/resources/keys'), name);
  }
}

export interface TokenKey {
  keyHandle?: string;
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
    | 'noUniqueId';
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
  keyHandle: string;
  name?: string;
}

export interface OnboardingResult {
  keyHandle: string;
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
