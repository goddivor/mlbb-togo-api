import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class StartLiveDto {
  @IsString()
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsIn(['public', 'unlisted', 'private'])
  privacy?: string;
}
