/**
 * estClientRunner — runs Cisco libest's `estclient` in Docker against the EST edge.
 *
 * WHAT: builds the `docker run` arguments for one estclient operation, runs it, and reads what it
 * wrote: the certs-only PKCS#7 of a certificate and the PKCS#8 of a server-generated key.
 * WHY: the suite's own requests prove the protocol as the specs read it; a real client proves the
 * platform interoperates with what devices actually run.
 * HOW: a work directory on the host is mounted at `/work`, holding the edge CA (estclient refuses
 * an untrusted server) and any key, certificate or CSR the operation uses; outputs land there too.
 * A local edge name (`localhost`, `.localhost` or `.test`) is mapped to the Docker host, where such an
 * edge listens; any other host name is left to Docker's DNS, and an IP address needs no mapping, so an
 * edge on a loopback address is not supported (the container's own loopback is not the host's). estclient exits 0
 * even when the server refuses, so callers judge the result by the files it wrote, never by the
 * exit code alone. `exec` is passed in so the runner can be tested without Docker.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { decodeBase64Body } from './estHttp';
import { parseCertsOnlyDer } from './estPki';

export const WORK = '/work';
export const EDGE_CA_FILE = 'edge-ca.crt';

export interface EstclientRun {
  image: string;
  baseUrl: string;
  /** Host directory mounted at /work; must already hold EDGE_CA_FILE. */
  workDir: string;
  /** estclient arguments after the server and port, with paths under /work. */
  args: string[];
}

export interface EstclientResult {
  code: number;
  output: string;
  /** True when the run was killed for outliving its timeout. */
  timedOut?: boolean;
}

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<EstclientResult>;

// Well below the test timeout of playwright.est.config.ts, so a hung run is stopped before the test is.
const RUN_TIMEOUT_MS = 60_000;

/** Whether the host is a name for this machine or reserved for local use (RFC 6761); an IP address is not. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test');
}

/** The container's name, unique per run, so a timed-out run can be stopped by name. */
function containerName(): string {
  return `estclient-${crypto.randomBytes(6).toString('hex')}`;
}

export function estclientDockerArgs(run: EstclientRun, name = containerName()): string[] {
  const url = new URL(run.baseUrl);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return [
    'run',
    '--rm',
    '--name',
    name,
    ...(isLocalHost(hostname) ? ['--add-host', `${hostname}:host-gateway`] : []),
    '-v',
    `${run.workDir}:${WORK}`,
    '-e',
    `EST_OPENSSL_CACERT=${WORK}/${EDGE_CA_FILE}`,
    run.image,
    '-s',
    hostname,
    '-p',
    url.port || '443',
    ...run.args,
  ];
}

const execDocker: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      // A non-zero exit carries its code; a failure to start (no docker) carries a string such as ENOENT.
      const exitCode: unknown = error?.code;
      const code = error ? (typeof exitCode === 'number' ? exitCode : 1) : 0;
      const timedOut = error?.killed === true;
      resolve({ code, output: `${stdout}${stderr}${timedOut ? `\nestclient timed out after ${timeoutMs} ms` : ''}`, timedOut });
    });
  });

/** Runs estclient; a run that outlives the timeout is killed and its named container stopped. */
export async function runEstclient(run: EstclientRun, exec: Exec = execDocker, timeoutMs = RUN_TIMEOUT_MS): Promise<EstclientResult> {
  const name = containerName();
  const result = await exec('docker', estclientDockerArgs(run, name), timeoutMs);
  if (result.timedOut) {
    // Killing the docker CLI leaves the container running.
    await exec('docker', ['stop', '--time', '5', name], 30_000);
  }
  return result;
}

/** A fresh work directory holding the edge CA. */
export function createWorkDir(parent: string, edgeCaPath: string): string {
  const dir = fs.mkdtempSync(path.join(parent, 'estclient-'));
  fs.copyFileSync(edgeCaPath, path.join(dir, EDGE_CA_FILE));
  return dir;
}

/** The one certificate estclient wrote to `cert-0-0.pkcs7` (base64 certs-only) in the output directory. */
export function readEstclientCertificate(outDir: string): Buffer {
  const file = path.join(outDir, 'cert-0-0.pkcs7');
  if (!fs.existsSync(file)) throw new Error(`estclient wrote no certificate in ${outDir}`);
  const certificates = parseCertsOnlyDer(decodeBase64Body(fs.readFileSync(file)));
  if (certificates.length !== 1) throw new Error(`estclient wrote ${certificates.length} certificates`);
  return certificates[0];
}

/** Every certificate of the CA certificates estclient wrote to `cacert-0-0.pkcs7`. */
export function readEstclientCaCertificates(outDir: string): Buffer[] {
  const file = path.join(outDir, 'cacert-0-0.pkcs7');
  if (!fs.existsSync(file)) throw new Error(`estclient wrote no CA certificates in ${outDir}`);
  return parseCertsOnlyDer(decodeBase64Body(fs.readFileSync(file)));
}

/** The PKCS#8 DER of the server-generated key estclient wrote to `key-*` (base64) in the output directory. */
export function readEstclientKey(outDir: string): Buffer {
  const name = fs.readdirSync(outDir).find((file) => file.startsWith('key-'));
  if (!name) throw new Error(`estclient wrote no key in ${outDir}`);
  return decodeBase64Body(fs.readFileSync(path.join(outDir, name)));
}
