import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export const SEASON_STATUS = ['upcoming', 'active', 'playoffs', 'closed'] as const;
export type SeasonStatus = (typeof SEASON_STATUS)[number];

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateSeasonDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(SLUG, { message: 'Slug invalide (lettres minuscules, chiffres et tirets).' })
  slug?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  number?: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  theme?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  slogan?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(SEASON_STATUS as unknown as string[])
  status?: SeasonStatus;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  playoffsStartDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  banner?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: 'Couleur invalide (format #RRGGBB).' })
  color?: string;

  /** Legacy flag: `true` activates the season (same as POST /activate). */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSeasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(SLUG, { message: 'Slug invalide (lettres minuscules, chiffres et tirets).' })
  slug?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  number?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  theme?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  slogan?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsString()
  startDate?: string | null;

  @IsOptional()
  @IsString()
  endDate?: string | null;

  @IsOptional()
  @IsString()
  playoffsStartDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  banner?: string | null;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: 'Couleur invalide (format #RRGGBB).' })
  color?: string | null;

  /** Legacy flag: `true` activates the season, `false` closes nothing (ignored). */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CloseSeasonDto {
  /** Force closing even when no completed match is attached to the season. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
