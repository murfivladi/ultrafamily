import { describe, expect, it } from 'vitest';
import { permissionsForMembership, resolvePermission, type PermissionQuery } from './permissions';

const base: PermissionQuery = {
  role: 'adult',
  moduleId: 'calendar',
  action: 'read',
};

describe('hybrid role and permission model', () => {
  it('lets adults use ordinary organizational modules but not publish', () => {
    expect(resolvePermission(base)).toMatchObject({ allowed: true });
    expect(resolvePermission({ ...base, action: 'publish' })).toMatchObject({ allowed: false });
  });

  it('keeps guests read-only and limited to explicitly shared material', () => {
    expect(resolvePermission({ ...base, role: 'guest' })).toMatchObject({
      allowed: false,
      reason: 'guest_requires_explicit_share',
    });
    expect(resolvePermission({ ...base, role: 'guest', explicitlyShared: true })).toMatchObject({
      allowed: true,
    });
    expect(
      resolvePermission({
        ...base,
        role: 'guest',
        explicitlyShared: true,
        action: 'create',
      }),
    ).toMatchObject({ allowed: false, reason: 'guest_read_only' });
  });

  it('never lets platform administrators bypass household data isolation', () => {
    expect(
      resolvePermission({ ...base, role: 'space_owner', isPlatformAdmin: true }),
    ).toMatchObject({ allowed: false, reason: 'platform_role_has_no_data_access' });
  });

  it('enforces child restrictions even when an override allows an action', () => {
    expect(
      resolvePermission({
        ...base,
        role: 'child',
        moduleId: 'finances',
        override: 'allow',
      }),
    ).toMatchObject({ allowed: false, reason: 'child_restricted_module' });
    expect(
      resolvePermission({ ...base, role: 'child', action: 'publish', override: 'allow' }),
    ).toMatchObject({ allowed: false, reason: 'child_restricted_action' });
  });

  it('requires explicit grants for sensitive modules and respects disabled modules', () => {
    expect(resolvePermission({ ...base, moduleId: 'health', action: 'read' })).toMatchObject({
      allowed: false,
      reason: 'sensitive_grant_required',
    });
    expect(
      resolvePermission({
        ...base,
        moduleId: 'health',
        action: 'read',
        sensitiveGrant: true,
      }),
    ).toMatchObject({ allowed: true });
    expect(resolvePermission({ ...base, moduleEnabled: false })).toMatchObject({
      allowed: false,
      reason: 'module_disabled',
    });
  });

  it('honors explicit denials and allows per-module overrides', () => {
    expect(resolvePermission({ ...base, override: 'deny' })).toMatchObject({
      allowed: false,
      reason: 'denied_by_override',
    });
    expect(resolvePermission({ ...base, action: 'publish', override: 'allow' })).toMatchObject({
      allowed: true,
      reason: 'allowed_by_override',
    });
  });

  it('generates a bounded permission list for a membership', () => {
    const permissions = permissionsForMembership('adult');
    expect(permissions).toContain('calendar:read');
    expect(permissions).not.toContain('health:read');
    expect(permissions).not.toContain('calendar:publish');
  });
});
