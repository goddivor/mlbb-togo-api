import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

export class GenerateBracketDto {
  @IsOptional()
  @IsIn(['random', 'order'])
  seeding?: 'random' | 'order';
}

export class MatchResultDto {
  @IsInt()
  @Min(0)
  scoreA: number;

  @IsInt()
  @Min(0)
  scoreB: number;

  @IsOptional()
  @IsString()
  winnerTeamId?: string;
}

export class ScheduleMatchDto {
  @IsOptional()
  @ValidateIf((o) => o.scheduledAt !== null)
  @IsString()
  scheduledAt?: string | null;

  @IsOptional()
  @ValidateIf((o) => o.streamUrl !== null)
  @IsString()
  streamUrl?: string | null;
}

export class MatchStatusDto {
  @IsIn(['pending', 'scheduled', 'live', 'finished'])
  status: 'pending' | 'scheduled' | 'live' | 'finished';
}

export class SetMvpDto {
  @ValidateIf((o) => o.userId !== null)
  @IsString()
  userId: string | null;
}
