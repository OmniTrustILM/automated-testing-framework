/**
 * tlsTarget — a TLS scan target the run controls.
 *
 * WHAT: a TLS scan target the run controls: runner-hosted listeners on random ports that serve per-run certificates
 *       (a root, an optional intermediate, one leaf per listener, every name run-prefixed), so every certificate a discovery
 *       onboards is recognisable and recorded, and `servedFingerprints()` is an oracle the test computed itself. The discovery rows
 *       scan only this server or RFC 5737 documentation ranges. REG_SCAN_HOST = the dotted name or address the connector reaches.
 * WHY: A discovery test needs certificates it can recognise and compute itself, and must never scan anything but its own server or
 * documentation ranges.
 * HOW: Runner-hosted listeners on random ports serve per-run, run-prefixed certificates; `servedFingerprints()` is the oracle the test
 * computes itself.
 */
import * as forge from 'node-forge';
import * as net from 'net';
import * as tls from 'tls';
import { newKeyMaterial, sha256Hex } from '../pkiBuilders';
import { checkedCommonName, runCommonName, runId } from '../ledger/runState';
import { uniqueSuffix } from '../text';
import { settings } from '../run/settings';

export interface TlsTargetOptions {
    /** Listeners (ports), default 1. */
    listeners?: number;
    /** Distinct leaf certificates among the listeners (default = listeners); the rest repeat leaf 1 (REG-DISC-08's repeat). */
    distinctLeaves?: number;
    /** Send leaf + intermediate (default true: REG-DISC-01 counts both); false sends the leaf alone (REG-DISC-08: 7 distinct). */
    withIntermediate?: boolean;
    /** Common-name stem of the leaves: `<stem>-<n>.example.test`, run-prefixed. */
    stem?: string;
    /** One stem per DISTINCT leaf (a trigger's rule can then match some leaves and not others); default: `stem` for all. */
    leafStems?: string[];
    env?: NodeJS.ProcessEnv;
}

interface ServedCertificate {
    pem: string;
    commonName: string;
    /** SHA-256 of the DER, lowercase hex: the form the inventory and the discovery rows use. */
    fingerprint: string;
    role: 'leaf' | 'intermediate';
}

export interface TlsTarget {
    host: string;
    ports: number[];
    /** The certificate (chain) served on each port, in port order. */
    served: ServedCertificate[][];
    /** Distinct certificates over all ports (leaves and the intermediate). */
    distinct(): ServedCertificate[];
    servedFingerprints(): string[];
    /** `host:port,…` form for v1 `ip` / `port` attributes. */
    ipAttribute(): string;
    portsAttribute(): string;
    close(): Promise<void>;
}

/** Why no scan target can be hosted ("deploy gate"), or undefined. A skip with this text is never coverage. */
export function scanTargetProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const host = settings(env).scanHost;
    if (!host) {
        return 'deploy gate: no scan target (REG_SCAN_HOST unset): a TLS endpoint the run controls and the tier\'s discovery connector can reach; DevOps item 5 on the shared tiers, a dotted host alias of the runner on a local stack';
    }
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(host) && !net.isIP(host)) {
        return `deploy gate: REG_SCAN_HOST "${host}" is neither a dotted host name nor an IP address (the discovery form accepts dotted names only)`;
    }
    return undefined;
}

export const scanHost = (env: NodeJS.ProcessEnv = process.env): string => settings(env).scanHost;

interface Issued {
    cert: forge.pki.Certificate;
    pem: string;
    key: forge.pki.rsa.PrivateKey;
}

const SERIAL = (): string => `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;

function issue(opts: {
    commonName: string;
    publicKey: forge.pki.rsa.PublicKey;
    signerKey: forge.pki.rsa.PrivateKey;
    signerName: forge.pki.CertificateField[];
    ca: boolean;
    dns?: string[];
    days?: number;
}): forge.pki.Certificate {
    const cert = forge.pki.createCertificate();
    cert.publicKey = opts.publicKey;
    cert.serialNumber = SERIAL();
    const now = new Date(Date.now() - 60_000);
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getTime() + (opts.days ?? 30) * 24 * 3600 * 1000);
    const subject = [{ name: 'commonName', value: opts.commonName }];
    cert.setSubject(subject);
    cert.setIssuer(opts.signerName);
    const extensions: Array<Record<string, unknown>> = [{ name: 'basicConstraints', cA: opts.ca }];
    if (opts.dns?.length) extensions.push({ name: 'subjectAltName', altNames: opts.dns.map((d) => ({ type: 2, value: d })) });
    cert.setExtensions(extensions);
    cert.sign(opts.signerKey, forge.md.sha256.create());
    return cert;
}

const fingerprintOf = (cert: forge.pki.Certificate): string => sha256Hex(Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'));

/** The domain of every common name this module builds. */
const LEAF_DOMAIN = 'example.test';

/**
 * The common name of leaf number `index` (from 1): `<run id>-<stem>-<unique>-<index>.example.test`, refused when it is
 * longer than a certificate common name may be (64 characters). The stem is the spec's own part of the name, so a stem
 * that is too long for the run id's length fails here with the limit named, before any listener opens.
 */
export function leafCommonName(stem: string, unique: string, index: number, id: string = runId()): string {
    return checkedCommonName(`${id}-${stem}-${unique}-${index}.${LEAF_DOMAIN}`);
}

/**
 * Starts the listeners and returns the target. The caller closes it in `afterAll` (`close()` is idempotent). Generates the
 * certificates synchronously first, so a failure leaves no listener behind.
 */
export async function startTlsTarget(opts: TlsTargetOptions = {}): Promise<TlsTarget> {
    const env = opts.env ?? process.env;
    const problem = scanTargetProblem(env);
    if (problem) throw new Error(problem);
    const listeners = Math.max(1, opts.listeners ?? 1);
    const distinct = Math.min(listeners, Math.max(1, opts.distinctLeaves ?? listeners));
    const withIntermediate = opts.withIntermediate ?? true;
    const stem = opts.stem ?? 'scan';

    const rootKeys = newKeyMaterial().keys;
    const rootName = [{ name: 'commonName', value: runCommonName('scan-root') }];
    const root = issue({ commonName: runCommonName('scan-root'), publicKey: rootKeys.publicKey, signerKey: rootKeys.privateKey, signerName: rootName, ca: true, days: 60 });
    const interKeys = newKeyMaterial().keys;
    const intermediateCommonName = runCommonName('scan-ca');
    const inter = issue({ commonName: intermediateCommonName, publicKey: interKeys.publicKey, signerKey: rootKeys.privateKey, signerName: root.subject.attributes as forge.pki.CertificateField[], ca: true, days: 45 });
    const interName = inter.subject.attributes as forge.pki.CertificateField[];
    const leafKeys = newKeyMaterial().keys;
    const unique = uniqueSuffix();

    const leaves: Issued[] = [];
    for (let i = 0; i < distinct; i++) {
        const cn = leafCommonName(opts.leafStems?.[i] ?? stem, unique, i + 1);
        const cert = issue({ commonName: cn, publicKey: leafKeys.publicKey, signerKey: interKeys.privateKey, signerName: interName, ca: false, dns: [cn], days: 30 });
        leaves.push({ cert, pem: forge.pki.certificateToPem(cert), key: leafKeys.privateKey });
    }
    const interPem = forge.pki.certificateToPem(inter);
    const leafKeyPem = forge.pki.privateKeyToPem(leafKeys.privateKey);

    const asServed = (leaf: Issued): ServedCertificate[] => {
        const served: ServedCertificate[] = [{ pem: leaf.pem, commonName: String(leaf.cert.subject.getField('CN').value), fingerprint: fingerprintOf(leaf.cert), role: 'leaf' }];
        if (withIntermediate) served.push({ pem: interPem, commonName: intermediateCommonName, fingerprint: fingerprintOf(inter), role: 'intermediate' });
        return served;
    };

    const servers: tls.Server[] = [];
    const ports: number[] = [];
    const served: ServedCertificate[][] = [];
    const bind = settings(env).scanBind;
    try {
        for (let i = 0; i < listeners; i++) {
            const leaf = leaves[i < distinct ? i : 0];
            const chain = withIntermediate ? `${leaf.pem}${interPem}` : leaf.pem;
            const server = tls.createServer({ key: leafKeyPem, cert: chain, minVersion: 'TLSv1.2' }, (socket) => {
                socket.on('error', () => undefined);
                socket.end();
            });
            server.on('tlsClientError', () => undefined);
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, bind, () => resolve());
            });
            servers.push(server);
            ports.push((server.address() as net.AddressInfo).port);
            served.push(asServed(leaf));
        }
    } catch (e) {
        await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
        throw e;
    }

    const distinctServed = (): ServedCertificate[] => {
        const seen = new Map<string, ServedCertificate>();
        for (const chain of served) for (const c of chain) seen.set(c.fingerprint, c);
        return [...seen.values()];
    };
    let closed = false;
    return {
        host: scanHost(env),
        ports,
        served,
        distinct: distinctServed,
        servedFingerprints: () => distinctServed().map((c) => c.fingerprint).sort(),
        ipAttribute: () => scanHost(env),
        portsAttribute: () => ports.join(','),
        close: async () => {
            if (closed) return;
            closed = true;
            await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
        },
    };
}

/** A dark `/29` (6 usable addresses) of the first documentation range: a run that completes in seconds with no certificate. */
export const DARK_SMALL = '192.0.2.8/29';
/**
 * Two dark documentation /24 ranges (508 targets = two chunks of 256 on the v2 connector): REG-DISC-03's extra work next to the own target.
 */
export const DARK_TWO_RANGES = '192.0.2.0/24,198.51.100.0/24';
/**
 * Three dark documentation /24 ranges (762 usable targets, ~6 minutes at parallelism 1 and a 500 ms connect timeout): held in progress
 * while API-DISC-03 walks the state matrix.
 */
export const DARK_LARGE = '192.0.2.0/24,198.51.100.0/24,203.0.113.0/24';
