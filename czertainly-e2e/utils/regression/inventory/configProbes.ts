/**
 * configProbes — shared steps of the credential, group and RA-profile API specs.
 *
 * WHAT: Shared steps of the credential, group and RA-profile API specs: the refusal shapes of the error contract (a 422
 *       message list, a single message), the credential connector or a named skip, a valid Basic body, and the delete of an
 *       own object followed by its 404 read-back and the `deleted` ledger line.
 * WHY: The three specs repeat the same refusal checks and the same delete-and-prove step; one copy keeps them equal.
 * HOW: The refusal readers delegate to the error contract; `deleteOwnAndProveGone` deletes an own object, reads back the 404 and writes the `deleted` ledger line.
 */
import { expect, test } from '../../../fixtures/testFixtures';
import { expect422Messages, expectMessageObject } from '../errorContract';
import type { GuardedApi } from '../guard/types';
import { OwnRef } from '../ledger/ledger';
import { runName, ownName } from '../ledger/runState';
import { requiredCustomAttributes } from '../customAttributes';
import { basicAttributes, credentialBody, credentialSetup, randomSecret, readObject } from './credentialsApi';
import type { BasicValues, CredentialConnector } from './credentialsApi';
import { ApiAnswer } from '../apiReads';
import { deleteOwn } from '../ownCrud';
import { JsonObject } from '../json';

/** A refusal that must be a 422: JSON array of non-empty strings (the messages are returned). */
export function refused422(p: ApiAnswer): string[] {
    expect(p.status, p.text.slice(0, 300)).toBe(422);
    expect(p.contentType, 'a 422 is application/json').toMatch(/application\/json/);
    return expect422Messages(p.text);
}

/** A refusal that is not a 422: `{ "message": "<text>" }` and nothing else (the message is returned). */
export function refusedWith(p: ApiAnswer, status: number): string {
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
export async function basicBody(api: GuardedApi, c: CredentialConnector, name: unknown, over: JsonObject = {}, values?: BasicValues, opts?: { withUuid?: boolean }): Promise<JsonObject> {
    const given = values ?? { username: ownName('cu'), password: randomSecret() };
    return credentialBody(c, name, basicAttributes(c, given, opts), await requiredCustomAttributes(api, 'credentials', runName('ca')), over);
}

/** DELETE own (`deleteOwn`), expect 204 and an empty body, read it back as 404 (message per the error contract); the delete is recorded after the read-back. */
export async function deleteOwnAndProveGone(api: GuardedApi, kind: 'credentials' | 'groups', ref: OwnRef, type: string, spec: string): Promise<void> {
    const del = await deleteOwn(api, kind, ref, spec, { note: 'delete under test: 204, then 404 on read-back', readBack: () => expectGoneWith404(api, kind, ref.uuid, type) });
    expect(del.status, del.text.slice(0, 300)).toBe(204);
    expect(del.text, 'a 204 has no body').toBe('');
}

/** The object is gone: its detail answers 404 `Object of type '<type>' identified by <uuid> is not found.`. */
export async function expectGoneWith404(api: GuardedApi, kind: 'credentials' | 'groups', uuid: string, type: string): Promise<void> {
    const gone = await readObject(api, kind, uuid);
    expect(refusedWith(gone, 404)).toBe(`Object of type '${type}' identified by ${uuid} is not found.`);
}
