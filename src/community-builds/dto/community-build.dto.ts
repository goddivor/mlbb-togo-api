import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { BUILD_LANES, LIMITS, REPORT_REASONS } from '../community-builds.rules';

// Shape checks only; business rules (catalog, tiers, quotas) live in the
// service and community-builds.rules.ts.

export class CreateCommunityBuildDto {
  /** Hero Mongo id or Moonton numeric hero id. */
  @IsString()
  @MaxLength(40)
  heroId!: string;

  @IsString()
  @MaxLength(LIMITS.titleMax * 2)
  title!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(LIMITS.notesMax * 2)
  notes?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== '')
  @IsIn(BUILD_LANES as unknown as string[])
  lane?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIMITS.items)
  @IsMongoId({ each: true })
  itemIds?: string[];

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsMongoId()
  emblemId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIMITS.talents)
  @IsMongoId({ each: true })
  talentIds?: string[];

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsMongoId()
  battleSpellId?: string | null;

  /** true = publish right away (default: save as draft). */
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class UpdateCommunityBuildDto {
  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.titleMax * 2)
  title?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(LIMITS.notesMax * 2)
  notes?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== '')
  @IsIn(BUILD_LANES as unknown as string[])
  lane?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIMITS.items)
  @IsMongoId({ each: true })
  itemIds?: string[];

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsMongoId()
  emblemId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIMITS.talents)
  @IsMongoId({ each: true })
  talentIds?: string[];

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsMongoId()
  battleSpellId?: string | null;
}

export class ReportCommunityBuildDto {
  @IsIn(REPORT_REASONS as unknown as string[])
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.reportDetailsMax)
  details?: string;
}

export class HideCommunityBuildDto {
  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.hideReasonMax)
  reason?: string;
}
