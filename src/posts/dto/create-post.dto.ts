import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import {
  CONTENT_FORMATS,
  MAX_POST_IMAGES,
  POST_CATEGORIES,
} from '../posts.constants';

export class CreatePostDto {
  @IsOptional()
  @IsString()
  authorId?: string;

  @IsOptional()
  @IsString()
  authorName?: string;

  @IsOptional()
  @IsString()
  authorRank?: string;

  @IsIn(POST_CATEGORIES)
  category: string;

  @IsString()
  @MaxLength(200)
  title: string;

  @IsString()
  @MaxLength(20000)
  content: string;

  @IsOptional()
  @IsIn(CONTENT_FORMATS)
  contentFormat?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POST_IMAGES)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { each: true })
  images?: string[];

  /** Admin only: ignored (400) for regular users. */
  @IsOptional()
  @IsBoolean()
  isSponsored?: boolean;

  @IsOptional()
  @IsString()
  sponsorId?: string;
}
