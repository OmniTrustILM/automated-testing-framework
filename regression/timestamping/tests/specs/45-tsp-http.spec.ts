import { primaryFamily } from '../utils/env';
import { expect, test } from '../utils/fixtures';
import { describeOutcome, requestTimestamp, TimestampOutcome, TspRoute } from '../utils/tsp';

/**
 * The TSP endpoints as HTTP resources: authentication challenges, cookies, media types, content
 * negotiation and methods. The servlet container, the MVC layer and the security chain decide
 * these before any signing happens, so a framework upgrade can change them while every token
 * stays valid.
 */
test.describe('TSP over HTTP', () => {
  const primary = primaryFamily();
  const set = primary.nonQualified;
  const routes: TspRoute[] = ['signing', 'tsp'];

  function profileOn(route: TspRoute): string {
    return route === 'tsp' ? set.tspProfile.name : set.signingProfile.name;
  }

  function expectNoToken(outcome: TimestampOutcome): void {
    expect(outcome.reply?.granted ?? false, `no token may be issued: ${describeOutcome(outcome)}`).toBe(false);
  }

  for (const route of routes) {
    test(`a refused request on the ${route}-profile route challenges for the Basic credentials of its TSP profile`, async ({
      tsp,
    }) => {
      // HTTP clients that answer a challenge, as Java's Authenticator does, send credentials only after it.
      const challenge = `Basic realm="${set.tspProfile.name}"`;
      const wrongPassword = await requestTimestamp(tsp, {
        label: `http-challenge-wrong-password-${route}`,
        profileName: profileOn(route),
        route,
        password: 'definitely-not-the-password',
      });
      expect(wrongPassword.httpStatus, describeOutcome(wrongPassword)).toBe(401);
      expect(wrongPassword.headers['www-authenticate'], 'challenge after a wrong password').toBe(challenge);

      const anonymous = await requestTimestamp(tsp, {
        label: `http-challenge-anonymous-${route}`,
        profileName: profileOn(route),
        route,
        username: null,
      });
      expect(anonymous.httpStatus, describeOutcome(anonymous)).toBe(401);
      expect(anonymous.headers['www-authenticate'], 'challenge without credentials').toBe(challenge);
    });

    test(`a token on the ${route}-profile route comes without a cookie`, async ({ tsp }) => {
      const outcome = await requestTimestamp(tsp, {
        label: `http-no-cookie-${route}`,
        profileName: profileOn(route),
        route,
      });
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
      expect(outcome.headers['set-cookie'], 'the TSP endpoints keep no session').toBeUndefined();
    });
  }

  test('an unknown profile is refused without a challenge', async ({ tsp }) => {
    // A challenge would name the realm, and so confirm which profiles exist.
    const outcome = await requestTimestamp(tsp, {
      label: 'http-unknown-profile-no-challenge',
      profileName: 'tsa-does-not-exist',
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(401);
    expect(outcome.headers['www-authenticate'], 'no realm is disclosed').toBeUndefined();
  });

  for (const contentType of ['Application/Timestamp-Query', 'application/timestamp-query; foo=bar']) {
    test(`the request media type '${contentType}' is accepted`, async ({ tsp }) => {
      const outcome = await requestTimestamp(tsp, {
        label: `http-content-type-${contentType.replace(/[^a-z0-9]+/gi, '-')}`,
        profileName: set.signingProfile.name,
        contentType,
      });
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
    });
  }

  for (const contentType of ['application/x-www-form-urlencoded', 'application/octet-stream']) {
    test(`a '${contentType}' content type is refused like JSON`, async ({ tsp }) => {
      // curl sends the form type for --data-binary unless told otherwise. Same pinned deviation as
      // JSON in 40-tsp-errors: an unsupported media type reaches Core's catch-all handler
      // (OmniTrustILM/core#2140), so these move to 415 together.
      const outcome = await requestTimestamp(tsp, {
        label: `http-content-type-${contentType.replace(/[^a-z0-9]+/gi, '-')}`,
        profileName: set.signingProfile.name,
        contentType,
      });
      expect(outcome.httpStatus, describeOutcome(outcome)).toBe(500);
      expectNoToken(outcome);
    });
  }

  for (const accept of ['application/timestamp-reply', '*/*']) {
    test(`a client accepting '${accept}' gets the token`, async ({ tsp }) => {
      const outcome = await requestTimestamp(tsp, {
        label: `http-accept-${accept.replace(/[^a-z0-9]+/gi, '-')}`,
        profileName: set.signingProfile.name,
        accept,
      });
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
      expect(outcome.contentType, 'response media type').toContain('application/timestamp-reply');
    });
  }

  test('a client accepting only JSON is currently answered with HTTP 500', async ({ tsp }) => {
    // Pinned deviation: the unacceptable representation reaches the same catch-all handler in
    // Core's ExceptionHandlingAdvice as the unsupported media type of OmniTrustILM/core#2140,
    // instead of becoming 406.
    const outcome = await requestTimestamp(tsp, {
      label: 'http-accept-json',
      profileName: set.signingProfile.name,
      accept: 'application/json',
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(500);
    expectNoToken(outcome);
  });

  for (const method of ['GET', 'PUT'] as const) {
    test(`${method} is refused with HTTP 400`, async ({ tsp }) => {
      // Core's ExceptionHandlingAdvice answers an unsupported method with 400.
      const outcome = await requestTimestamp(tsp, {
        label: `http-method-${method.toLowerCase()}`,
        profileName: set.signingProfile.name,
        method,
      });
      expect(outcome.httpStatus, describeOutcome(outcome)).toBe(400);
      expectNoToken(outcome);
    });
  }

  test('an empty body is refused as an unreadable request', async ({ tsp }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'http-empty-body',
      profileName: set.signingProfile.name,
      body: Buffer.alloc(0),
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(400);
    expectNoToken(outcome);
  });

  test('an oversized body is rejected in the TSP reply', async ({ tsp }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'http-oversized-body',
      profileName: set.signingProfile.name,
      body: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(200);
    expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(false);
  });

  test('a trailing slash is outside the TSP routes', async ({ tsp }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'http-trailing-slash',
      profileName: `${set.signingProfile.name}/`,
      username: set.basicCredential.username,
      password: set.basicCredential.password,
    });
    expect(outcome.httpStatus, describeOutcome(outcome)).toBe(401);
    expect(outcome.headers['www-authenticate'], 'no TSP profile answers the path').toBeUndefined();
    expectNoToken(outcome);
  });
});
