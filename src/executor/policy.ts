import type {
  PermissionMode,
  ToolPermission,
  ToolPolicyEvaluation,
  ToolPolicySnapshot
} from '../core/types.js';

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'ask';
  snapshot: ToolPolicySnapshot;
  reason?: string;
}

export interface PermissionOverrides {
  allowTools?: string[];
  denyTools?: string[];
  allowPermissions?: ToolPermission[];
  denyPermissions?: ToolPermission[];
}

export interface PermissionDecisionContext {
  permissionMode?: PermissionMode;
  toolName: string;
  toolPermission?: ToolPermission;
  overrides?: PermissionOverrides;
}

export class PermissionService {
  decide(
    permissionMode: PermissionMode | undefined,
    toolName: string,
    options?: { toolPermission?: ToolPermission; overrides?: PermissionOverrides }
  ): PolicyDecision {
    const mode = permissionMode ?? 'ask';
    const overrides = options?.overrides;
    const toolPermission = options?.toolPermission;

    const denyTool = overrides?.denyTools?.includes(toolName);
    if (denyTool) {
      return buildDecision(mode, 'deny', 'deny', 'override:deny_tool', 'permission denied');
    }
    const denyPermission = toolPermission && overrides?.denyPermissions?.includes(toolPermission);
    if (denyPermission) {
      return buildDecision(mode, 'deny', 'deny', 'override:deny_permission', 'permission denied');
    }

    const allowTool = overrides?.allowTools?.includes(toolName);
    if (allowTool) {
      return buildDecision(mode, 'allow', 'allow', 'override:allow_tool');
    }
    const allowPermission = toolPermission && overrides?.allowPermissions?.includes(toolPermission);
    if (allowPermission) {
      return buildDecision(mode, 'allow', 'allow', 'override:allow_permission');
    }

    if (toolPermission === 'dangerous' && mode !== 'yolo') {
      return buildDecision(mode, 'deny', 'deny', 'permission_mode:dangerous', 'permission required');
    }

    if (mode === 'auto' || mode === 'yolo') {
      return buildDecision(mode, 'allow', 'allow', `permission_mode:${mode}`);
    }

    return buildDecision(mode, 'ask', 'ask', 'permission_mode:ask', 'approval required');
  }
}

export class SimplePolicyEngine extends PermissionService {}

function buildDecision(
  permissionMode: PermissionMode,
  decision: 'allow' | 'deny' | 'ask',
  result: ToolPolicyEvaluation['result'],
  rule: string,
  reason?: string
): PolicyDecision {
  return {
    decision,
    reason,
    snapshot: {
      permission_mode: permissionMode,
      decision,
      sources: [
        {
          source: 'codesdk',
          result,
          rule
        }
      ]
    }
  };
}
