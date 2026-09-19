import {
  IsEmail,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { REQUEST_STATUSES } from '../sponsors.constants';

export class CreateSponsorshipRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  company: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  contactName: string;

  @IsEmail()
  @MaxLength(160)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  message: string;

  @IsOptional()
  @IsMongoId()
  offerId?: string;
}

export class UpdateSponsorshipRequestDto {
  @IsOptional()
  @IsIn(REQUEST_STATUSES as unknown as string[])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNote?: string;
}
