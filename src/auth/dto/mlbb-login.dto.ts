import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class MlbbSendVcDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roleId: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  zoneId: number;
}

export class MlbbLoginDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roleId: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  zoneId: number;

  @Type(() => Number)
  @IsInt()
  vc: number;
}
