import { IsString, IsOptional, IsInt } from 'class-validator';

export class CreateBattleSpellDto {
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
  cooldown?: string;

  @IsOptional()
  @IsInt()
  sort?: number;
}

export class UpdateBattleSpellDto {
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
  cooldown?: string | null;

  @IsOptional()
  @IsInt()
  sort?: number;
}
