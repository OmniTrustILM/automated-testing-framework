/**
 * attributeVersion — the one place that turns a definition's `version` (a NUMBER in core's lists) into the request attribute's
 * string code `"v3"` / `"v2"`; copying the number made every create answer 400.
 */

export function requestVersion(def: object | undefined, fallback: 'v2' | 'v3' = 'v2'): 'v2' | 'v3' {
    const raw = String((def as { version?: unknown } | undefined)?.version ?? '').trim().toLowerCase().replace(/^v/, '');
    return raw === '3' ? 'v3' : raw === '2' ? 'v2' : fallback;
}
