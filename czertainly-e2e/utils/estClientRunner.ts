/**
 * estClientRunner — runs Cisco libest's `estclient` in Docker against the EST edge.
 *
 * WHAT: builds the `docker run` arguments for one estclient operation, runs it, and reads what it
 * wrote: the certs-only PKCS#7 of a certificate and the PKCS#8 of a server-generated key.
 * WHY: the suite's own requests prove the protocol as the specs read it; a real client proves the
 * platform interoperates with what devices actually run.
 * HOW: a work directory on the host is mounted at `/work`, holding the edge CA (estclient refuses
 * an untrusted server) and any key, certificate or CSR the operation uses; outputs land there too.
 * The edge's host name is mapped to the Docker host, where the edge listens. estclient exits 0
 * even when the server refuses, so callers judge the result by the files it wrote, never by the
 * exit code alone. `exec` is passed in so the runner can be tested without Docker.
 */

import { execFile } from 'child_process';
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
}

export type Exec = (file: string, args: string[]) => Promise<EstclientResult>;

export function estclientDockerArgs(run: EstclientRun): string[] {
  const url = new URL(run.baseUrl);
  return [
    'run',
    '--rm',
    '--add-host',
    `${url.hostname}:host-gateway`,
    '-v',
    `${run.workDir}:${WORK}`,
    '-e',
    `EST_OPENSSL_CACERT=${WORK}/${EDGE_CA_FILE}`,
    run.image,
    '-s',
    url.hostname,
    '-p',
    url.port || '443',
    ...run.args,
  ];
}

const execDocker: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      // A non-zero exit carries its code; a failure to start (no docker) carries a string such as ENOENT.
      const exitCode: unknown = error?.code;
      const code = error ? (typeof exitCode === 'number' ? exitCode : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });

export function runEstclient(run: EstclientRun, exec: Exec = execDocker): Promise<EstclientResult> {
  return exec('docker', estclientDockerArgs(run));
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
