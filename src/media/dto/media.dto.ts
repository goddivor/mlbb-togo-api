import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MEDIA_PURPOSES, MEDIA_STATUSES } from '../media.logic';

const OBJECT_ID = /^$|^[a-f0-9]{24}$/i;

export class SignUploadDto {
  @IsIn(MEDIA_PURPOSES)
  purpose!: string;

  /** Id of the record the image belongs to; omitted while it is being created. */
  @IsOptional()
  @IsString()
  @Matches(OBJECT_ID, { message: 'Cible invalide.' })
  targetId?: string | null;
}

export class ConfirmUploadDto extends SignUploadDto {
  @IsString()
  @MaxLength(300)
  @Matches(/^[A-Za-z0-9_\-/]+$/, { message: 'Identifiant d’image invalide.' })
  publicId!: string;
}

export class RejectMediaDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string | null;
}

export class ListMediaQueryDto {
  @IsOptional()
  @IsIn(MEDIA_PURPOSES)
  purpose?: string;

  @IsOptional()
  @IsIn(MEDIA_STATUSES)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  uploader?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
}
