
import 'reflect-metadata'
import fs from 'fs/promises'
import glob from 'glob'
import * as _ from 'lodash'
import { Application } from 'express'
import { GraphQLSchemaModule } from 'apollo-graphql'
import { gql as GQL, ApolloServer, ApolloServerExpressConfig, } from 'apollo-server-express'
import { GraphQLResolveInfo, GraphQLAbstractType, formatError, GraphQLFormattedError, GraphQLError } from 'graphql'

import {
  DispatchEvent, DispatchPredicate, Handler, HandlerDeclaration, HandlerRegistry, SecurityContext, Logger, Container, Authenticator, ANONYMOUS, Service
} from "@dits/dits"

import { buildSubgraphSchema } from '@apollo/federation'
import { ApolloServerPluginInlineTraceDisabled } from 'apollo-server-core'
import { DispatchEventKey } from '@dits/dits/lib/dispatch/dispatch'



const log = Logger('dits_apollo')

export class GQLEvent<A, P, CTX> extends DispatchEvent {

  constructor(
    public path: string,
    public args: A | undefined,
    public parent: P | undefined,
    public context: CTX,
    public info: GraphQLResolveInfo,
  ) {
    super('graphql')
  }
}


export type DitsApolloSchema = {
  typeDefs: string,
  resolvers: any
}
export interface DitsApolloSchemaFilter {
  (schema: DitsApolloSchema): DitsApolloSchema
}
export type DitsApolloConfig = {
  apollo?: ApolloServerExpressConfig,
  schemaFilters?: DitsApolloSchemaFilter[]
}

let reqIdx = 1
// export function createServer<HR>(app: Application, container: Container, registry: HandlerRegistry, config?: ApolloServerExpressConfig) {
export async function createServer<HR>(app: Application, container: Container, config?: DitsApolloConfig) {
  const registry = container.handlers as HandlerRegistry

  // const registry: HandlerRegistry | undefined = service.container?.get(HandlerRegistry)
  // if (!registry) {
  //   throw new Error('Could not initialize press: no zone handler registry found; are you sure you are running inside `initApp` handler?')
  // }

  const gqlSearchPath = process.env.GQL_SEARCH_PATH || './src/'
  const expression = `${gqlSearchPath}**/*.gql`

  // get the GQL files and concat
  const typeDefs = (await Promise.all(
    glob.sync(expression)
      .map(async (fqp) => {
        const sdl = await fs.readFile(fqp, 'utf-8')
        return sdl
      })
  )).join('\n')


  const declarations = registry.getDeclarations(GQLEvent)

  // set the path on resolvers 
  const resolvers: any = {}
  declarations.forEach(hr => {
    hr.metadata = hr.metadata || {}
    hr.metadata.resolvers = (Reflect.getMetadata(RESOLVER_META_KEY, hr.target.constructor) || []) as ResolverMeta[]

    hr.metadata.resolvers.forEach(({ path, method }: ResolverMeta) => {
      if (!path) {
        log.warn(`Bad HandlerDeclaration ${path} for resolver function ${method} on ${hr.target}; declaration:`, hr);
        throw new Error('Could not determine correct metadata for Handler');
      }
      // TODO fix definitions so that we don't duplicate handlers + resolvers
      // const existing = _.get(resolvers, path);
      // if (existing) {
      //   throw new Error(`Resolver Path ${path} already defined with ${existing}; could not set ${hr.target} `);
      // }
      _.set(resolvers, path, createHandlerResolver({ path }, hr, hr.target[method]));
    })
  })
  // log.info('shape of resolvers is', resolvers)


  const filters: DitsApolloSchemaFilter[] = (config?.schemaFilters || [])
  const templateSchema = filters.reduce((s, f) => f(s), { typeDefs, resolvers } as DitsApolloSchema)

  const schemata: GraphQLSchemaModule = {
    typeDefs: GQL(templateSchema.typeDefs),
    resolvers: templateSchema.resolvers
  }


  const apollo = config?.apollo || {}
  const schema = buildSubgraphSchema(schemata)
  const plugins = [
    ...(apollo?.plugins || []),
    ApolloServerPluginInlineTraceDisabled()
  ]


  const server: ApolloServer = new ApolloServer({
    debug: process.env.HX_GRAPHQL_DEBUG === 'true',
    // tracing: process.env.HX_GRAPHQL_TRACING === 'true',
    introspection: process.env.HX_GRAPHQL_INTROSPECTION_DISABLED === 'true' ? false : true,
    schema,
    formatError(error: GraphQLError) {
      log.warn('GraphQL Error', error)
      return formatError(error)
    },
    ...apollo,
    async context(express: any = {}) {
      let context = { express: { ...express, app } } as any
      if (apollo?.context && apollo.context instanceof Function) {
        context = await apollo.context(context)
      }
      return context
    },
    plugins
  });

  // log.info('server', server)


  await server.start()

  server.applyMiddleware({ app })

}




// export type ResolverPredicateSettings = {
//   path: string
// }

// export const ResolverPredicate: DispatchEventHof<GQLEvent<unknown, unknown, any>> = (path: string) => {
//   const pred = <A, P, CTX>(e: GQLEvent<A, P, CTX>, declaration: HandlerDeclaration<GQLEvent<A, P, CTX>>) => {
//     return true
//   }

//   const settings: ResolverPredicateSettings = { path }
//   Reflect.defineMetadata('gql_resolver', settings, pred)
//   return pred
// }




type HandlerResolver = <A, P, CTX, RT>({ path }: { path: string }, hd: HandlerDeclaration<GQLEvent<A, P, CTX>>, targetResolver: Function) =>
  (parent: P,
    args: A | undefined,
    context: CTX,
    info: GraphQLResolveInfo,
    abstractType: GraphQLAbstractType,
  ) => Promise<RT>

const createHandlerResolver: HandlerResolver =
  ({ path }, hd, targetResolver) => {
    const resolver = async <A, P, CTX, RT>(parent: P, args: A | undefined, context: CTX, info: GraphQLResolveInfo, absType: GraphQLAbstractType) => {
      const e = new GQLEvent(path, args, parent, context, info)

      const service = Service.fromZone()
      const container = Container.fromZone()
      const authenticator: Authenticator | undefined = container.get(Authenticator)
      const principal = authenticator ? await authenticator.authenticate(e) : ANONYMOUS

      const zone = await service.fork(`gql-${reqIdx++}`, {
        rootEvent: e,
        principal
      })
      let result
      try {
        return await zone.run(async () => {
          const child = Container.fromZone();

          // seems like this should come later, but causes issues if so
          await child.initialize('web', 'graphql')

          const sc = new SecurityContext(principal)
          child.provide(SecurityContext, sc, true)
          child.provide(GQLEvent, e, true)

          // automatically injected args!
          result = await targetResolver()
          return result
        }) as RT
      } catch (err) {
        log.warn('failed to do the zone thing', err)
        throw err
      } finally {
        // log.info('returned?', e.path, result)
      }
    }
    return resolver
  }


type ResolverMeta = { path: string, target: any, method: string }
export const RESOLVER_META_KEY = Symbol.for("dits_resolver");
export function Resolver(path: string, ...predicates: DispatchPredicate<GQLEvent<unknown, unknown, any>>[]) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const resolvers: ResolverMeta[] = Reflect.getMetadata(RESOLVER_META_KEY, target.constructor) || []
    resolvers.push({ path, target, method: propertyKey })
    Reflect.defineMetadata(RESOLVER_META_KEY, resolvers, target.constructor);
    Handler(GQLEvent, ...predicates)(target, propertyKey, descriptor)
  }
}
