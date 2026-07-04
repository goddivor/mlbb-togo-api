// DTO simple pour la mise à jour d'une lane (tous les champs optionnels).
export class UpdateLaneDto {
  name?: string;
  shortName?: string;
  description?: string;
  icon?: string;
  color?: string;
  compatibleClasses?: string[];
  sort?: number;
}
