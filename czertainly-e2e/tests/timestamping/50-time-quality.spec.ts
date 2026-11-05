import { APIRequestContext } from '@playwright/test';
import { describeLocalOnly } from '../../utils/regression/tier/localProof';
import { timestampingConfig } from '../../utils/timestamping/config';
import { containerState, DOCKER, dockerAvailable, startContainer, stopContainer, waitFor, waitForContainerState } from '../../utils/timestamping/docker';
import { expect, test } from '../../utils/timestamping/fixtures';
import { isoDurationToMicroseconds } from '../../utils/timestamping/openssl';
import { provisionedFamilies, readSummary } from '../../utils/timestamping/provisioning';
import { devTests } from '../../utils/timestamping/tags';
import { describeOutcome, requestTimestamp, TimestampOutcome } from '../../utils/timestamping/tsp';

/** Time quality gates the qualified profile only: degraded time must not stop the non-qualified one and must stop the qualified one. */
describeLocalOnly(test);

test.describe('time quality @slow', { tag: [...devTests({ slow: true, disruptive: true }).tag, DOCKER] }, () => {
  test.describe.configure({ timeout: 480_000 });
  test.skip(!timestampingConfig().allowDisruption, 'disruptive: set TSA_ALLOW_DISRUPTION=true');
  test.skip(() => !dockerAvailable(), 'docker is not available');

  const outageContainers = [timestampingConfig().containers.ntp, timestampingConfig().containers.timeQualityMonitor];

  async function qualifiedStopsAndResumes(
    tsp: APIRequestContext,
    container: string,
    labelBase: string,
    expectedAccuracy: number,
  ): Promise<void> {
    const families = provisionedFamilies();
    const [leading] = families;
    const qualified = leading.qualified.signingProfile.name;

    for (const family of families) {
      const baseline = await requestTimestamp(tsp, {
        label: `${labelBase}-baseline-${family.label}`,
        profileName: family.qualified.signingProfile.name,
      });
      expect(
        baseline.reply?.granted,
        `${family.label} qualified issuance before the outage: ${describeOutcome(baseline)}`,
      ).toBe(true);
    }

    try {
      stopContainer(container);
      const stoppedState = await waitForContainerState(container, ['exited', 'missing'], 60_000);
      expect(stoppedState, `the ${container} container is stopped`).not.toBe('healthy');

      const degraded = await waitFor(
        () => requestTimestamp(tsp, { label: `${labelBase}-degraded`, profileName: qualified }),
        (outcome) => outcome.reply?.granted === false,
        180_000,
        5000,
      );
      expect(degraded.reply?.granted, `qualified issuance during the outage: ${describeOutcome(degraded)}`).toBe(false);
      expect(
        `${degraded.reply?.failureInfo ?? ''} ${degraded.reply?.statusDescription ?? ''}`.toLowerCase(),
        'the rejection names the time source as the reason',
      ).toMatch(/time/);

      // The platform has noticed by now, so any other qualified profile must already refuse.
      for (const family of families.slice(1)) {
        const alsoDegraded = await requestTimestamp(tsp, {
          label: `${labelBase}-degraded-${family.label}`,
          profileName: family.qualified.signingProfile.name,
        });
        expect(
          alsoDegraded.reply?.granted,
          `${family.label} qualified issuance during the outage: ${describeOutcome(alsoDegraded)}`,
        ).toBe(false);
      }

      for (const family of families) {
        const plain = await requestTimestamp(tsp, {
          label: `${labelBase}-degraded-non-qualified-${family.label}`,
          profileName: family.nonQualified.signingProfile.name,
        });
        expect(
          plain.reply?.granted,
          `${family.label} non-qualified issuance must survive the outage: ${describeOutcome(plain)}`,
        ).toBe(true);
      }
    } finally {
      startContainer(container);
    }

    const health = await waitForContainerState(container, ['healthy'], 180_000);
    expect(health, `the ${container} container is healthy again`).toBe('healthy');

    const recovered = await waitFor(
      () => requestTimestamp(tsp, { label: `${labelBase}-recovered`, profileName: qualified }),
      (outcome) => outcome.reply?.granted === true,
      180_000,
      5000,
    );
    expect(recovered.reply?.granted, `qualified issuance after recovery: ${describeOutcome(recovered)}`).toBe(true);
    expect(recovered.reply?.accuracyMicroseconds, 'configured accuracy is stated again').toBe(expectedAccuracy);

    for (const family of families.slice(1)) {
      const alsoRecovered = await requestTimestamp(tsp, {
        label: `${labelBase}-recovered-${family.label}`,
        profileName: family.qualified.signingProfile.name,
      });
      expect(
        alsoRecovered.reply?.granted,
        `${family.label} qualified issuance after recovery: ${describeOutcome(alsoRecovered)}`,
      ).toBe(true);
      expect(
        alsoRecovered.reply?.accuracyMicroseconds,
        `${family.label} states the configured accuracy again`,
      ).toBe(expectedAccuracy);
    }
  }

  test('qualified timestamps stop while the NTP source is gone and resume when it returns', devTests({ slow: true, disruptive: true }), async ({ tsp, ts }) => {
    await qualifiedStopsAndResumes(tsp, timestampingConfig().containers.ntp, 'time-quality', isoDurationToMicroseconds(ts.timeQuality.accuracy));
  });

  test('qualified timestamps stop while the time-quality monitor is gone and resume when it returns', devTests({ slow: true, disruptive: true }), async ({
    tsp,
    ts,
  }) => {
    await qualifiedStopsAndResumes(
      tsp,
      timestampingConfig().containers.timeQualityMonitor,
      'time-quality-monitor',
      isoDurationToMicroseconds(ts.timeQuality.accuracy),
    );
  });

  // Whatever happened above, the next spec file must find an environment that can issue qualified timestamps.
  test.afterAll(async ({ tsp }) => {
    if (!timestampingConfig().allowDisruption || !dockerAvailable() || readSummary().status !== 'ready') return;
    const [leading] = provisionedFamilies();
    for (const container of outageContainers) {
      if (containerState(container) !== 'healthy') {
        startContainer(container);
        await waitForContainerState(container, ['healthy'], 180_000);
      }
    }
    const restored: TimestampOutcome = await waitFor(
      () =>
        requestTimestamp(tsp, {
          label: 'time-quality-restore',
          profileName: leading.qualified.signingProfile.name,
        }),
      (outcome) => outcome.reply?.granted === true,
      180_000,
      5000,
    );
    expect(
      restored.reply?.granted,
      `the environment was left unable to issue qualified timestamps: ${describeOutcome(restored)}`,
    ).toBe(true);
  });
});
