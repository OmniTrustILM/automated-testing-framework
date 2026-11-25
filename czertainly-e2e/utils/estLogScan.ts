/**
 * estLogScan — finds secrets and key material in log text.
 *
 * WHAT: matches log text against needles — fixed patterns that never belong in a log (a Basic
 * `Authorization` value, a PEM private key) and run-specific values (a Basic password, the base64
 * of a CSR or a key) — and reports where each one was found.
 * WHY: EST carries passwords, certification requests and server-generated keys; none of them may
 * reach the logs of the platform or of the proxies in front of it.
 * HOW: `scanLogs` takes the text of each log source and returns the source, needle label and line
 * number of every hit, never the line itself, so a failing check does not copy the secret into
 * the report. A DER value is looked for by the start of its base64, which is how a body or a
 * truncated dump would show it.
 */

export interface LogNeedle {
  label: string;
  /** A literal value, or a pattern for values that are not known in advance. */
  pattern: string | RegExp;
}

export interface LogHit {
  source: string;
  label: string;
  line: number;
}

/** What may never appear in a log, whatever the run sent. */
export const FIXED_NEEDLES: LogNeedle[] = [
  { label: 'Authorization: Basic value', pattern: /authorization\W{1,8}basic\s+[a-z0-9+/=]{8,}/i },
  { label: 'PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** The first characters of the base64 of a DER value. */
export function base64Prefix(der: Buffer, length = 64): string {
  return der.toString('base64').slice(0, length);
}

function matches(line: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line);
}

export function scanLogs(logs: Record<string, string>, needles: LogNeedle[]): LogHit[] {
  const hits: LogHit[] = [];
  for (const [source, text] of Object.entries(logs)) {
    text.split('\n').forEach((line, index) => {
      for (const needle of needles) {
        if (matches(line, needle.pattern)) hits.push({ source, label: needle.label, line: index + 1 });
      }
    });
  }
  return hits;
}

/** Whole seconds since the instant, rounded up, plus a margin for clock skew. */
export function secondsSince(startIso: string | undefined, now: Date, fallbackSeconds: number, marginSeconds = 30): number {
  const start = startIso ? Date.parse(startIso) : Number.NaN;
  if (Number.isNaN(start)) return fallbackSeconds;
  return Math.ceil((now.getTime() - start) / 1000) + marginSeconds;
}
