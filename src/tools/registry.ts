import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { ToolManifest, ToolManifestEntry, ToolPermission } from '../core/types.js';
import { hashCanonical } from '../core/hash.js';
import type { ToolDefinition } from './types.js';

export type SchemaValidationResult = { ok: true } | { ok: false; errors: string[] };

type ToolRecord = {
  definition: ToolDefinition;
  inputValidator?: ValidateFunction;
  outputValidator?: ValidateFunction;
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
const addFormatsFn = addFormats as unknown as (ajv: Ajv) => Ajv;
addFormatsFn(ajv);

export interface ToolRegistryOptions {
  allowDangerous?: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRecord>();
  private readonly allowDangerous: boolean;

  constructor(options: ToolRegistryOptions = {}) {
    this.allowDangerous = options.allowDangerous ?? false;
  }

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    if (definition.defaultPermission === 'dangerous' && !this.allowDangerous) {
      throw new Error(`Dangerous tool registration disabled: ${definition.name}`);
    }
    const inputValidator = compileSchema(definition.inputSchema, `${definition.name} input schema`);
    const outputValidator = compileSchema(definition.outputSchema, `${definition.name} output schema`);
    this.tools.set(definition.name, { definition, inputValidator, outputValidator });
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values(), (record) => record.definition);
  }

  getPermission(name: string): ToolPermission | undefined {
    return this.tools.get(name)?.definition.defaultPermission;
  }

  toManifest(): ToolManifest {
    const entries: ToolManifestEntry[] = [];
    for (const { definition: tool } of this.tools.values()) {
      entries.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        schema_hash: tool.inputSchema ? hashCanonical(tool.inputSchema) : undefined,
        output_schema: tool.outputSchema,
        output_schema_hash: tool.outputSchema ? hashCanonical(tool.outputSchema) : undefined,
        permission: tool.defaultPermission
      });
    }
    return { tools: entries };
  }

  validateInput(name: string, input: unknown): SchemaValidationResult {
    const record = this.tools.get(name);
    if (!record?.inputValidator) return { ok: true };
    const ok = record.inputValidator(input);
    return ok ? { ok: true } : { ok: false, errors: formatErrors(record.inputValidator.errors) };
  }

  validateOutput(name: string, output: unknown): SchemaValidationResult {
    const record = this.tools.get(name);
    if (!record?.outputValidator) return { ok: true };
    const ok = record.outputValidator(output);
    return ok ? { ok: true } : { ok: false, errors: formatErrors(record.outputValidator.errors) };
  }
}

function compileSchema(schema: unknown, label: string): ValidateFunction | undefined {
  if (!schema) return undefined;
  try {
    return ajv.compile(schema as any);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${detail}`);
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['invalid schema'];
  return errors.map((err) => {
    const path = err.instancePath && err.instancePath.length > 0 ? err.instancePath : '/';
    const message = err.message ?? 'invalid';
    return `${path} ${message}`.trim();
  });
}
