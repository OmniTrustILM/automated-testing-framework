/**
 * attributeVersion — the ONE place that turns an attribute definition's `version` into the request attribute's `version`.
 * Core sends a definition's version as a NUMBER (`3`, `2`) in the attribute lists and details; the request side wants the
 * string code `"v3"` / `"v2"` (`RequestAttribute` is polymorphic on it). Copying the number made every create answer 400
 * "Unable to read HTTP message" (seen on a live tier, 42 tests). Every helper that builds a request attribute from a definition or from
 * a response attribute calls `requestVersion`; unit fixtures use the numeric form core sends (and the string forms).
 */
type Json = Record<string, any>;

/** 3 / '3' / 'v3' / 'V3' → 'v3'; 2 / '2' / 'v2' → 'v2'; anything else (absent included) → `fallback`. */
export function requestVersion(def: Json | undefined, fallback: 'v2' | 'v3' = 'v2'): 'v2' | 'v3' {
    const raw = String(def?.version ?? '').trim().toLowerCase().replace(/^v/, '');
    return raw === '3' ? 'v3' : raw === '2' ? 'v2' : fallback;
}
