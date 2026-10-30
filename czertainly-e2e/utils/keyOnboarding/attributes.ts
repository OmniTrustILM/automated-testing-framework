/**
 * attributes — request attributes the key onboarding specs send.
 *
 * Provides the attribute definition shape, lookup by name, the option a list attribute offers for a value, and the
 * request item that answers a definition. Core accepts an offered option only verbatim, so a value is always looked up
 * in the definition first. Ported from the developers' suite unchanged.
 */
const REQUEST_ATTRIBUTE_VERSION = 'v3';

export interface AttributeDefinition {
  uuid: string;
  name: string;
  contentType: string;
  content?: Array<{ data: unknown; reference?: string }>;
}

export function definitionNamed(definitions: AttributeDefinition[], name: string): AttributeDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new Error(`Attribute '${name}' is not offered; offered: ${definitions.map((d) => d.name).join(', ')}`);
  }
  return definition;
}

/** The option a list attribute offers for a value, whole, because Core accepts only an offered option verbatim. */
export function offered(definition: AttributeDefinition, data: unknown): { data: unknown; reference?: string } {
  const option = definition.content?.find((candidate) => candidate.data === data);
  if (!option) {
    const options = (definition.content ?? []).map((candidate) => String(candidate.data)).join(', ');
    throw new Error(`Attribute '${definition.name}' offers no ${String(data)}; offered: ${options}`);
  }
  return option;
}

export function requestAttribute(definition: AttributeDefinition, content: Array<Record<string, unknown>>) {
  return {
    name: definition.name,
    uuid: definition.uuid,
    contentType: definition.contentType,
    version: REQUEST_ATTRIBUTE_VERSION,
    content: content.map((item) => ({ contentType: definition.contentType, ...item })),
  };
}
