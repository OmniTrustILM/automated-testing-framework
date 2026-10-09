import { waitFor } from '../utils/docker';
import { primaryFamily, provisionedSets } from '../utils/env';
import { expect, test } from '../utils/fixtures';
import {
  certificateSerial,
  Digest,
  parseTimestampQuery,
  tokenSignerCertificate,
  verifyTimestamp,
} from '../utils/openssl';
import { describeOutcome, requestTimestamp, TimestampOutcome, TspRoute } from '../utils/tsp';

/**
 * The core regression: a timestamp is issued, is cryptographically verifiable against the
 * platform's own chain, and carries what the profile promised. A token that comes back but
 * does not verify is a failure — that is exactly what a broken signing engine looks like.
 */
test.describe('TSP happy path', () => {
  const primary = primaryFamily();

  const routes: TspRoute[] = ['signing', 'tsp'];

  function expectNonceEchoed(outcome: TimestampOutcome): void {
    const query = parseTimestampQuery(outcome.queryPath!);
    expect(query.nonceHex, 'request carries a nonce').toBeTruthy();
    expect(outcome.reply?.nonceHex, 'response echoes the request nonce exactly').toBe(query.nonceHex);
  }

  for (const { label, set: provisioned } of provisionedSets()) {
    for (const route of routes) {
      test(`${label} profile issues a verifiable token over the ${route}-profile route`, async ({ admin, tsp, env }) => {
        const set = provisioned;
        const profileName = route === 'tsp' ? set.tspProfile.name : set.signingProfile.name;

        const outcome = await requestTimestamp(tsp, {
          label: `happy-${label}-${route}`,
          profileName,
          route,
        });

        expect(outcome.httpStatus, describeOutcome(outcome)).toBe(200);
        expect(outcome.contentType, 'response media type').toContain('application/timestamp-reply');
        expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
        expect(outcome.reply?.policyOid, 'policy OID in the token').toBe(set.policyOid);
        expectNonceEchoed(outcome);
        expect(outcome.reply?.serialNumberHex, 'token serial number').toBeTruthy();

        const trust = await admin.certificateTrustFiles(set.certificate.uuid, `chain-${label}`);
        const verification = verifyTimestamp(outcome.responsePath!, trust.caFile, {
          queryPath: outcome.queryPath,
          untrustedFile: trust.untrustedFile,
        });
        expect(verification.ok, `token verification said: ${verification.output}`).toBe(true);
      });
    }

    test(`${label} token is signed by the provisioned TSA certificate`, async ({ admin, tsp, env }) => {
      const set = provisioned;
      const outcome = await requestTimestamp(tsp, {
        label: `signer-${label}`,
        profileName: set.signingProfile.name,
      });
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);

      const signerPem = tokenSignerCertificate(outcome.responsePath!, outcome.dir);
      expect(signerPem, 'the token embeds the signer certificate when certReq is set').not.toBeNull();

      const platformCertificate = await admin.getCertificate(set.certificate.uuid);
      const expectedSerial = platformCertificate.serialNumber.replace(/^0+/, '').toLowerCase();
      expect(certificateSerial(signerPem!), 'signer certificate serial number').toBe(expectedSerial);
    });

    test(`${label} token is recorded under its signing profile`, async ({ admin, tsp }) => {
      const set = provisioned;
      const outcome = await requestTimestamp(tsp, {
        label: `record-${label}`,
        profileName: set.signingProfile.name,
      });
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);

      const serial = outcome.reply!.serialNumberHex!;
      const records = await waitFor(
        () => admin.listSigningRecords(),
        (all) => all.some((record) => record.timestampTokenSerialNumbers?.includes(serial)),
        60_000,
        2000,
      );
      const record = records.find((candidate) => candidate.timestampTokenSerialNumbers?.includes(serial));
      expect(record, `no signing record carries token serial '${serial}' (artifacts: ${outcome.dir})`).toBeDefined();
      expect(record!.protocol, 'the record is attributed to the TSP protocol').toBe('tsp');
      expect(record!.signingProfile?.uuid, 'the record names the signing profile that issued the token').toBe(
        set.signingProfile.uuid,
      );
    });
  }

  for (const digest of ['sha256', 'sha384', 'sha512'] as Digest[]) {
    test(`a ${digest} imprint is timestamped and stays bound to the data`, async ({ admin, tsp }) => {
      const set = primary.nonQualified;
      const outcome = await requestTimestamp(tsp, {
        label: `digest-${digest}`,
        profileName: set.signingProfile.name,
        digest,
        content: `imprint check ${digest} ${Date.now()}\n`,
      });

      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
      expect(outcome.reply?.hashAlgorithm?.toLowerCase(), 'hash algorithm preserved in the token').toBe(digest);

      // Verifying against the original data, not just the query, proves the message imprint
      // in the token still matches the bytes the client hashed.
      const trust = await admin.certificateTrustFiles(set.certificate.uuid, 'chain-non-qualified');
      const verification = verifyTimestamp(outcome.responsePath!, trust.caFile, {
        dataPath: outcome.dataPath,
        untrustedFile: trust.untrustedFile,
      });
      expect(verification.ok, `token verification said: ${verification.output}`).toBe(true);
    });
  }

  test('a request without a nonce is answered without a nonce', async ({ tsp }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'no-nonce',
      profileName: primary.nonQualified.signingProfile.name,
      nonce: false,
    });
    expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
    expect(parseTimestampQuery(outcome.queryPath!).nonceHex, 'request carries no nonce').toBeUndefined();
    expect(outcome.reply?.nonceSpecified, `nonce was '${outcome.reply?.nonce}'`).toBe(false);
  });

  test('a request without certReq gets a token without the signer certificate', async ({ tsp }) => {
    const outcome = await requestTimestamp(tsp, {
      label: 'no-certreq',
      profileName: primary.nonQualified.signingProfile.name,
      certReq: false,
    });
    expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
    expect(
      tokenSignerCertificate(outcome.responsePath!, outcome.dir),
      'no certificate is embedded when the client did not ask for one',
    ).toBeNull();
  });

  test('the genTime in the token tracks the local clock', async ({ tsp }) => {
    const before = Date.now();
    const outcome = await requestTimestamp(tsp, {
      label: 'gentime',
      profileName: primary.qualified.signingProfile.name,
    });
    const after = Date.now();

    expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
    const genTime = Date.parse(outcome.reply!.timestamp!);
    expect(Number.isNaN(genTime), `unparsable genTime '${outcome.reply?.timestamp}'`).toBe(false);
    // openssl prints genTime at second precision, so allow a minute of slack either way.
    expect(genTime).toBeGreaterThan(before - 60_000);
    expect(genTime).toBeLessThan(after + 60_000);
  });

  test('parallel requests produce unique, verifiable tokens', async ({ admin, tsp }) => {
    const set = primary.nonQualified;
    const trust = await admin.certificateTrustFiles(set.certificate.uuid, 'chain-parallel');
    // Core shares 20 connections per connector with all its traffic and drops a request that waits 10 s for one.
    const requestCount = 10;

    const outcomes = await Promise.all(
      Array.from({ length: requestCount }, (_, index) => {
        const route: TspRoute = index % 2 === 0 ? 'signing' : 'tsp';
        return requestTimestamp(tsp, {
          label: `parallel-${index + 1}`,
          profileName: route === 'tsp' ? set.tspProfile.name : set.signingProfile.name,
          route,
          content: `parallel timestamp ${index + 1}\n`,
        });
      }),
    );

    const serials: string[] = [];
    for (const outcome of outcomes) {
      expect(outcome.httpStatus, describeOutcome(outcome)).toBe(200);
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
      expectNonceEchoed(outcome);

      const serial = outcome.reply?.serialNumberHex;
      expect(serial, 'parallel token serial number').toBeTruthy();
      serials.push(serial!);

      const verification = verifyTimestamp(outcome.responsePath!, trust.caFile, {
        queryPath: outcome.queryPath,
        untrustedFile: trust.untrustedFile,
      });
      expect(verification.ok, `parallel token verification failed: ${verification.output}`).toBe(true);
    }

    expect(new Set(serials).size, 'parallel timestamps have unique serial numbers').toBe(requestCount);
  });
});
