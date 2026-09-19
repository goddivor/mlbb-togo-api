import { IsString, IsOptional, IsInt } from 'class-validator';

export class CreateEmblemDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsInt()
  sort?: number;
}

export class UpdateEmblemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  icon?: string | null;

  @IsOptional()
  @IsString()
  type?: string | null;

  @IsOptional()
  @IsInt()
  sort?: number;
}
