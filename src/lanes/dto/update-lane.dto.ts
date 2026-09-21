// Simple DTO for updating a lane (all fields optional).
export class UpdateLaneDto {
  name?: string;
  shortName?: string;
  description?: string;
  icon?: string;
  color?: string;
  compatibleClasses?: string[];
  sort?: number;
}
