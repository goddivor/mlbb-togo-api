import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LANES, PickBanAction, PickBanMode, PickBanTeam } from '../pickban-order';

export class CreatePickBanDraftDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsIn(['ranked', 'tournament'])
  mode?: PickBanMode;
}

export class UpdatePickBanStepDto {
  @IsIn(['pick', 'ban'])
  action!: PickBanAction;

  @IsIn(['blue', 'red'])
  team!: PickBanTeam;

  @IsMongoId()
  heroId!: string; // our Hero id

  @IsOptional()
  @IsIn([...LANES])
  lane?: string; // picks only
}

export class PickBanPickDto {
  @IsString()
  heroId!: string;

  @IsOptional()
  @IsString()
  heroName?: string;

  @IsOptional()
  @IsString()
  lane?: string;
}

export class PickBanBanDto {
  @IsString()
  heroId!: string;

  @IsOptional()
  @IsString()
  heroName?: string;
}

export class PickBanTeamDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PickBanPickDto)
  picks!: PickBanPickDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PickBanBanDto)
  bans!: PickBanBanDto[];
}

export class SuggestPickBanDto {
  @IsIn(['ranked', 'tournament'])
  mode!: PickBanMode;

  @IsInt()
  @Min(0)
  currentStep!: number;

  @ValidateNested()
  @Type(() => PickBanTeamDto)
  blueTeam!: PickBanTeamDto;

  @ValidateNested()
  @Type(() => PickBanTeamDto)
  redTeam!: PickBanTeamDto;
}

// Structured reason so the client can localize it. `names` holds hero names,
// `lane` a lane key and `value` a percentage, depending on `kind`.
export interface SuggestionReason {
  kind:
    | 'counters'
    | 'counteredBy'
    | 'synergy'
    | 'lane'
    | 'threatens'
    | 'pairsWith'
    | 'winRate'
    | 'banRate';
  names?: string[];
  lane?: string;
  value?: number;
}

export interface HeroSuggestion {
  heroId: string;
  heroName: string;
  image?: string;
  thumb?: string;
  role?: string;
  reason: string; // English summary, e.g. "counters Ling, covers Gold lane"
  reasons: SuggestionReason[];
  score: number;
}

export interface SuggestPickBanResponseDto {
  suggestions: HeroSuggestion[];
  action: PickBanAction;
  team: PickBanTeam;
  metaAvailable: boolean; // false when counters/synergies could not be fetched
}
