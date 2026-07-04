import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { CatalogResolver } from './catalog.resolver';

// GraphQL layer (code-first) exposed on /graphql, coexisting with REST.
// Catalog reads (heroes, lanes, esport, sponsors) served from the DB cache.
@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true, // schema generated in memory (code-first)
      sortSchema: true,
      playground: false,
      introspection: true,
    }),
  ],
  providers: [CatalogResolver],
})
export class GqlModule {}
