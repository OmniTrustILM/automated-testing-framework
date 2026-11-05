/**
 * liveOwn — the handle of an own object that has just passed the live own-object check.
 *
 * `LiveOwn.prove(api, type, ref)` runs `assertOwnLive` (a `created` line of this run on this tier AND a live object whose
 * name carries the run prefix) and returns a `LiveOwn`. Nothing else can build one: the constructor is private, and the
 * spec lint refuses `as LiveOwn`.
 *
 * The browser is not behind the API guard, so before a page object changes or deletes an object this check is the only
 * barrier; a page action that takes a `LiveOwn` cannot be reached without it. The `live(type, ref)` fixture of
 * fixtures/regressionFixtures.ts calls `prove` with the test's `api`. Prove it right before the act, then act.
 */
import type { APIRequestContext } from '@playwright/test';
import { assertOwnLive, type LiveOwnership } from './ownership';
import type { OwnRef } from './ledger';

export class LiveOwn<Type extends string = string> {
    /** A private field makes the class nominal: no object literal or look-alike class has it, so none is assignable to a `LiveOwn`. */
    readonly #proven = true;

    private constructor(
        /** The ledger type (the API resource) the object was proven as. */
        readonly type: Type,
        /** The object as the ledger names it. */
        readonly ref: OwnRef,
        /** What the live check read: the ledger line and, for a live-read type, the object's body. */
        readonly proof: LiveOwnership,
    ) {}

    /**
     * Runs the live own-object check and hands back the proof; throws `OwnObjectViolation` / `LiveObjectMissing` when the object is not a
     * live object of this run.
     */
    static async prove<Type extends string>(api: APIRequestContext, type: Type, ref: { uuid: string; name?: string }, helper = 'live'): Promise<LiveOwn<Type>> {
        const proof = await assertOwnLive(api, type, ref, helper);
        return new LiveOwn(type, { uuid: ref.uuid, name: proof.line.name, kind: 'own' }, proof);
    }

    /**
     * True only for a handle `prove` built: the brand check reads the private field, so an object literal, a look-alike class or a
     * cast value (whatever its members say) is refused. A page action that takes a handle calls `LiveOwn.isProven` or `LiveOwn.require`.
     */
    static isProven(value: unknown): value is LiveOwn {
        return typeof value === 'object' && value !== null && #proven in value;
    }

    /** `value` as a `LiveOwn`, or an error naming what was handed over instead. */
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
