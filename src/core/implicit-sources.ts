export interface ImplicitSourceEntry {
  path: string;
  kind: 'config' | 'policy' | 'project_instruction' | 'tool_manifest' | 'other';
  hash?: string;
  disabled?: boolean;
  redacted?: boolean;
}

export interface ImplicitSourcesSnapshot {
  disabled: boolean;
  reason?: string;
  sources: ImplicitSourceEntry[];
  precedence?: string[];
}

export function buildImplicitSourcesSnapshot(options: {
  disabled: boolean;
  reason?: string;
  sources?: ImplicitSourceEntry[];
  precedence?: string[];
}): ImplicitSourcesSnapshot {
  return {
    disabled: options.disabled,
    reason: options.reason,
    sources: options.sources ?? [],
    precedence: options.precedence
  };
}
