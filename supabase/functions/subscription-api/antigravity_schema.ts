// Adapted from internal/pkg/antigravity/schema_cleaner.go (LGPL-3.0-or-later).
import { HttpError } from './db.ts';
type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value);
const constraints: Record<string, string> = { minLength: 'minLen', maxLength: 'maxLen', pattern: 'pattern', minimum: 'min', maximum: 'max', multipleOf: 'multipleOf', exclusiveMinimum: 'exclMin', exclusiveMaximum: 'exclMax', minItems: 'minItems', maxItems: 'maxItems', propertyNames: 'propertyNames', format: 'format' };
const allowed = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'title']);
const own = (value: Schema, key: string) => Object.hasOwn(value, key);
function merge(target: Schema, source: Schema) {
  for (const [key, value] of Object.entries(source)) {
    if (key === 'properties' && object(value)) target.properties = { ...value, ...(object(target.properties) ? target.properties : {}) };
    else if (key === 'required' && Array.isArray(value)) target.required = [...new Set([...(Array.isArray(target.required) ? target.required : []), ...value])];
    else if (!own(target, key)) Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  }
}
function best(values: unknown[]): Schema {
  const score = (v: unknown) => !object(v) ? -1 : own(v, 'properties') || v.type === 'object' ? 3 : own(v, 'items') || v.type === 'array' ? 2 : own(v, 'enum') || own(v, 'const') || (typeof v.type === 'string' && v.type !== 'null' || Array.isArray(v.type) && v.type.some(t => typeof t === 'string' && t !== 'null')) ? 1 : 0;
  let selected: Schema = { type: 'string' }, maximum = -1;
  for (const value of values) if (object(value) && score(value) > maximum) { selected = value; maximum = score(value); }
  return selected;
}
function infer(value: unknown) { return typeof value === 'number' ? Number.isInteger(value) ? 'integer' : 'number' : typeof value === 'boolean' ? 'boolean' : 'string'; }

export function cleanAntigravitySchema(input: unknown): Schema {
  if (!object(input)) throw new HttpError(400, 'invalid_tool_schema');
  const root = structuredClone(input);
  const definitions: Schema = { ...(object(root.definitions) ? root.definitions : {}), ...(object(root.$defs) ? root.$defs : {}) };
  let visited = 0;
  function clean(value: unknown, refs: string[] = [], depth = 0): Schema {
    if (++visited > 10000 || depth > 64 || !object(value)) throw new HttpError(400, 'invalid_tool_schema');
    const schema = { ...value };
    if (own(schema, '$ref')) {
      const ref = schema.$ref;
      if (typeof ref !== 'string' || !/^#\/(?:\$defs|definitions)\/[^/]+$/.test(ref) || refs.includes(ref)) throw new HttpError(400, 'unsupported_tool_schema_reference');
      const name = ref.slice(ref.lastIndexOf('/') + 1).replaceAll('~1', '/').replaceAll('~0', '~');
      if (!own(definitions, name)) throw new HttpError(400, 'unsupported_tool_schema_reference');
      delete schema.$ref;
      merge(schema, clean(definitions[name], [...refs, ref], depth + 1));
    }
    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) merge(schema, clean(branch, refs, depth + 1));
      delete schema.allOf;
    }
    const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
    if (union && (!schema.type || String(schema.type).toLowerCase() === 'object')) merge(schema, clean(best(union), refs, depth + 1));
    if (Array.isArray(schema.prefixItems) && schema.prefixItems.length && (!object(schema.items))) schema.items = best(schema.prefixItems);
    if (Array.isArray(schema.items)) schema.items = best(schema.items);
    if (object(schema.properties)) schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, clean(child, refs, depth + 1)]));
    if (object(schema.items)) schema.items = clean(schema.items, refs, depth + 1);
    const hints = Object.entries(constraints).filter(([key]) => schema[key] != null).map(([key, label]) => `${label}: ${typeof schema[key] === 'object' ? JSON.stringify(schema[key]) : String(schema[key])}`);
    if (hints.length) schema.description = `${typeof schema.description === 'string' ? schema.description : ''} [Constraint: ${hints.join(', ')}]`;
    if (own(schema, 'const')) {
      schema.enum = Array.isArray(schema.enum) ? schema.enum.filter(v => v === schema.const) : [schema.const];
      if (!own(schema, 'type')) schema.type = infer(schema.const);
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const nullable = types.some(t => typeof t === 'string' && t.toLowerCase() === 'null');
    schema.type = types.find(t => typeof t === 'string' && t.toLowerCase() !== 'null');
    if (typeof schema.type === 'string') schema.type = schema.type.toLowerCase();
    else schema.type = schema.properties ? 'object' : schema.items ? 'array' : Array.isArray(schema.enum) && schema.enum.length ? infer(schema.enum[0]) : nullable || own(schema, 'enum') ? 'string' : 'object';
    if (Array.isArray(schema.enum)) {
      if (schema.enum.some(v => typeof v !== 'string')) schema.type = 'string';
      schema.enum = schema.enum.map(v => typeof v === 'string' ? v : String(v));
    }
    if (schema.type === 'array' && (!object(schema.items) || !Object.keys(schema.items).length)) schema.items = { type: 'string' };
    if (schema.type === 'object' && (!object(schema.properties) || !Object.keys(schema.properties).length)) {
      schema.properties = { reason: { type: 'string', description: 'Reason for calling this tool' } }; schema.required = ['reason'];
    }
    if (object(schema.properties) && Array.isArray(schema.required)) {
      schema.required = [...new Set(schema.required.filter(v => typeof v === 'string' && own(schema.properties as Schema, v)))];
      if (!(schema.required as unknown[]).length) delete schema.required;
    }
    if (nullable && !String(schema.description ?? '').includes('nullable')) schema.description = `${schema.description ?? ''} (nullable)`.trim();
    return Object.fromEntries(Object.entries(schema).filter(([key]) => allowed.has(key)));
  }
  return clean(root);
}

export function cleanAntigravityTools(request: Schema) {
  if (request.tools === undefined) return;
  if (!Array.isArray(request.tools)) throw new HttpError(400, 'invalid_tools');
  for (const tool of request.tools) {
    if (!object(tool)) throw new HttpError(400, 'invalid_tools');
    const declarations = tool.functionDeclarations;
    if (declarations === undefined) continue;
    if (!Array.isArray(declarations)) throw new HttpError(400, 'invalid_tools');
    for (const declaration of declarations) {
      if (!object(declaration)) throw new HttpError(400, 'invalid_tools');
      if (declaration.parameters !== undefined) declaration.parameters = cleanAntigravitySchema(declaration.parameters);
    }
  }
}
