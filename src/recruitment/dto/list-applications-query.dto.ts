import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ESPORT_ROLES } from '../../esport/esport.service';
import {
  APPLICATION_STATUSES,
  ApplicationStatus,
  MAX_RANK_LEVEL,
  RECRUITMENT_AVAILABILITY,
  RecruitmentAvailability,
} from '../recruitment.constants';
import { toInt } from './list-campaigns-query.dto';

export class ListApplicationsQueryDto {
  /**
   * Life-cycle filter. `active` is the recruiter's inbox (pending +
   * shortlisted) and is the default: a shortlist is unusable when the
   * applications already answered drown the ones still waiting.
   */
  @IsOptional()
  @IsIn([...(APPLICATION_STATUSES as unknown as string[]), 'active', 'all'])
  status?: ApplicationStatus | 'active' | 'all';

  /** Lane the candidate applied for. */
  @IsOptional()
  @IsIn(ESPORT_ROLES as unknown as string[])
  role?: string;

  /**
   * Minimum rank level, compared against the snapshot taken when the
   * application was submitted (see `rankLevel` on RecruitmentApplication), so
   * that a shortlist does not silently reshuffle when a player ranks up.
   */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(MAX_RANK_LEVEL)
  minRankLevel?: number;

  /** Availability declared by the candidate. */
  @IsOptional()
  @IsIn(RECRUITMENT_AVAILABILITY as unknown as string[])
  availability?: RecruitmentAvailability;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
