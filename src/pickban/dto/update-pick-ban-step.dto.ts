export class UpdatePickBanStepDto {
  action: 'pick' | 'ban';
  team: 'blue' | 'red';
  heroId: string; // Hero _id
  lane?: string; // only for picks
}
