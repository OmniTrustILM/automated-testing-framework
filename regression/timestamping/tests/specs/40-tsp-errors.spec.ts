import { expect, test } from '../utils/fixtures';
import { describeOutcome, requestTimestamp, TimestampOutcome } from '../utils/tsp';

/**
 * How the TSP endpoint behaves when the request is wrong. Two invariants matter beyond the
 * individual cases: a bad request never becomes an HTTP 5xx, and a rejection never tells the
 * caller anything about the platform's internals or about which profiles exist.
 */
test.describe('TSP error paths', () => {
  const INTERNALS = /exception|sql|com\.otilm|hibernate|nullpointer|stacktrace/i;

  function assertNoLeak(outcome: TimestampOutcome): void {
    const text = `${outcome.reply?.statusDescription ?? ''} ${outcome.reply?.failureInfo ?? ''}`;
    expect(INTERNALS.test(text), `rejection text leaks internals: "${text}"`).toBe(false);
  }

  test('a wrong Basic password is refused with HTTP 401', async ({ tsp, env }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'error-wrong-password',
      profileName: env.sets.nonQualified.signingProfile.name,
      password: 'definitely-not-the-password',
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(401);
  });

  test('a request without credentials is refused with HTTP 401', async ({ tsp, env }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'error-no-auth',
      profileName: env.sets.nonQualified.signingProfile.name,
      username: null,
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(401);
  });

  test('an unknown signing profile is refused without reaching the signing engine', async ({ tsp }) => {
    // Basic credentials are stored per TSP profile, so an unroutable name fails
    // authentication before any signing decision is made.
    const outcome = await requestTimestamp(tsp, {
      label: 'error-unknown-signing-profile',
      profileName: 'tsa-does-not-exist',
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(401);
    expect(outcome.responseLength, 'no token is returned').toBe(0);
  });

  test('an unknown TSP profile is refused the same way', async ({ tsp }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'error-unknown-tsp-profile',
      profileName: 'tsp-does-not-exist',
      route: 'tsp',
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(401);
    expect(outcome.responseLength, 'no token is returned').toBe(0);
  });

  test('a disabled signing profile stops issuing and recovers when re-enabled', async ({ admin, tsp, env }) => {
    const set = env.sets.nonQualified;
    await admin.raw('PATCH', `/v1/signingProfiles/${set.signingProfile.uuid}/disable`);
    try {
      const outcome = await requestTimestamp(tsp, {
        label: 'error-disabled-profile',
        profileName: set.signingProfile.name,
      });
      expect(outcome.httpStatus, describeOutcome(outcome)).toBe(200);
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(false);
      assertNoLeak(outcome);
    } finally {
      await admin.raw('PATCH', `/v1/signingProfiles/${set.signingProfile.uuid}/enable`);
    }

    const recovered = await requestTimestamp(tsp, {
      label: 'error-disabled-profile-recovered',
      profileName: set.signingProfile.name,
    });
    expect(recovered.reply?.granted, `re-enabled profile issues again: ${describeOutcome(recovered)}`).toBe(true);
  });

  test('a malformed request body is rejected as bad data, not as a server error', async ({ tsp, env }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'error-malformed-body',
      profileName: env.sets.nonQualified.signingProfile.name,
      body: Buffer.from('this is not a DER encoded TimeStampReq'),
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBeLessThan(500);
    if (outcome.httpStatus === 200) {
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(false);
      assertNoLeak(outcome);
    }
  });

  test('a truncated DER request is rejected without a token', async ({ tsp, env }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'error-truncated-der',
      profileName: env.sets.nonQualified.signingProfile.name,
      body: Buffer.from([0x30, 0x82, 0x01, 0x00, 0x02, 0x01]),
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBeLessThan(500);
    if (outcome.httpStatus === 200) {
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(false);
    }
  });

  test('an authenticated user without the timestamp right is refused', async ({ admin, tsp, env }) => {
    const username = 'regression-unprivileged';
    const password = 'unprivileged-changeme';

    const users = await admin.get<Array<{ uuid: string; username: string }>>('/v1/users');
    let user = users.find((candidate) => candidate.username === username);
    if (!user) {
      user = await admin.post<{ uuid: string; username: string }>('/v1/users', {
        username,
        firstName: 'Regression',
        lastName: 'Unprivileged',
        email: 'regression-unprivileged@example.com',
        enabled: true,
      });
    }

    const tspProfileUuid = env.sets.nonQualified.tspProfile.uuid;
    const credentials = await admin.get<Array<{ username: string }>>(`/v1/tspProfiles/${tspProfileUuid}/basicCredentials`);
    if (!credentials.some((credential) => credential.username === username)) {
      await admin.post(`/v1/tspProfiles/${tspProfileUuid}/basicCredentials`, {
        username,
        password,
        mappedUserUuid: user.uuid,
      });
    }

    const outcome = await requestTimestamp(tsp, {
      label: 'error-unprivileged-user',
      profileName: env.sets.nonQualified.signingProfile.name,
      username,
      password,
    });

    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(200);
    expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(false);
    assertNoLeak(outcome);

    // Enumeration defense: the denial must read as a generic "not found" and must not
    // disclose the profile, the missing right, or that authorization was the reason.
    const description = `${outcome.reply?.statusDescription ?? ''}`;
    expect(description, `denial text was '${description}'`).toMatch(/not found/i);
    expect(description, 'the denial names neither the profile nor the missing right').not.toMatch(
      /tsa-|tsp-|permission|denied|role|authoriz/i,
    );
  });

  test('a JSON content type is refused without issuing a token', async ({ tsp, env }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'error-wrong-content-type',
      profileName: env.sets.nonQualified.signingProfile.name,
      contentType: 'application/json',
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBeGreaterThanOrEqual(400);
    expect(
      outcome.reply?.granted ?? false,
      `no token may be issued for an unsupported media type: ${describeOutcome(outcome)}`,
    ).toBe(false);
  });

  test('a JSON content type is currently answered with HTTP 500', async ({ tsp, env }) => {
    // Pinned deviation, not an endorsement: HttpMediaTypeNotSupportedException reaches the
    // generic handler in Core's ExceptionHandlingAdvice, so an unsupported media type is
    // reported as a server error instead of 415. Asserted exactly rather than marked
    // test.fail(), which would also swallow an unrelated failure on this request. When Core
    // starts answering 415, this test fails and is the record of why it changed.
    const outcome = await requestTimestamp(tsp, {
      label: 'error-wrong-content-type-status',
      profileName: env.sets.nonQualified.signingProfile.name,
      contentType: 'application/json',
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(500);
  });

  test('the digest allow-list is enforced exactly as the profile declares it', async ({ admin, tsp, env }) => {
    const set = env.sets.nonQualified;
    const profile = await admin.getSigningProfile(set.signingProfile.uuid);
    const allowed = ((profile.workflow as Record<string, unknown>).allowedDigestAlgorithms ?? []) as string[];
    const sha1Allowed =
      allowed.length === 0 || allowed.some((algorithm) => algorithm.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'sha1');

    const outcome = await requestTimestamp(tsp, {
      label: 'policy-sha1-digest',
      profileName: set.signingProfile.name,
      digest: 'sha1',
    });

    if (sha1Allowed) {
      // Core reads an empty list as "no restriction".
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
      expect(outcome.reply?.hashAlgorithm?.toLowerCase(), 'the token echoes the requested digest').toBe('sha1');
    } else {
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(false);
      expect(
        `${outcome.reply?.failureInfo ?? ''}`.toLowerCase(),
        'the rejection names the algorithm as the reason',
      ).toMatch(/algorithm/);
    }
  });

  test('the policy allow-list is enforced exactly as the profile declares it', async ({ admin, tsp, env }) => {
    const set = env.sets.nonQualified;
    const profile = await admin.getSigningProfile(set.signingProfile.uuid);
    const allowed = ((profile.workflow as Record<string, unknown>).allowedPolicyIds ?? []) as string[];
    let policySuffix = 1;
    while (allowed.includes(`1.2.3.4.9.9.${policySuffix}`)) {
      policySuffix += 1;
    }
    const unknownPolicy = `1.2.3.4.9.9.${policySuffix}`;

    const outcome = await requestTimestamp(tsp, {
      label: 'policy-unknown-oid',
      profileName: set.signingProfile.name,
      policyOid: unknownPolicy,
    });

    if (allowed.length === 0) {
      // Deviation, tracked as OmniTrustILM/core#2141: with an empty list Core accepts any
      // policy OID and copies it into the token, so the TSA asserts a policy it never
      // defined. RFC 3161 section 2.4.2 calls for a rejection with unacceptedPolicy.
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
      expect(outcome.reply?.policyOid, 'the unknown policy OID ends up in the token').toBe(unknownPolicy);
    } else {
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(false);
      expect(
        `${outcome.reply?.failureInfo ?? ''}`.toLowerCase(),
        'the rejection names the policy as the reason',
      ).toMatch(/policy/);
    }
  });

  test('a request for the profile policy is granted and carries it', async ({ tsp, env }) => {
    const set = env.sets.nonQualified;
    const outcome = await requestTimestamp(tsp, {
      label: 'policy-profile-oid',
      profileName: set.signingProfile.name,
      policyOid: set.policyOid,
    });
    // Core does not implicitly allow defaultPolicyId, so a profile whose allow-list omits its
    // own default would reject the very policy it advertises.
    expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
    expect(outcome.reply?.policyOid, 'the token states the requested policy').toBe(set.policyOid);
  });
});
