import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Semantics (see integrations.logic.ts `applyPatch`): a missing field keeps
// the stored value; for secrets an empty string also keeps it and `null`
// removes it; for plain fields an empty string or `null` clears it.

export class UpdateAnthropicDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  @Matches(/^$|^[\x21-\x7E]+$/, { message: 'Secret invalide (espaces et caractères non ASCII interdits).' })
  apiKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^$|^[A-Za-z0-9._:@-]+$/, { message: 'Identifiant de modèle invalide.' })
  model?: string | null;
}

export class UpdateCloudinaryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^$|^[A-Za-z0-9_-]+$/, { message: 'Nom de cloud invalide.' })
  cloudName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^$|^[\x21-\x7E]+$/, { message: 'Secret invalide (espaces et caractères non ASCII interdits).' })
  apiKey?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  @Matches(/^$|^[\x21-\x7E]+$/, { message: 'Secret invalide (espaces et caractères non ASCII interdits).' })
  apiSecret?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^$|^[A-Za-z0-9 _/-]+$/, { message: 'Dossier invalide.' })
  folder?: string | null;
}
