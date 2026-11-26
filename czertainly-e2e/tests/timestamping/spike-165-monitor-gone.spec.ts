/**
 * SPIKE ONLY (ATF#165, branch spike/165-throwaway-ilm): answers the issue's question "does Core stop issuing qualified
 * timestamps while the time-quality monitor is gone, and recover afterwards?" on the throw-away kind ILM. Not for main.
 *
 * WHAT: the same checks as test 50's "time-quality monitor gone" case, for the leading family: qualified issuance
 * before, a refusal naming the time source during the outage, non-qualified issuance during it, qualified issuance and
 * the configured accuracy after it.
 *
 * HOW: test 50 stops the monitor's docker container and runs on a local stack only (describeLocalOnly). Here the
 * monitor is a sidecar in Core's pod, so the outage is `spec.core.timeQualityMonitor.enabled: false` on the Platform
 * (the operator recreates Core's pod without it), and the recovery is `true`. Each switch recreates Core, so the waits
 * include Core's own downtime. Timings are printed.
 */
import { getCustomObjectsApi } from '../../utils/k8sClient';
import { waitFor } from '../../utils/timestamping/docker';
import { expect, test } from '../../utils/timestamping/fixtures';
import { isoDurationToMicroseconds } from '../../utils/timestamping/openssl';
import { provisionedFamilies } from '../../utils/timestamping/provisioning';
import { devTests } from '../../utils/timestamping/tags';
import { describeOutcome, requestTimestamp, TimestampOutcome } from '../../utils/timestamping/tsp';

async function monitor(enabled: boolean): Promise<void> {
  await getCustomObjectsApi().patchNamespacedCustomObject({
    group: 'otilm.com', version: 'v1alpha1', namespace: 'ilm', plural: 'platforms', name: 'ilm',
    body: [{ op: 'add', path: '/spec/core/timeQualityMonitor/enabled', value: enabled }],
  });
}

const seconds = (since: number) => Math.round((Date.now() - since) / 1000);

test('spike #165: qualified timestamps stop while the time-quality monitor is gone and resume when it returns', devTests({ slow: true }), async ({ tsp, ts }) => {
  test.setTimeout(1_200_000);
  const [family] = provisionedFamilies();
  const qualified = family.qualified.signingProfile.name;
  const nonQualified = family.nonQualified.signingProfile.name;
  const accuracy = isoDurationToMicroseconds(ts.timeQuality.accuracy);
  const ask = (label: string, profileName: string): Promise<TimestampOutcome> =>
    requestTimestamp(tsp, { label, profileName }).catch((e) => ({ httpStatus: 0, error: String(e) }) as unknown as TimestampOutcome);

  const baseline = await waitFor(() => ask('monitor-gone-baseline', qualified), (o) => o.reply?.granted === true, 120_000, 5000);
  expect(baseline.reply?.granted, `qualified issuance before the outage: ${describeOutcome(baseline)}`).toBe(true);

  try {
    let t = Date.now();
    await monitor(false);
    const degraded = await waitFor(() => ask('monitor-gone-degraded', qualified), (o) => o.reply?.granted === false, 480_000, 5000);
    console.log(`monitor off: first qualified refusal after ${seconds(t)} s (${describeOutcome(degraded)})`);
    expect(degraded.reply?.granted, `qualified issuance during the outage: ${describeOutcome(degraded)}`).toBe(false);
    expect(`${degraded.reply?.failureInfo ?? ''} ${degraded.reply?.statusDescription ?? ''}`.toLowerCase(),
      'the rejection names the time source as the reason').toMatch(/time/);

    const plain = await ask('monitor-gone-non-qualified', nonQualified);
    expect(plain.reply?.granted, `non-qualified issuance must survive the outage: ${describeOutcome(plain)}`).toBe(true);

    t = Date.now();
    await monitor(true);
    const recovered = await waitFor(() => ask('monitor-gone-recovered', qualified), (o) => o.reply?.granted === true, 600_000, 5000);
    console.log(`monitor on: first qualified grant after ${seconds(t)} s (${describeOutcome(recovered)})`);
    expect(recovered.reply?.granted, `qualified issuance after recovery: ${describeOutcome(recovered)}`).toBe(true);
    expect(recovered.reply?.accuracyMicroseconds, 'configured accuracy is stated again').toBe(accuracy);
  } finally {
    await monitor(true).catch(() => undefined);
  }
});
