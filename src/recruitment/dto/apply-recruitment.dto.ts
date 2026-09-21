import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ESPORT_ROLES } from '../../esport/esport.service';
import {
  RECRUITMENT_AVAILABILITY,
  RecruitmentAvailability,
} from '../recruitment.constants';

export class ApplyRecruitmentDto {
  /** Lane applied for. Must be one of the slots the campaign opened. */
  @IsOptional()
  @IsIn(ESPORT_ROLES as unknown as string[])
  role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;

  /** Commitment the candidate offers, used by the recruiter's filters. */
  @IsOptional()
  @IsIn(RECRUITMENT_AVAILABILITY as unknown as string[])
  availability?: RecruitmentAvailability;
}
