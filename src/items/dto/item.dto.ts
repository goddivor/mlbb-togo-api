import { IsString, IsOptional, IsInt } from 'class-validator';

export class CreateItemDto {
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
  gold?: number;

  @IsOptional()
  @IsInt()
  sort?: number;
}

export class UpdateItemDto {
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
  gold?: number | null;

  @IsOptional()
  @IsInt()
  sort?: number;
}
