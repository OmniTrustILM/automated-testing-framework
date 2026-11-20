/**
 * EST-110 — a request pending approval survives a Core restart.
 *
 * WHAT: a request on an RA Profile with an approval profile answers 202; Core is restarted; once
 * it is back, the request is approved through the API, an identical retry returns the
 * certificate, exactly one certificate exists for it, and the synchronous CA still issues.
 *
 * WHY: a client may poll for hours; the pending request lives in the database, not in Core's
 * memory, and the retry must still find it after a deployment or crash.
 *
 * HOW: runs as the last Playwright project (see the EST config), since every Core pod is replaced.
 * The restart deletes the Core pods and waits for their successors to be ready, then for the EST
 * endpoint to answer, through KUBECONFIG_PATH or the in-cluster account; it skips without either.
 * Only Core restarts: the connectors, including the in-memory sync CA, keep running.
 */

import { APIRequestContext, expect, test } from '@playwright/test';
import { EstEnv } from '../../utils/estEnv';
import { estRequest } from '../../utils/estHttp';
import { approve, getCertificateApprovals } from '../../utils/estFixtures';
import {
  certificateHasKey,
  enrolledCertificate,
  findCertificatesByCommonName,
  simpleEnroll,
} from '../../utils/estEnroll';
import { EstSuite } from '../../utils/estSuite';
import { createCsr } from '../../utils/estPki';
import { CORE_PODS, restartPods } from '../../utils/estCluster';
import { waitForCertificateState } from '../../utils/certificateUtils';
import { getCoreApi } from '../../utils/k8sClient';

const READY_TIMEOUT_MS = 300_000;

test.describe('@est restart', () => {
  const suite = new EstSuite();
  let env: EstEnv;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    ({ env, api } = await suite.open());
    test.skip(!process.env.KUBERNETES_SERVICE_HOST && !env.kubeconfigPath, 'KUBECONFIG_PATH is not set');
  });
  test.afterAll(() => suite.close());

  const client = (suffix: string, raProfileUuid: string) => suite.raBasicClient(suffix, raProfileUuid);

  const commonName = (prefix: string) => suite.uniqueCommonName(prefix);

  /** Polls the EST endpoint until Core answers it again. */
  async function waitForEst(label: string): Promise<void> {
    await expect
      .poll(async () => (await estRequest({ baseUrl: env.baseUrl, label, op: 'cacerts' }).catch(() => undefined))?.status, {
        timeout: READY_TIMEOUT_MS,
        intervals: [2000],
      })
      .toBe(200);
  }

  test('EST-110 a request pending approval is answered after a Core restart, and the sync CA still issues', async () => {
    test.setTimeout(READY_TIMEOUT_MS * 2);
    const approval = await client('restart-approval', env.approvalRaProfileUuid);
    const sync = await client('restart-sync', env.raProfileUuid);
    const { credentials } = await approval.nextEnrollment();
    const cn = commonName('restart');
    const csr = createCsr({ subject: cn });
    const request = { baseUrl: env.baseUrl, label: approval.profile.name, csr, ...credentials };
    expect((await simpleEnroll(request)).status).toBe(202);

    await restartPods(getCoreApi(), CORE_PODS, { timeoutMs: READY_TIMEOUT_MS });
    await waitForEst(approval.profile.name);

    const [certificateUuid, ...others] = await findCertificatesByCommonName(api, cn);
    expect(others).toHaveLength(0);
    const approvals = await getCertificateApprovals(api, certificateUuid);
    expect(approvals).toHaveLength(1);
    await approve(api, approvals[0].approvalUuid);
    await waitForCertificateState(api, certificateUuid, 'issued');
    const der = enrolledCertificate(await simpleEnroll(request));
    expect(certificateHasKey(der, csr.key)).toBe(true);
    expect(await findCertificatesByCommonName(api, cn)).toEqual([certificateUuid]);

    const syncEnrollment = await sync.nextEnrollment();
    const syncCn = commonName('restart-sync');
    const syncCsr = createCsr({ subject: syncCn });
    const issued = enrolledCertificate(
      await simpleEnroll({ baseUrl: env.baseUrl, label: sync.profile.name, csr: syncCsr, ...syncEnrollment.credentials }),
    );
    expect(certificateHasKey(issued, syncCsr.key)).toBe(true);
  });
});
