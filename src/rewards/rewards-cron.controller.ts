import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { RewardsAdminService } from './rewards-admin.service';
import { MediaService } from '../media/media.service';

/** Time budget of the media step, so the daily job stays within the function timeout. */
const MEDIA_BUDGET_MS = 10_000;

/** True when `header` is exactly `Bearer <secret>` (constant-time compare). */
export function isCronAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Daily job (rewards, then media cleanup). Vercel Cron calls it with GET and
 * `Authorization: Bearer ${CRON_SECRET}`; POST is accepted for manual runs.
 */
@Controller('rewards/cron')
export class RewardsCronController {
  constructor(
    private readonly admin: RewardsAdminService,
    private readonly media: MediaService,
  ) {}

  @Get('daily')
  daily(@Headers('authorization') auth?: string) {
    return this.run(auth);
  }

  @Post('daily')
  @HttpCode(200)
  dailyPost(@Headers('authorization') auth?: string) {
    return this.run(auth);
  }

  private async run(auth?: string) {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new ServiceUnavailableException('CRON_SECRET non configuré.');
    if (!isCronAuthorized(auth, secret)) throw new UnauthorizedException();
    const now = new Date();
    const daily = await this.admin.runDaily(now);
    return { ...daily, media: await runMediaStep(this.media, now) };
  }
}

/** Media step of the daily job: abandoned uploads sweep + orphan linking (never throws). */
export async function runMediaStep(media: Pick<MediaService, 'runMaintenance'>, now: Date, budgetMs = MEDIA_BUDGET_MS) {
  try {
    return await media.runMaintenance(now, { limit: 50, budgetMs });
  } catch (err) {
    new Logger('RewardsCron').error(`daily media failed: ${(err as Error)?.message}`);
    return { error: (err as Error)?.message ?? 'failed' };
  }
}
