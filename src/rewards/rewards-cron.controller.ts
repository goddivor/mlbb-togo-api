import { Controller, Get, Headers, HttpCode, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { RewardsAdminService } from './rewards-admin.service';

/** True when `header` is exactly `Bearer <secret>` (constant-time compare). */
export function isCronAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Daily rewards job. Vercel Cron calls it with GET and
 * `Authorization: Bearer ${CRON_SECRET}`; POST is accepted for manual runs.
 */
@Controller('rewards/cron')
export class RewardsCronController {
  constructor(private readonly admin: RewardsAdminService) {}

  @Get('daily')
  daily(@Headers('authorization') auth?: string) {
    return this.run(auth);
  }

  @Post('daily')
  @HttpCode(200)
  dailyPost(@Headers('authorization') auth?: string) {
    return this.run(auth);
  }

  private run(auth?: string) {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new ServiceUnavailableException('CRON_SECRET non configuré.');
    if (!isCronAuthorized(auth, secret)) throw new UnauthorizedException();
    return this.admin.runDaily();
  }
}
