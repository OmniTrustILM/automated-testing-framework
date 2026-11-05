/**
 * liveOwn — the handle of an own object that just passed the live own-object check (`assertOwnLive`).
 * Only `LiveOwn.prove` builds one (private constructor; the spec lint refuses `as LiveOwn`). The browser is not behind the API guard, so
 * this is the only barrier before a page action changes or deletes an object: prove right before the act.
 */
import type { APIRequestContext } from '@playwright/test';
import { assertOwnLive, type LiveOwnership } from './ownership';
import type { OwnRef } from './ledger';

export class LiveOwn<Type extends string = string> {
    /** A private field makes the class nominal: no look-alike is assignable. */
    readonly #proven = true;

    private constructor(
        readonly type: Type,
        readonly ref: OwnRef,
        readonly proof: LiveOwnership,
    ) {}

    /** Runs the live own-object check; throws `OwnObjectViolation` / `LiveObjectMissing` when the object is not a live object of this run. */
    static async prove<Type extends string>(api: APIRequestContext, type: Type, ref: { uuid: string; name?: string }, helper = 'live'): Promise<LiveOwn<Type>> {
        const proof = await assertOwnLive(api, type, ref, helper);
        return new LiveOwn(type, { uuid: ref.uuid, name: proof.line.name, kind: 'own' }, proof);
    }

    /** True only for a handle `prove` built (the brand check reads the private field). */
    static isProven(value: unknown): value is LiveOwn {
        return typeof value === 'object' && value !== null && #proven in value;
    }

    static require(value: unknown): LiveOwn {
        if (!LiveOwn.isProven(value)) throw new Error('a LiveOwn from live() is required here: this object did not pass the live own-object check');
        return value;
    }

    get uuid(): string {
        return this.ref.uuid;
    }

    get name(): string {
        return this.ref.name;
    }
}
