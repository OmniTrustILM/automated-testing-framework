/**
 * fakeCore — the base of the stateful fake cores of the wire tests.
 *
 * Keeps a store of detail URL to object, hands out sequential uuids and has generic routes: GET and DELETE of a stored detail,
 * and POST to one of its `collections`. A subclass adds its own rules in `route` or answers everything in `respond`; only the
 * ownCrud core uses the generic routes. In memory only; used with `registerFakeCore` and a loopback server.
 */
import type { Answer, Arrived } from './loopbackServer';

export type Json = Record<string, any>;

export class FakeCore {
    /** The first uuid number of a core is `seq + 1`. */
    protected seq = 5000;
    /** The uuid prefix of the ids the core hands out. */
    protected uuidPrefix = 'aaaaaaaa-0000-4000-8000-';
    readonly store = new Map<string, Json>();
    /** Collection paths a generic POST creates in. */
    protected collections = new Set<string>();
    protected createStatus = 201;

    next(): string {
        this.seq += 1;
        return `${this.uuidPrefix}${String(this.seq).padStart(12, '0')}`;
    }

    seed(path: string, body: Json): this {
        this.store.set(path, body);
        return this;
    }

    /** The area rules; undefined falls through to the generic routes. */
    protected route(_a: Arrived, _path: string, _body: Json): Answer | undefined {
        return undefined;
    }

    /** What the loopback server calls; a test may wrap it (`core.answer = ...`). */
    answer = (a: Arrived): Answer | undefined => this.respond(a);

    /** The area rules first, then the generic routes. */
    protected respond(a: Arrived): Answer | undefined {
        const path = a.url.split('?')[0];
        const body: Json = a.body ? JSON.parse(a.body) : {};
        return this.route(a, path, body) ?? this.generic(a, path, body);
    }

    private generic(a: Arrived, path: string, body: Json): Answer {
        if (a.method === 'GET') return this.store.has(path) ? { status: 200, body: this.store.get(path) } : { status: 404 };
        if (a.method === 'DELETE') {
            if (!this.store.has(path)) return { status: 404 };
            this.store.delete(path);
            return { status: 204 };
        }
        if (a.method === 'POST' && this.collections.has(path)) {
            const uuid = this.next();
            this.store.set(`${path}/${uuid}`, { uuid, name: body.name });
            return { status: this.createStatus, body: { uuid, name: body.name } };
        }
        return { status: 404 };
    }
}
