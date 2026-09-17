import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Read state the history page can be narrowed down to. */
export const NOTIFICATION_STATUSES = ['all', 'unread', 'read'] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Page size used when the client does not ask for one. */
export const DEFAULT_NOTIFICATIONS_LIMIT = 20;

/**
 * Hard cap on the page size. The dropdown asks for a handful of rows, the
 * dedicated page for 20; anything above 50 would only be a way to dump a whole
 * mailbox in one request.
 */
export const MAX_NOTIFICATIONS_LIMIT = 50;

const toInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
};

export class NotificationsQueryDto {
  /**
   * Notification type (friend_request, message, tournament_open…).
   *
   * Deliberately *not* an `@IsIn` enum: types are minted by feature modules as
   * they ship (esport, tournaments…), and an allow-list here would reject a
   * brand-new type with a 400 instead of simply returning nothing. The
   * `counts` facet of the response tells the client which types the user
   * actually owns, so the filter UI never offers a dead option.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  /** Read state filter. Defaults to the full history. */
  @IsOptional()
  @IsIn(NOTIFICATION_STATUSES as unknown as string[])
  status?: NotificationStatus;

  /** 1-based page index. */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(MAX_NOTIFICATIONS_LIMIT)
  limit?: number;
}
