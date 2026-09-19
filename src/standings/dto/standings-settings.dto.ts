import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { QUALIFY_TOP_OPTIONS } from '../standings.constants';

export class PointsRuleDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  win?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  draw?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  loss?: number;
}

/** Admin patch of the per-season standings settings (all fields optional). */
export class UpdateStandingsSettingsDto {
  @IsOptional()
  @IsIn(QUALIFY_TOP_OPTIONS as unknown as number[])
  qualifyTop?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => PointsRuleDto)
  points?: PointsRuleDto;
}
