import {
  IsString,
  IsOptional,
  IsInt,
  IsArray,
  IsMongoId,
  ArrayMaxSize,
} from 'class-validator';

export class CreateBuildDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsMongoId({ each: true })
  itemIds?: string[];

  @IsOptional()
  @IsMongoId()
  emblemId?: string;

  @IsOptional()
  @IsMongoId()
  battleSpellId?: string;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsInt()
  sort?: number;
}

export class UpdateBuildDto {
  @IsOptional()
  @IsString()
  name?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsMongoId({ each: true })
  itemIds?: string[];

  @IsOptional()
  @IsMongoId()
  emblemId?: string | null;

  @IsOptional()
  @IsMongoId()
  battleSpellId?: string | null;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsInt()
  sort?: number;
}
