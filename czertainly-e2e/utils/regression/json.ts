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

/** The value as a JSON object; `{}` when it is anything else (a missing member reads as an empty object). */
export const objectOf = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

/** The value as a list of JSON objects: its object elements; `[]` when it is not a list. */
export const rowsOf = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isJsonObject) : []);
