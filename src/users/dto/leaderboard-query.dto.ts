import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Metrics the leaderboard can be ranked by. */
export const LEADERBOARD_METRICS = [
  'winRate',
  'wins',
  'mvpCount',
  'streak',
] as const;

export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

const toInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
};

export class LeaderboardQueryDto {
  /** Ranking metric. Defaults to win rate. */
  @IsOptional()
  @IsIn(LEADERBOARD_METRICS as unknown as string[])
  metric?: LeaderboardMetric;

  /** Hero-role key (tank, fighter, assassin, mage, marksman, support). */
  @IsOptional()
  @IsString()
  role?: string;

  /** Restrict to players who took part in that esport season. */
  @IsOptional()
  @IsString()
  seasonId?: string;

  /**
   * Minimum number of games played to appear. Protects the podium from
   * accounts sitting at 100% win rate after a single match.
   */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(1000)
  minGames?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
