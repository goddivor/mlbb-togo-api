import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { CatalogResolver } from './catalog.resolver';

// Couche GraphQL (code-first) exposée sur /graphql, en coexistence avec le REST.
// Lecture du catalogue (héros, lanes, esport, sponsors) servie depuis le cache DB.
@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true, // schéma généré en mémoire (code-first)
      sortSchema: true,
      playground: false,
      introspection: true,
    }),
  ],
  providers: [CatalogResolver],
})
export class GqlModule {}
