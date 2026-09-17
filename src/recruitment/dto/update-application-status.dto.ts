import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  APPLICATION_STATUSES,
  ApplicationStatus,
} from '../recruitment.constants';

export class UpdateApplicationStatusDto {
  /**
   * Target status. The service decides whether the caller may set it (team
   * owner/staff for shortlisted, accepted, rejected — candidate only for
   * withdrawn) and whether the transition is allowed from the current status.
   */
  @IsIn(APPLICATION_STATUSES as unknown as string[])
  status!: ApplicationStatus;

  /** Short note shown to the candidate with the decision. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
