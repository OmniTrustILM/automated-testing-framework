import { expect, test } from '../utils/fixtures';
import { isoDurationToMicroseconds, ReplyInfo } from '../utils/openssl';
import { describeOutcome, requestTimestamp } from '../utils/tsp';

/**
 * What the two profiles are supposed to differ on. The final test is the guard against a
 * change that quietly stops taking effect: if both profiles produce identical structures,
 * the qualified configuration is being ignored no matter how green the rest looks.
 */
test.describe('token structure', () => {
  let nonQualified: ReplyInfo;
  let qualified: ReplyInfo;
  let expectedAccuracyMicroseconds: number;

  test.beforeAll(async ({ tsp, env }) => {
    const nonQualifiedOutcome = await requestTimestamp(tsp, {
      label: 'structure-non-qualified',
      profileName: env.sets.nonQualified.signingProfile.name,
    });
    const qualifiedOutcome = await requestTimestamp(tsp, {
      label: 'structure-qualified',
      profileName: env.sets.qualified.signingProfile.name,
    });

    expect(nonQualifiedOutcome.reply?.granted, describeOutcome(nonQualifiedOutcome)).toBe(true);
    expect(qualifiedOutcome.reply?.granted, describeOutcome(qualifiedOutcome)).toBe(true);

    nonQualified = nonQualifiedOutcome.reply!;
    qualified = qualifiedOutcome.reply!;
    expectedAccuracyMicroseconds = isoDurationToMicroseconds(env.timeQuality.accuracy);
  });

  test('the qualified token carries qcStatements', () => {
    expect(qualified.hasQcStatements, `TSTInfo extensions were: ${qualified.extensionsText || '(none)'}`).toBe(true);
  });

  test('the non-qualified token carries no qcStatements', () => {
    expect(nonQualified.hasQcStatements, `TSTInfo extensions were: ${nonQualified.extensionsText || '(none)'}`).toBe(
      false,
    );
  });

  test('the qualified token states a concrete accuracy from the time-quality configuration', () => {
    expect(qualified.accuracy, 'accuracy is present').toBeTruthy();
    expect(qualified.accuracySpecified, `accuracy was '${qualified.accuracy}'`).toBe(true);
    expect(qualified.accuracyMicroseconds, 'accuracy matches the provisioned configuration').toBe(
      expectedAccuracyMicroseconds,
    );
  });

  test('the non-qualified token leaves accuracy unspecified', () => {
    expect(nonQualified.accuracySpecified, `accuracy was '${nonQualified.accuracy}'`).toBe(false);
  });

  test('each token states the policy OID of its own profile', ({}, testInfo) => {
    expect(nonQualified.policyOid, 'non-qualified policy OID').not.toBe(qualified.policyOid);
    testInfo.annotations.push({
      type: 'policy-oids',
      description: `non-qualified=${nonQualified.policyOid} qualified=${qualified.policyOid}`,
    });
  });

  test('the two profiles produce structurally different tokens', () => {
    const differences = [
      nonQualified.hasQcStatements !== qualified.hasQcStatements,
      nonQualified.accuracySpecified !== qualified.accuracySpecified,
      nonQualified.policyOid !== qualified.policyOid,
    ].filter(Boolean).length;

    expect(
      differences,
      'qualified and non-qualified tokens are indistinguishable — the qualified configuration is not being applied',
    ).toBeGreaterThanOrEqual(3);
  });

  test('every token is version 1 and non-ordered', () => {
    for (const [label, reply] of [
      ['non-qualified', nonQualified],
      ['qualified', qualified],
    ] as Array<[string, ReplyInfo]>) {
      expect(reply.version, `${label} TSTInfo version`).toBe('1');
      expect(reply.tsa, `${label} token names its TSA`).toBeTruthy();
      expect(reply.ordering?.toLowerCase(), `${label} ordering flag`).toBe('no');
    }
  });
});
