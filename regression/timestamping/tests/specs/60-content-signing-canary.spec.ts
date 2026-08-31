import { SigningRecordListItem } from '../utils/adminApi';
import { waitFor } from '../utils/docker';
import { runStartedAt } from '../utils/env';
import { expect, test } from '../utils/fixtures';
import { describeOutcome, requestTimestamp } from '../utils/tsp';

/**
 * Content signing and timestamping share the signing engine and the signing-record subsystem,
 * so a change on the content-signing side can silently alter what timestamping records or
 * whether it records at all. These are the canaries for that shared ground; the content-signing
 * flow itself is out of scope while its certificate-eligibility rules are still being defined.
 */
test.describe('content-signing canary', () => {
  test('a timestamp produces a signing record that traces back to its token', async ({ admin, tsp, env }) => {
    const set = env.sets.nonQualified;
    const outcome = await requestTimestamp(tsp, {
      label: 'record-timestamp',
      profileName: set.signingProfile.name,
    });
    expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);

    const serial = outcome.reply!.serialNumberHex!;
    // The record policy defaults to DEFERRED_DURABLE, so the write lands shortly after the
    // response the client already has.
    const records = await waitFor(
      () => admin.listSigningRecords(),
      (all) => all.some((record) => record.timestampTokenSerialNumbers?.includes(serial)),
      60_000,
      2000,
    );

    const record = records.find((candidate) => candidate.timestampTokenSerialNumbers?.includes(serial));
    expect(
      record,
      `no signing record carries token serial '${serial}' (records seen: ${records.length}, artifacts: ${outcome.dir})`,
    ).toBeDefined();
    expect(record!.protocol, 'the record is attributed to the TSP protocol').toBe('tsp');
    expect(record!.signingProfile?.uuid, 'the record names the signing profile that issued the token').toBe(
      set.signingProfile.uuid,
    );

    const detail = await admin.get<{ uuid: string; protocol: string; signingTime: string; dtbs?: string | null }>(
      `/v1/signingRecords/${record!.uuid}`,
    );
    expect(detail.uuid, 'the record detail is retrievable').toBe(record!.uuid);
    expect(Date.parse(detail.signingTime), 'the record carries a parsable signing time').not.toBeNaN();
  });

  test('the timestamping profile exposes a coherent signing-record policy', async ({ admin, env }) => {
    const profile = await admin.getSigningProfile(env.sets.nonQualified.signingProfile.uuid);
    const policy = profile.recordPolicy as Record<string, unknown> | undefined;

    expect(policy, 'the signing profile carries a record policy').toBeDefined();
    expect(policy!.recordingEnabled, 'recording is enabled by default').toBe(true);
    expect(
      ['immediate', 'deferred_durable', 'best_effort'],
      `persistence mode was '${policy!.persistenceMode}'`,
    ).toContain(String(policy!.persistenceMode).toLowerCase());
    // A timestamp has no document and no DTBS to keep; those flags belong to content signing.
    expect(policy!.recordSignedDocument, 'timestamping does not record a signed document').toBe(false);
  });

  test('the platform still advertises all three signing workflow types', async ({ admin }) => {
    // /v1/enums answers with a map of enum name -> { code -> entry }.
    const enums = await admin.get<Record<string, Record<string, { code: string }>>>('/v1/enums');
    const workflowTypes = enums.SigningWorkflowType;
    expect(workflowTypes, 'SigningWorkflowType is published in the enum catalogue').toBeDefined();

    const codes = Object.values(workflowTypes).map((entry) => entry.code);
    expect(codes, 'timestamping is still a workflow type').toContain('timestamping');
    expect(codes, 'content signing is still a workflow type').toContain('content_signing');
    expect(codes, 'raw signing is still a workflow type').toContain('raw_signing');
  });

  test('a content-signing profile cannot be built on the timestamping connector, and timestamping still works', async ({
    admin,
    tsp,
    env,
  }) => {
    const set = env.sets.nonQualified;
    // A well-formed content-signing request on purpose: an incomplete one would be rejected
    // by request validation and prove nothing. This reaches the capability gate — the
    // boundary between content signing and timestamping that the content-signing work moves.
    const response = await admin.raw('POST', '/v1/signingProfiles', {
      name: `regression-content-signing-${Date.now()}`,
      workflow: {
        type: 'content_signing',
        family: 'cades',
        maxLevel: 'signed',
        signatureFormattingConnectorUuid: env.connectors.timestampFormatting.uuid,
        signatureFormattingConnectorAttributes: [],
      },
      signingScheme: {
        signingScheme: 'managed',
        managedSigningType: 'static_key',
        certificateUuid: set.certificate.uuid,
        signingOperationAttributes: [],
      },
      customAttributes: [],
    });

    const body = await response.text();
    expect(response.status(), `content-signing profile creation: ${body}`).toBe(422);
    expect(body, 'the refusal names the missing content-signing capability').toMatch(/Content Signing/i);
    expect(body, 'the refusal names the connector it checked').toContain(env.connectors.timestampFormatting.name);

    const afterwards = await requestTimestamp(tsp, {
      label: 'canary-timestamp-after-content-signing',
      profileName: set.signingProfile.name,
    });
    expect(afterwards.reply?.granted, `timestamping after the refusal: ${describeOutcome(afterwards)}`).toBe(true);
  });

  test('every timestamp issued during this run carries its token serial number', async ({ admin, tsp, env }) => {
    // Scoped to this run rather than the whole table: the database survives between runs and
    // holds records written by older platform versions, which are not this suite's business.
    const since = runStartedAt();
    const sets = [env.sets.nonQualified, env.sets.qualified];
    const issued: string[] = [];
    for (const set of sets) {
      const outcome = await requestTimestamp(tsp, {
        label: `record-serial-coverage-${set.qualified ? 'qualified' : 'non-qualified'}`,
        profileName: set.signingProfile.name,
      });
      expect(outcome.reply?.granted, describeOutcome(outcome)).toBe(true);
      issued.push(outcome.reply!.serialNumberHex!);
    }

    const records: SigningRecordListItem[] = await waitFor(
      () => admin.listSigningRecords(1000),
      (all) => issued.every((serial) => all.some((record) => record.timestampTokenSerialNumbers?.includes(serial))),
      60_000,
      2000,
    );

    const fromThisRun = records.filter(
      (record) => record.protocol === 'tsp' && Date.parse(record.createdAt) >= since,
    );
    expect(fromThisRun.length, 'the run produced TSP records').toBeGreaterThanOrEqual(issued.length);

    const withoutSerial = fromThisRun.filter(
      (record) => !record.timestampTokenSerialNumbers || record.timestampTokenSerialNumbers.length === 0,
    );
    expect(
      withoutSerial.map((record) => record.uuid),
      'every TSP record from this run carries the serial number of the token it issued',
    ).toEqual([]);

    for (const set of sets) {
      expect(
        fromThisRun.some((record) => record.signingProfile?.uuid === set.signingProfile.uuid),
        `records exist for '${set.signingProfile.name}'`,
      ).toBe(true);
    }
  });
});
