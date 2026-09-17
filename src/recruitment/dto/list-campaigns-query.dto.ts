import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ESPORT_ROLES } from '../../esport/esport.service';
import {
  MAX_RANK_LEVEL,
  RECRUITMENT_AVAILABILITY,
  RecruitmentAvailability,
} from '../recruitment.constants';

/** Query strings arrive as text; turn them into a real integer or into NaN
 * (which class-validator then rejects) instead of silently defaulting. */
export const toInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
};

export class ListCampaignsQueryDto {
  /** Keep the campaigns that opened a slot for that lane. */
  @IsOptional()
  @IsIn(ESPORT_ROLES as unknown as string[])
  role?: string;

  /**
   * The *browsing player's* rank level, not a minimum for the campaign: a
   * campaign is kept when its own requirement is at or below that level (or
   * when it has none). Filtering the other way round would hide exactly the
   * campaigns the player is eligible for.
   */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(MAX_RANK_LEVEL)
  rankLevel?: number;

  /**
   * Expected commitment. Campaigns that state no expectation welcome
   * everybody, so they are kept whatever the value asked for.
   */
  @IsOptional()
  @IsIn(RECRUITMENT_AVAILABILITY as unknown as string[])
  availability?: RecruitmentAvailability;

  /** Campaign state. Defaults to the open ones only. */
  @IsOptional()
  @IsIn(['open', 'closed', 'all'])
  status?: 'open' | 'closed' | 'all';

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
