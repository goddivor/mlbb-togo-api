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
import { CONTENT_FORMATS, MAX_POST_IMAGES } from '../../posts/posts.constants';

/** Quick announcement posted from the league control room (#56). */
export class LeagueAnnounceDto {
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

  @IsOptional()
  @IsBoolean()
  pin?: boolean;
}
