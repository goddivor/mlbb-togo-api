import { IsBoolean, IsOptional, IsString } from 'class-validator';

/** Admin/moderator moderation patch: pin and sponsoring. */
export class UpdatePostDto {
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsBoolean()
  isSponsored?: boolean;

  /** Sponsor to attach; `null` detaches it. */
  @IsOptional()
  @IsString()
  sponsorId?: string | null;
}
