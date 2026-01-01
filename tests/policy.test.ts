import { describe, expect, it } from 'vitest';
import { PermissionService } from '../src/executor/policy.js';

describe('PermissionService', () => {
  it('returns ask decision in ask mode by default', () => {
    const service = new PermissionService();
    const decision = service.decide('ask', 'workspace.read');
    expect(decision.decision).toBe('ask');
    expect(decision.snapshot.permission_mode).toBe('ask');
    expect(decision.snapshot.decision).toBe('ask');
    expect(decision.snapshot.sources[0]?.result).toBe('ask');
  });

  it('respects explicit overrides', () => {
    const service = new PermissionService();
    const decision = service.decide('ask', 'workspace.read', {
      overrides: { allowTools: ['workspace.read'] }
    });
    expect(decision.decision).toBe('allow');
  });

  it('denies dangerous tools unless yolo or explicitly allowed', () => {
    const service = new PermissionService();
    const denied = service.decide('auto', 'workspace.exec', { toolPermission: 'dangerous' });
    expect(denied.decision).toBe('deny');

    const allowed = service.decide('yolo', 'workspace.exec', { toolPermission: 'dangerous' });
    expect(allowed.decision).toBe('allow');
  });
});
