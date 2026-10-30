/**
 * contentOf — the content items of a request attribute, for unit tests that read what a builder produced.
 *
 * `contentOf(attribute)` returns the `content` list of a request attribute as items whose members can be read. Request
 * attributes are typed as JSON objects whose `content` is unknown, so without it each check would need a cast. A missing or
 * non-list `content` reads as an empty list.
 */
import type { JsonObject } from '../../../utils/regression/json';

export const contentOf = (attribute: JsonObject): Array<Record<string, any>> => (Array.isArray(attribute.content) ? (attribute.content as Array<Record<string, any>>) : []);
