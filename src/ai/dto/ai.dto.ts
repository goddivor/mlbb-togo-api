import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

const toLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const OBJECT_ID_MSG = 'must be a 24-character hexadecimal id';

export class LangQueryDto {
  @IsOptional()
  @Transform(toLower)
  @IsIn(['fr', 'en'])
  lang?: 'fr' | 'en';
}

export class RecommendHeroesDto {
  @IsOptional()
  @Transform(toLower)
  @IsString()
  @IsIn(['tank', 'fighter', 'assassin', 'mage', 'marksman', 'support'])
  role?: string;

  @IsOptional()
  @Transform(toLower)
  @IsString()
  @IsIn(['gold', 'exp', 'jungle', 'mid', 'roam'])
  lane?: string;
}

export class RecommendBuildDto {
  @IsString()
  @Matches(OBJECT_ID_RE, { message: `heroId ${OBJECT_ID_MSG}` })
  heroId: string;
}

export class CounterPicksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Matches(OBJECT_ID_RE, { each: true, message: `each heroId ${OBJECT_ID_MSG}` })
  heroIds: string[];
}
