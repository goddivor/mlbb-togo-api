import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Restricts an endpoint to users holding AT LEAST ONE of the given permission
 * keys (see `src/access/permissions.ts`). `ANY_ADMIN` ('admin.*') accepts any
 * admin area permission. Use together with `JwtAuthGuard, PermissionsGuard`.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
