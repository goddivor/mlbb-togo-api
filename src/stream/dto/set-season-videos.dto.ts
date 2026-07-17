import { IsArray, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { StreamVideoDto } from './update-stream-config.dto';

export class SetSeasonVideosDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StreamVideoDto)
  videos?: StreamVideoDto[];
}
