import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class StreamVideoDto {
  @IsString()
  @MaxLength(64)
  id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  day?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  duration?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  date?: string;
}

export class UpdateStreamConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  youtubeChannel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  liveTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  liveDesc?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  s1MainVideoId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StreamVideoDto)
  videos?: StreamVideoDto[];
}
