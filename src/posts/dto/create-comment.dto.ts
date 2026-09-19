import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @IsOptional()
  @IsString()
  authorId?: string;

  /** Optional: the authenticated user's username takes precedence. */
  @IsOptional()
  @IsString()
  authorName?: string;

  @IsString()
  @MaxLength(5000)
  content: string;
}
