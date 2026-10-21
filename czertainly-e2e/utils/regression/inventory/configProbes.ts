/**
 * Shared steps of the credential, group and RA-profile API specs: the refusal shapes of the error contract (a 422
 * message list, a single message), the credential connector or a named skip, a valid Basic body, and the delete of an
 * own object followed by its 404 read-back and the `deleted` ledger line.
 */
import { expect, test } from '../../../fixtures/testFixtures';
import { expect422Messages, expectMessageObject } from '../errorContract';
import type { GuardedApi } from '../guard/types';
import { recordDeleted } from '../ledger/ledger';
import { runName } from '../ledger/runState';
import { requiredCustomAttributes } from '../customAttributes';
import { uniqueStamp } from '../text';
import { basicAttributes, credentialBody, credentialSetup, deleteOwnConfigObject, randomSecret, readObject } from './credentialsApi';
import type { BasicValues, CredentialConnector } from './credentialsApi';
import type { Json, Probe } from './searchApi';

/** A refusal that must be a 422: JSON array of non-empty strings (the messages are returned). */
export function refused422(p: Probe): string[] {
    expect(p.status, p.text.slice(0, 300)).toBe(422);
    expect(p.contentType, 'a 422 is application/json').toMatch(/application\/json/);
    return expect422Messages(p.text);
}

/** A refusal that is not a 422: `{ "message": "<text>" }` and nothing else (the message is returned). */
export function refusedWith(p: Probe, status: number): string {
    expect(p.status, p.text.slice(0, 300)).toBe(status);
    expect(p.contentType, `a ${status} is application/json`).toMatch(/application\/json/);
    return expectMessageObject(p.text);
}

/** The Common Credential connector with its Basic definitions, or the rows skip with the named reason. */
export async function credentialConnectorOrSkip(api: GuardedApi): Promise<CredentialConnector> {
    const setup = await credentialSetup(api);
    test.skip(!setup.ok, setup.skip ?? 'no credential connector');
    return setup.ok!;
}

/** A Basic credential body for a validation row: valid attributes (random username and password) unless the row changes them. */
export async function basicBody(api: GuardedApi, c: CredentialConnector, name: unknown, over: Json = {}, values?: BasicValues, opts?: { withUuid?: boolean }): Promise<Json> {
    const given = values ?? { username: runName(`cu-${uniqueStamp()}`), password: randomSecret() };
    return credentialBody(c, name, basicAttributes(c, given, opts), await requiredCustomAttributes(api, 'credentials', runName('ca')), over);
}

/** DELETE own, expect 204 and an empty body, read it back as 404 (message per the error contract), then record the delete. */
export async function deleteAndVerify(api: GuardedApi, kind: 'credentials' | 'groups', ref: { uuid: string; name: string }, type: string, spec: string): Promise<void> {
    const del = await deleteOwnConfigObject(api, kind, ref.uuid);
    expect(del.status, del.text.slice(0, 300)).toBe(204);
    expect(del.text, 'a 204 has no body').toBe('');
    await expectGoneWith404(api, kind, ref.uuid, type);
    recordDeleted(kind, ref, spec, 'delete under test: 204, then 404 on read-back');
}

/** The object is gone: its detail answers 404 `Object of type '<type>' identified by <uuid> is not found.`. */
export async function expectGoneWith404(api: GuardedApi, kind: 'credentials' | 'groups', uuid: string, type: string): Promise<void> {
    const gone = await readObject(api, kind, uuid);
    expect(refusedWith(gone, 404)).toBe(`Object of type '${type}' identified by ${uuid} is not found.`);
}
