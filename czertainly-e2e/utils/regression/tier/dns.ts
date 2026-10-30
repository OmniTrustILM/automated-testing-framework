/**
 * tier/dns — which hosts count as local: `localhost`, 127.0.0.0/8 and ::1 always; a `*.localhost` name only when it
 * RESOLVES to loopback only; a TIER_LOCAL_HOSTS entry only when it is (or resolves only to) an RFC 1918 / link-local /
 * loopback address. The lookup runs in a child process (config load is synchronous) and is injectable.
 */
import { spawnSync } from 'child_process';
import * as net from 'net';
import { settings } from '../run/settings';

export const bareHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '');

/** 127.0.0.0/8, ::1 and ::ffff:127.x (with or without brackets). */
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

/**
 * `localhost` and loopback literals (with or without brackets). A `*.localhost` name is NOT loopback by its suffix:
 * `isLocalHost` resolves it and accepts it only when every address is loopback.
 */
export function isLoopbackHost(host: string): boolean {
    const h = bareHost(host);
    return h === 'localhost' || isLoopbackAddress(h);
}

/** RFC 1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10) or loopback; false for anything else. */
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

/** Extra hosts a local stack may use (TIER_LOCAL_HOSTS, comma-separated); each must still prove it is private. */
export function extraLocalHosts(env: NodeJS.ProcessEnv = process.env): string[] {
    return settings(env).tierLocalHosts
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
}

/** A synchronous name lookup (config load is synchronous): every address the name resolves to. Injected in tests. */
export type Resolver = (host: string) => { addresses?: string[]; error?: string };

const RESOLVE_SCRIPT = `
require('dns').lookup(process.argv[1], { all: true }, (e, a) =>
  process.stdout.write(JSON.stringify(e ? { error: String(e.code || e).slice(0, 80) } : { addresses: a.map((x) => x.address) })));
`;

const resolved = new Map<string, { addresses?: string[]; error?: string }>();

/** Forget the cached host lookups of this process (unit tests). */
export function resetResolvedHostsForTests(): void {
    resolved.clear();
}

/** Default resolver: `dns.lookup(all)` in a child Node process, cached per process. */
export const dnsResolveSync: Resolver = (host) => {
    const key = host.toLowerCase();
    const hit = resolved.get(key);
    if (hit) return hit;
    // `--` ends node's own options: a host that starts with `-` is an argument, never an option.
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

/**
 * Loopback; or listed in TIER_LOCAL_HOSTS AND private: an RFC 1918 / link-local / loopback literal, or a name whose
 * every address is one.
 */
export function isLocalHost(host: string, env: NodeJS.ProcessEnv = process.env, opts: LocalHostOptions = {}): boolean {
    if (isLoopbackHost(host)) return true;
    const h = bareHost(host);
    if (h.endsWith('.localhost')) {
        // Resolved like any other name: loopback only (a resolver or /etc/hosts may map it anywhere).
        const { addresses } = (opts.resolve ?? dnsResolveSync)(h);
        return !!addresses && addresses.length > 0 && addresses.every(isLoopbackAddress);
    }
    if (!extraLocalHosts(env).map(bareHost).includes(h)) return false;
    if (net.isIP(h)) return isPrivateAddress(h);
    const { addresses } = (opts.resolve ?? dnsResolveSync)(h);
    return !!addresses && addresses.length > 0 && addresses.every(isPrivateAddress);
}

/** The hostname of a URL variable; the error names the variable, never its value. */
export function hostOf(value: string, variable: string): string {
    try {
        return new URL(value).hostname;
    } catch {
        throw new Error(`${variable} is not a valid URL; refusing to run @local tests.`);
    }
}
