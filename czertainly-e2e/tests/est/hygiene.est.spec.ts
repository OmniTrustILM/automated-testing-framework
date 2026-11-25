/**
 * EST-100 — no secret or key material in the logs of Core, Kong and ingress-nginx.
 *
 * WHAT: after the other specs, and after an enrollment and a server key generation of its own,
 * scans what Core and the two proxies in front of it logged since the run started for a Basic
 * `Authorization` value, a PEM private key, and this spec's Basic password, Authorization token,
 * the base64 of its CSR and of its own and the server-generated key.
 *
 * WHY: EST carries passwords, certification requests and private keys; a log is kept, shipped and
 * read far more widely than the platform's database, so none of it may land there.
 *
 * HOW: runs as its own Playwright project after every other EST spec (see the EST config), reads
 * the pod logs through KUBECONFIG_PATH or the in-cluster account, and skips without either. The
 * run-specific values are known only for this spec's own traffic; the fixed patterns cover the
 * whole run. A hit names the source, pattern and line, never the line itself.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import * as crypto from 'crypto';
import { EstEnv } from '../../utils/estEnv';
import { enrolledCertificate, sendCsr, simpleEnroll } from '../../utils/estEnroll';
import { createPolicyClient } from '../../utils/estPolicyClients';
import { EstSuite } from '../../utils/estSuite';
import { createCsr, keyToPem } from '../../utils/estPki';
import { serverGeneratedKey } from '../../utils/estServerKeygen';
import { EST_LOG_SOURCES, readLogs } from '../../utils/estCluster';
import { base64Prefix, FIXED_NEEDLES, LogNeedle, scanLogs, secondsSince } from '../../utils/estLogScan';
import { getCoreApi } from '../../utils/k8sClient';
import { Logger } from '../../utils/Logger';

const logger = new Logger('EstHygiene');

/** Scan window when the run's start is unknown, e.g. the spec run on its own with --no-deps. */
const FALLBACK_WINDOW_SECONDS = 3600;

function pkcs8Der(pem: string): Buffer {
  return crypto.createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' });
}

test.describe('@est hygiene', () => {
  const suite = new EstSuite();
  const { undo } = suite;
  let env: EstEnv;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    ({ env, api } = await suite.open());
    test.skip(!process.env.KUBERNETES_SERVICE_HOST && !env.kubeconfigPath, 'KUBECONFIG_PATH is not set');
  });
  test.afterAll(() => suite.close());

  test('EST-100 no Basic credentials, CSR or key material in the Core, Kong and ingress logs', async () => {
    const client = await createPolicyClient(api, env, (step) => undo.push(step), 'raBasic', 'hygiene', { serverKeyGeneration: true });
    const { credentials } = await client.nextEnrollment();
    const { username, password } = credentials.basicAuth as { username: string; password: string };
    const cn = suite.uniqueCommonName('hygiene');
    const request = { baseUrl: env.baseUrl, label: client.profile.name, ...credentials };

    const csr = createCsr({ subject: cn });
    enrolledCertificate(await simpleEnroll({ ...request, csr }));
    const keygenCsr = createCsr({ subject: cn });
    const generated = serverGeneratedKey(await sendCsr('serverkeygen', { ...request, csr: keygenCsr }));

    const needles: LogNeedle[] = [
      ...FIXED_NEEDLES,
      { label: 'Basic password', pattern: password },
      { label: 'Basic Authorization token', pattern: Buffer.from(`${username}:${password}`).toString('base64') },
      { label: 'CSR (base64)', pattern: csr.base64.slice(0, 64) },
      { label: 'server keygen CSR (base64)', pattern: keygenCsr.base64.slice(0, 64) },
      { label: 'client private key (base64)', pattern: base64Prefix(pkcs8Der(keyToPem(csr.key))) },
      { label: 'server-generated key (base64)', pattern: base64Prefix(generated.key) },
    ];
    const window = secondsSince(process.env.EST_RUN_STARTED_AT, new Date(), FALLBACK_WINDOW_SECONDS);
    const logs = await readLogs(getCoreApi(), EST_LOG_SOURCES, window);
    for (const [source, text] of Object.entries(logs)) logger.info(`Scanned ${source}: ${text.split('\n').length} lines`);

    expect(scanLogs(logs, needles)).toEqual([]);
  });
});
