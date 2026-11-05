/**
 * tier/dns — which hosts count as local: loopback always, a `*.localhost` name only when it resolves to loopback only, a TIER_LOCAL_HOSTS
 * entry only when private. The lookup runs in a child process (config load is synchronous) and is injectable.
 */
import { spawnSync } from 'child_process';
import * as net from 'net';
import { settings } from '../run/settings';

export const bareHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '');

export function isLoopbackAddress(address: string): boolean {
    const a = bareHost(address);
    if (net.isIPv4(a)) return a.split('.')[0] === '127';
    if (net.isIPv6(a)) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
        if (mapped) return isLoopbackAddress(mapped[1]);
        return a === '::1' || a === '0:0:0:0:0:0:0:1';
    }
    return false;
}

/** `localhost` and loopback literals; a `*.localhost` name is not loopback by its suffix, `isLocalHost` resolves it. */
export function isLoopbackHost(host: string): boolean {
    const h = bareHost(host);
    return h === 'localhost' || isLoopbackAddress(h);
}

export function isPrivateAddress(address: string): boolean {
    const a = bareHost(address);
    if (net.isIPv4(a)) {
        const [o1, o2] = a.split('.').map(Number);
        return o1 === 10 || o1 === 127 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
    }
    if (net.isIPv6(a)) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
        if (mapped) return isPrivateAddress(mapped[1]);
        if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
        return /^fe[89ab][0-9a-f]:/.test(a); // fe80::/10
    }
    return false;
}

export function extraLocalHosts(env: NodeJS.ProcessEnv = process.env): string[] {
    return settings(env).tierLocalHosts
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
}

export type Resolver = (host: string) => { addresses?: string[]; error?: string };

const RESOLVE_SCRIPT = `
require('dns').lookup(process.argv[1], { all: true }, (e, a) =>
  process.stdout.write(JSON.stringify(e ? { error: String(e.code || e).slice(0, 80) } : { addresses: a.map((x) => x.address) })));
`;

const resolved = new Map<string, { addresses?: string[]; error?: string }>();

export function resetResolvedHostsForTests(): void {
    resolved.clear();
}

export const dnsResolveSync: Resolver = (host) => {
    const key = host.toLowerCase();
    const hit = resolved.get(key);
    if (hit) return hit;
    // `--` ends node's own options: a host starting with `-` is never an option.
    const r = spawnSync(process.execPath, ['-e', RESOLVE_SCRIPT, '--', key], { encoding: 'utf8', timeout: 10_000 });
    let out: { addresses?: string[]; error?: string };
    try {
        out = JSON.parse(r.stdout || '{}');
    } catch {
        out = { error: 'unreadable lookup output' };
    }
    if (!out.addresses && !out.error) out = { error: r.error ? String(r.error) : 'no answer' };
    resolved.set(key, out);
    return out;
};

export interface LocalHostOptions {
    resolve?: Resolver;
}

/** Loopback; or listed in TIER_LOCAL_HOSTS AND private (a private literal, or a name whose every address is private). */
export function isLocalHost(host: string, env: NodeJS.ProcessEnv = process.env, opts: LocalHostOptions = {}): boolean {
    if (isLoopbackHost(host)) return true;
    const h = bareHost(host);
    if (h.endsWith('.localhost')) {
        // Resolved like any other name (a resolver or /etc/hosts may map it anywhere).
        const { addresses } = (opts.resolve ?? dnsResolveSync)(h);
        return !!addresses && addresses.length > 0 && addresses.every(isLoopbackAddress);
    }
    if (!extraLocalHosts(env).map(bareHost).includes(h)) return false;
    if (net.isIP(h)) return isPrivateAddress(h);
    const { addresses } = (opts.resolve ?? dnsResolveSync)(h);
    return !!addresses && addresses.length > 0 && addresses.every(isPrivateAddress);
}

export function hostOf(value: string, variable: string): string {
    try {
        return new URL(value).hostname;
    } catch {
        throw new Error(`${variable} is not a valid URL; refusing to run @local tests.`);
    }
}
