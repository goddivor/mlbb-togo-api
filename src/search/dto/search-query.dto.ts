import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const toInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
};

export class SearchQueryDto {
  /**
   * Search query string. Empty or single character returns empty results (no error).
   * Searches by name/title/username across User, Hero, Team, Tournament, Event.
   */
  @IsOptional()
  @IsString()
  q?: string;

  /**
   * Maximum results per entity type (default 5).
   * Prevents returning too many records for broad searches.
   */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
