import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateTournamentDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  organizer?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  prizePool?: string;

  @IsOptional()
  @IsInt()
  maxTeams?: number;

  @IsOptional()
  @IsArray()
  registeredTeams?: any[];

  @IsOptional()
  @IsArray()
  brackets?: any[];

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsString()
  rules?: string;

  @IsOptional()
  @IsString()
  banner?: string;

  @IsOptional()
  @IsString()
  streamUrl?: string;

  @IsOptional()
  @IsString()
  city?: string;
}
