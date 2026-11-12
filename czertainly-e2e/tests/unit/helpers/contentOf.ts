/**
 * contentOf — the content items of a request attribute, for the unit tests that read what a builder produced.
 *
 * WHAT: `contentOf(attribute)` returns the `content` list of a request attribute as items whose members can be read.
 * WHY: request attributes are typed as JSON objects, whose `content` is unknown; a test that checks the first item's data would need a cast
 * on every line.
 * HOW: pure; a missing or non-list `content` reads as an empty list.
 */
import type { JsonObject } from '../../../utils/regression/json';

export const contentOf = (attribute: JsonObject): Array<Record<string, any>> => (Array.isArray(attribute.content) ? (attribute.content as Array<Record<string, any>>) : []);
