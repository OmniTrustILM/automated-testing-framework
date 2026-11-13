/** json — the one type for a parsed JSON object (`JsonObject`) and its guard `isJsonObject`; pure. */

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const objectOf = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

export const rowsOf = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isJsonObject) : []);
