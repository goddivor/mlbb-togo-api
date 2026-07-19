import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateDraftTournamentDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(['1v1', '3v3', '5v5'])
  category!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];
}

export class UpdateDraftTournamentDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsString()
  registrationOpensAt?: string;

  @IsOptional()
  @IsString()
  registrationClosesAt?: string;
}

export class RegisterDto {
  @IsString()
  @MaxLength(40)
  preferredRole!: string;
}

export class SetWinnerDto {
  @IsString()
  winnerTeamId!: string;
}

export class SecondPhaseDto {
  @IsOptional()
  @IsString()
  closesAt?: string;
}
