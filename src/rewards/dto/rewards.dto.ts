import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
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
  /** Omitted = every user with progress. */
  @IsOptional()
  @IsMongoId()
  userId?: string;
}
