import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MergeImportedDto {
  /** Real member account that receives the legacy history. */
  @IsString()
  targetId!: string;
}

export class ExpectedEmailDto {
  /**
   * Address the owner will sign in with (Google adopts an account by email).
   * Empty or null clears it back to the placeholder mailbox.
   */
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string | null;
}
