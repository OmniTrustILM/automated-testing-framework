/**
 * fakeCore — the base of the stateful fake cores of the wire tests. Keeps a store of detail URL to object, hands out
 * sequential uuids and has generic routes: GET and DELETE of a stored detail, and POST to one of its `collections`.
 */
import type { Answer, Arrived } from './loopbackServer';

export type Json = Record<string, any>;

export class FakeCore {
    protected seq = 5000;
    protected uuidPrefix = 'aaaaaaaa-0000-4000-8000-';
    readonly store = new Map<string, Json>();
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

    protected route(_a: Arrived, _path: string, _body: Json): Answer | undefined {
        return undefined;
    }

    /** The platform settings a core without its own settings route answers: automatic ownership off (core#2698). */
    platformSettings: Json = { certificates: { upload: { automaticOwnership: false } } };
    platformSettingsStatus = 200;

    answer = (a: Arrived): Answer | undefined => {
        const answered = this.respond(a);
        const settingsRead = a.method === 'GET' && a.url.split('?')[0] === '/api/v1/settings/platform';
        return settingsRead && (!answered || answered.status === 404) ? { status: this.platformSettingsStatus, body: this.platformSettings } : answered;
    };

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
