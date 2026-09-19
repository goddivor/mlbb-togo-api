import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SPONSOR_TIERS } from '../sponsors.constants';

export class CreateSponsorOfferDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsIn(SPONSOR_TIERS as unknown as string[])
  tier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  priceLabel?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  benefits?: string[];

  @IsOptional()
  @IsBoolean()
  highlight?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sort?: number;
}

export class UpdateSponsorOfferDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsIn([...SPONSOR_TIERS, ''] as unknown as string[])
  tier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  priceLabel?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  benefits?: string[];

  @IsOptional()
  @IsBoolean()
  highlight?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sort?: number;
}
