/**
 * contentOf — the content items of a request attribute, for unit tests that read what a builder produced.
 * `contentOf(attribute)` returns the `content` list of a request attribute as items whose members can be read.
 */
import type { JsonObject } from '../../../utils/regression/json';

export const contentOf = (attribute: JsonObject): Array<Record<string, any>> => (Array.isArray(attribute.content) ? (attribute.content as Array<Record<string, any>>) : []);
