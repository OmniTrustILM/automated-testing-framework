import { APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { artifactDir, basicCredentialFor } from './env';
import { buildTimestampQuery, Digest, parseTimestampReply, ReplyInfo } from './openssl';

export type TspRoute = 'signing' | 'tsp';

export interface TimestampRequestOptions {
  /** Artifact folder name; keeps the request and response bytes of every case on disk. */
  label: string;
  profileName: string;
  route?: TspRoute;
  digest?: Digest;
  nonce?: boolean;
  certReq?: boolean;
  policyOid?: string | null;
  content?: string;
  /** Basic credentials; null username sends no Authorization header at all. */
  username?: string | null;
  password?: string;
  /** Raw request body, bypassing query generation (malformed-request cases). */
  body?: Buffer;
  contentType?: string;
  accept?: string;
  /** GET sends no body. */
  method?: 'POST' | 'GET' | 'PUT';
}

export interface TimestampOutcome {
  httpStatus: number;
  contentType: string;
  dir: string;
  queryPath?: string;
  dataPath?: string;
  responsePath?: string;
  responseLength: number;
  /** Response headers, names lower-cased. */
  headers: Record<string, string>;
  reply?: ReplyInfo;
}

export function tspUrl(route: TspRoute, profileName: string): string {
  return route === 'tsp'
    ? `/api/v1/protocols/tsp/${profileName}`
    : `/api/v1/protocols/tsp/signingProfiles/${profileName}`;
}

/**
 * Issues one TSP request and captures everything about it. The TSP endpoints answer HTTP 200
 * with an in-band PKIStatus for both success and rejection, so callers assert on `reply`,
 * not on the status code — except for authentication failures, which are plain HTTP.
 */
export async function requestTimestamp(
  request: APIRequestContext,
  options: TimestampRequestOptions,
): Promise<TimestampOutcome> {
  const dir = artifactDir(options.label);
  const credentials = basicCredentialFor(options.profileName);

  let body: Buffer;
  let queryPath: string | undefined;
  let dataPath: string | undefined;

  if (options.body) {
    body = options.body;
    fs.writeFileSync(path.join(dir, 'query.raw'), body);
  } else {
    const built = buildTimestampQuery({
      dir,
      content: options.content,
      digest: options.digest,
      nonce: options.nonce,
      certReq: options.certReq,
      policyOid: options.policyOid,
    });
    queryPath = built.queryPath;
    dataPath = built.dataPath;
    body = fs.readFileSync(queryPath);
  }

  const headers: Record<string, string> = {
    'Content-Type': options.contentType ?? 'application/timestamp-query',
  };
  const username = options.username === undefined ? credentials.username : options.username;
  if (username !== null) {
    const password = options.password ?? credentials.password;
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  if (options.accept) {
    headers.Accept = options.accept;
  }

  const method = options.method ?? 'POST';
  const response = await request.fetch(tspUrl(options.route ?? 'signing', options.profileName), {
    method,
    headers,
    data: method === 'GET' ? undefined : body,
  });

  const outcome: TimestampOutcome = {
    httpStatus: response.status(),
    contentType: response.headers()['content-type'] ?? '',
    dir,
    queryPath,
    dataPath,
    responseLength: 0,
    headers: response.headers(),
  };

  const responseBody = await response.body();
  outcome.responseLength = responseBody.length;
  if (responseBody.length > 0) {
    const responsePath = path.join(dir, 'response.tsr');
    fs.writeFileSync(responsePath, responseBody);
    outcome.responsePath = responsePath;
    if (outcome.httpStatus === 200) {
      outcome.reply = parseTimestampReply(responsePath);
    }
  }
  return outcome;
}

/** Compact one-line description used in assertion messages. */
export function describeOutcome(outcome: TimestampOutcome): string {
  const reply = outcome.reply;
  return [
    `HTTP ${outcome.httpStatus}`,
    reply ? `status=${reply.status}` : 'no parsable reply',
    reply?.failureInfo ? `failureInfo=${reply.failureInfo}` : '',
    reply?.statusDescription ? `description=${reply.statusDescription}` : '',
    `artifacts=${outcome.dir}`,
  ]
    .filter(Boolean)
    .join(' ');
}
