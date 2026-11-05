/**
 * ApiRecorder — records the `/api/` requests a page sends between `start()`
 * and `stop()`; a recorder never started adds nothing to the page.
 */
import type { Page, Request } from '@playwright/test';

export interface SeenRequest {
    method: string;
    path: string;
}

export class ApiRecorder {
    private readonly seen: SeenRequest[] = [];
    private listener: ((request: Request) => void) | undefined;

    constructor(private readonly page: Page) {}

    start(): this {
        if (this.listener) return this;
        this.listener = (request: Request) => {
            let path: string;
            try {
                path = new URL(request.url()).pathname;
            } catch {
                return; // not a URL: not an API request
            }
            if (path.includes('/api/')) this.seen.push({ method: request.method(), path });
        };
        this.page.on('request', this.listener);
        return this;
    }

    stop(): void {
        if (!this.listener) return;
        this.page.off('request', this.listener);
        this.listener = undefined;
    }

    get recording(): boolean {
        return this.listener !== undefined;
    }

    mark(): number {
        return this.seen.length;
    }

    since(mark: number): SeenRequest[] {
        return this.seen.slice(mark);
    }

    nonReadsSince(mark: number): SeenRequest[] {
        return this.since(mark).filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
    }
}
