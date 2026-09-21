import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AWARD_CATEGORIES, AwardCategory } from '../awards.logic';

const HTTP_URL = /^https?:\/\/\S+$/i;

export class CreateAwardDto {
  @IsIn(AWARD_CATEGORIES as unknown as string[])
  category!: AwardCategory;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsMongoId()
  userId?: string;

  @IsOptional()
  @IsMongoId()
  teamId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(HTTP_URL, { message: 'imageUrl doit être une URL http(s).' })
  imageUrl?: string;

  /** Stats snapshot (free JSON object, usually the suggestion criteria). */
  @IsOptional()
  @IsObject()
  criteria?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sort?: number;
}

export class UpdateAwardDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @IsOptional()
  @IsMongoId()
  userId?: string | null;

  @IsOptional()
  @IsMongoId()
  teamId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(HTTP_URL, { message: 'imageUrl doit être une URL http(s).' })
  imageUrl?: string | null;

  @IsOptional()
  @IsObject()
  criteria?: Record<string, unknown> | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sort?: number;
}

export class PodiumEntryDto {
  @IsInt()
  @Min(1)
  @Max(3)
  placement!: number;

  @IsMongoId()
  teamId!: string;
}

/**
 * PUT /awards/seasons/:id/podium
 *  - `regular`: manual override of the regular-season podium (`null` = back
 *    to the automatic standings podium);
 *  - `playoffs`: manual playoffs podium (`null` = derived automatically);
 *  - `derivePlayoffs`: `matches` (playoff-stage matches) or `tournament`
 *    (bracket of `tournamentId`) fills `playoffs` from the results.
 */
export class SetPodiumDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PodiumEntryDto)
  regular?: PodiumEntryDto[] | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PodiumEntryDto)
  playoffs?: PodiumEntryDto[] | null;

  @IsOptional()
  @IsIn(['matches', 'tournament'])
  derivePlayoffs?: 'matches' | 'tournament';

  @IsOptional()
  @IsMongoId()
  tournamentId?: string;
}

export class SuggestAwardsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  minGames?: number;
}
