import { APIRequestContext, APIResponse } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { artifactDir } from './env';

/**
 * Thin wrapper over the ILM admin API. Every call authenticates with the administrator
 * certificate in the ssl-client-cert header, the same way the provisioning script does.
 */
export class AdminApi {
  constructor(private readonly request: APIRequestContext) {}

  async raw(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', apiPath: string, body?: unknown): Promise<APIResponse> {
    const url = `/api${apiPath}`;
    switch (method) {
      case 'GET':
        return this.request.get(url);
      case 'POST':
        return this.request.post(url, body === undefined ? {} : { data: body });
      case 'PATCH':
        return this.request.patch(url, body === undefined ? {} : { data: body });
      case 'PUT':
        return this.request.put(url, body === undefined ? {} : { data: body });
      case 'DELETE':
        return this.request.delete(url, body === undefined ? {} : { data: body });
    }
  }

  private async json<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', apiPath: string, body?: unknown): Promise<T> {
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

  /** POST .../list style endpoints that answer with a paginated envelope. */
  async listItems<T>(apiPath: string, itemsPerPage = 1000): Promise<T[]> {
    const response = await this.post<{ items?: T[] }>(apiPath, { itemsPerPage, pageNumber: 1, filters: [] });
    return response.items ?? [];
  }

  listSigningProfiles(): Promise<SigningProfileListItem[]> {
    return this.listItems<SigningProfileListItem>('/v1/signingProfiles/list');
  }

  listTspProfiles(): Promise<TspProfileListItem[]> {
    return this.listItems<TspProfileListItem>('/v1/tspProfiles/list');
  }

  getSigningProfile(uuid: string): Promise<SigningProfileDetail> {
    return this.get<SigningProfileDetail>(`/v1/signingProfiles/${uuid}`);
  }

  getTspProfile(uuid: string): Promise<TspProfileDetail> {
    return this.get<TspProfileDetail>(`/v1/tspProfiles/${uuid}`);
  }

  getCertificate(uuid: string): Promise<CertificateDetail> {
    return this.get<CertificateDetail>(`/v1/certificates/${uuid}`);
  }

  async listSigningRecords(itemsPerPage = 200): Promise<SigningRecordListItem[]> {
    const response = await this.post<{ signingRecords?: SigningRecordListItem[]; items?: SigningRecordListItem[] }>(
      '/v1/signingRecords',
      { itemsPerPage, pageNumber: 1, filters: [] },
    );
    return response.signingRecords ?? response.items ?? [];
  }

  /**
   * Writes trusted anchors and untrusted intermediates to separate OpenSSL inputs.
   * The chain is fetched once per certificate.
   */
  async certificateTrustFiles(uuid: string, label = 'chain'): Promise<CertificateTrustFiles> {
    const cached = AdminApi.trustFilesCache.get(uuid);
    if (cached) return cached;

    const chain = await this.get<{ completeChain: boolean; certificates: CertificateDetail[] }>(
      `/v1/certificates/${uuid}/chain?withEndCertificate=false`,
    );
    if (!chain.completeChain) {
      throw new Error(`Certificate ${uuid} has an incomplete issuer chain in the platform`);
    }
    if (!chain.certificates?.length) {
      throw new Error(`Certificate ${uuid} has no issuer chain in the platform`);
    }

    const anchors = chain.certificates.filter((certificate) => certificate.trustedCa);
    if (anchors.length === 0) {
      throw new Error(`Certificate ${uuid} has no trusted anchor in its issuer chain`);
    }
    const intermediates = chain.certificates.filter((certificate) => !certificate.trustedCa);
    const dir = artifactDir(label);
    const caFile = path.join(dir, `${uuid}.ca.pem`);
    fs.writeFileSync(caFile, anchors.map((certificate) => toPem(certificate.certificateContent)).join(''));

    let untrustedFile: string | undefined;
    if (intermediates.length > 0) {
      untrustedFile = path.join(dir, `${uuid}.untrusted.pem`);
      fs.writeFileSync(
        untrustedFile,
        intermediates.map((certificate) => toPem(certificate.certificateContent)).join(''),
      );
    }

    const files = { caFile, untrustedFile };
    AdminApi.trustFilesCache.set(uuid, files);
    return files;
  }

  private static trustFilesCache = new Map<string, CertificateTrustFiles>();
}

export interface CertificateTrustFiles {
  caFile: string;
  untrustedFile?: string;
}

export function toPem(base64Der: string): string {
  const wrapped = base64Der.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
}

export interface SigningProfileListItem {
  uuid: string;
  name: string;
  enabled: boolean;
  signingWorkflowType?: string;
  type?: string;
}

export interface SigningProfileDetail extends SigningProfileListItem {
  signingScheme?: { certificate?: { uuid: string; commonName?: string } };
  tspProfile?: { uuid: string; name: string } | null;
  timeQualityConfiguration?: { uuid: string; name: string } | null;
  [key: string]: unknown;
}

export interface TspProfileListItem {
  uuid: string;
  name: string;
  enabled: boolean;
}

export interface TspProfileDetail extends TspProfileListItem {
  signingProfile?: { uuid: string; name: string } | null;
  [key: string]: unknown;
}

export interface CertificateDetail {
  uuid: string;
  commonName: string;
  serialNumber: string;
  certificateContent: string;
  issuerCertificateUuid?: string;
  validationStatus?: string;
  state?: string;
  trustedCa?: boolean;
  [key: string]: unknown;
}

export interface SigningRecordListItem {
  uuid: string;
  name?: string;
  protocol: string;
  signingProfile: { uuid: string; name: string };
  signingTime: string;
  createdAt: string;
  timestampTokenSerialNumbers: string[];
}
