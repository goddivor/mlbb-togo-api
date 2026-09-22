import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

/** `frameId` (or `frameId:variant`) to equip; null = no frame (rank frame). */
export class EquipFrameDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  frameId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  variant?: string | null;
}

/** Title id to equip; null = no title. */
export class EquipTitleDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  titleId?: string | null;
}

export class GrantFrameDto {
  @IsMongoId()
  userId!: string;

  @IsString()
  @MaxLength(64)
  frameId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  variant?: string;

  /** Temporary grant lifetime; omitted = catalogue default (permanent for most frames). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  days?: number;
}

export class EndFrameDto {
  @IsMongoId()
  userId!: string;

  @IsString()
  @MaxLength(64)
  frameId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  variant?: string;
}

export class XpCorrectionDto {
  @IsMongoId()
  userId!: string;

  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  @Min(-1_000_000)
  @Max(1_000_000)
  amount!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export const TOURNAMENT_RESULT_KINDS = ['winner', 'finalist', 'mvp'] as const;
export type TournamentResultKind = (typeof TOURNAMENT_RESULT_KINDS)[number];

export class TournamentResultDto {
  /** `Tournament` or `DraftTournament` id. */
  @IsMongoId()
  tournamentId!: string;

  @IsIn(TOURNAMENT_RESULT_KINDS as unknown as string[])
  kind!: TournamentResultKind;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsMongoId({ each: true })
  userIds!: string[];
}

export class MvpWeekDto {
  @IsMongoId()
  userId!: string;

  /** ISO week key (`2026-W38`); defaults to the previous week. */
  @IsOptional()
  @Matches(/^\d{4}-W\d{2}$/)
  week?: string;
}

export class RecalculateDto {
  /** Omitted = every user with progress, one page per call. */
  @IsOptional()
  @IsMongoId()
  userId?: string;

  /** `nextCursor` of the previous page (recalculate all). */
  @IsOptional()
  @IsMongoId()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Reward event (catalogue §6.5). Conditions and rewards are normalised by the service. */
export class RewardEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsIn(['none', 'yearly'])
  recurrence?: 'none' | 'yearly';

  @IsOptional()
  @IsIn(['draft', 'scheduled'])
  status?: 'draft' | 'scheduled';

  @IsOptional()
  @IsIn(['all', 'any'])
  conditionMode?: 'all' | 'any';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  conditions?: { type: string; count?: number; scope?: string | null }[];

  @IsOptional()
  @IsObject()
  rewards?: { achievementId?: string | null; frameId?: string | null; frameDays?: number | null; xp?: number };
}
