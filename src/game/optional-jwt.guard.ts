import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Lets anonymous requests through while still resolving `req.user` when a
 * valid bearer token is present (public routes with owner-only extras).
 */
@Injectable()
export class OptionalJwtGuard extends AuthGuard('jwt') {
  handleRequest(_err: any, user: any) {
    return user || null;
  }
}
