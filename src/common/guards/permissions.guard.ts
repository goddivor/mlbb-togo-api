import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { hasAnyPermission } from '../../access/permissions';

/**
 * Enforces `@RequirePermissions(...)`. The permissions are resolved once per
 * request by the JWT strategy (`request.user.permissions`), from the roles
 * currently stored on the user: a role change applies on the next request.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = context.switchToHttp().getRequest();
    if (!user || !hasAnyPermission(user, required)) {
      throw new ForbiddenException(
        "Accès réservé : vous n'avez pas les droits nécessaires.",
      );
    }
    return true;
  }
}
