/**
 * json — the one type for a parsed JSON object and its guard. Helpers that read API answers use `JsonObject`
 * (`Record<string, unknown>`) instead of a local `Record<string, any>`, and narrow with `isJsonObject` before they read a
 * member. Pure, no I/O.
 */

/** A parsed JSON object (not an array, not null). */
export type JsonObject = Record<string, unknown>;

/** True for a plain JSON object: not null, not an array. */
export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
