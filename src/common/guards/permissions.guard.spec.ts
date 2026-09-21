import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { ANY_ADMIN } from '../../access/permissions';

function ctx(user: any): ExecutionContext {
  return {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardFor(required: string[] | undefined) {
  const reflector = { getAllAndOverride: jest.fn(() => required) } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

describe('PermissionsGuard', () => {
  const editor = { id: 'u', permissions: ['admin.league', 'forum.announce'] };

  it('lets undecorated endpoints through', () => {
    expect(guardFor(undefined).canActivate(ctx(null))).toBe(true);
    expect(guardFor([]).canActivate(ctx(null))).toBe(true);
  });

  it('accepts a user holding one of the required permissions', () => {
    expect(guardFor(['admin.league']).canActivate(ctx(editor))).toBe(true);
    expect(guardFor(['admin.users', 'forum.announce']).canActivate(ctx(editor))).toBe(true);
    expect(guardFor([ANY_ADMIN]).canActivate(ctx(editor))).toBe(true);
  });

  it('rejects users without the permission, and anonymous requests', () => {
    expect(() => guardFor(['admin.users']).canActivate(ctx(editor))).toThrow(ForbiddenException);
    expect(() => guardFor(['admin.league']).canActivate(ctx(undefined))).toThrow(ForbiddenException);
    expect(() => guardFor([ANY_ADMIN]).canActivate(ctx({ permissions: ['forum.announce'] }))).toThrow(
      ForbiddenException,
    );
  });

  it('does not trust the legacy roleUser once permissions are resolved', () => {
    expect(() =>
      guardFor(['admin.users']).canActivate(ctx({ roleUser: 'admin', permissions: [] })),
    ).toThrow(ForbiddenException);
  });
});
