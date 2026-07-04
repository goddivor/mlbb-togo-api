import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

// GraphQL catalog types (read): heroes, lanes, esport, sponsors.
// Served from OUR database (cache), not from the Moonton API directly.

@ObjectType()
export class HeroModel {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field() role: string;
  @Field(() => [String]) roles: string[];
  @Field(() => [String]) laneKeys: string[];
  @Field({ nullable: true }) image?: string;
  @Field({ nullable: true }) art?: string;
  @Field({ nullable: true }) thumb?: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => Int, { nullable: true }) heroId?: number;
  @Field({ nullable: true }) source?: string;
}

@ObjectType()
export class LaneModel {
  @Field(() => ID) id: string;
  @Field() key: string;
  @Field() name: string;
  @Field({ nullable: true }) shortName?: string;
  @Field() description: string;
  @Field() icon: string;
  @Field({ nullable: true }) color?: string;
  @Field(() => [String]) compatibleClasses: string[];
  @Field(() => Int) sort: number;
}

@ObjectType()
export class EsportTeamModel {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field({ nullable: true }) image?: string;
  @Field({ nullable: true }) description?: string;
  @Field() type: string;
  @Field(() => Int) sort: number;
}

@ObjectType()
export class EsportOrgModel {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field({ nullable: true }) logo?: string;
  @Field({ nullable: true }) color?: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => [EsportTeamModel]) teams: EsportTeamModel[];
}

@ObjectType()
export class SponsorModel {
  @Field(() => ID) id: string;
  @Field({ nullable: true }) name?: string;
  @Field() logo: string;
  @Field({ nullable: true }) url?: string;
  @Field(() => Int) sort: number;
}
