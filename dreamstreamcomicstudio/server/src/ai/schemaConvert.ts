// Convert a Google GenAI (Gemini) responseSchema to standard JSON Schema, so the
// same schema can drive OpenRouter's json_schema response_format.
//
// Gemini uses an enum `Type` with UPPERCASE values (OBJECT/STRING/ARRAY/…); JSON
// Schema wants lowercase ("object"/"string"/"array"/…). This walks the schema and
// maps types recursively, preserving items/properties/required/enum/description.

const TYPE_MAP: Record<string, string> = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object'
};

export const geminiSchemaToJsonSchema = (schema: any): any => {
  if (!schema || typeof schema !== 'object') return schema;

  const out: any = {};

  if (schema.type !== undefined) {
    const key = String(schema.type).toUpperCase();
    out.type = TYPE_MAP[key] || String(schema.type).toLowerCase();
  }
  if (typeof schema.description === 'string') out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.nullable === true) out.nullable = true;

  if (schema.items) out.items = geminiSchemaToJsonSchema(schema.items);

  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [propKey, propVal] of Object.entries(schema.properties)) {
      out.properties[propKey] = geminiSchemaToJsonSchema(propVal);
    }
  }
  if (Array.isArray(schema.required)) out.required = schema.required;

  return out;
};
