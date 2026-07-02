import { IsString, MinLength } from 'class-validator';

export class AdminLoginDto {
  @IsString()
  username: string;

  @IsString()
  @MinLength(1)
  password: string;
}
