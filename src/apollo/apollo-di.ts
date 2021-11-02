import 'reflect-metadata'
import fs from 'fs/promises'
import glob from 'glob'
import * as _ from 'lodash'
import { Application } from 'express'
import { GraphQLSchemaModule } from 'apollo-graphql'
import { gql as GQL, ApolloServer, ApolloServerExpressConfig, } from 'apollo-server-express'
import { GraphQLResolveInfo, GraphQLAbstractType } from 'graphql'

import {
  DispatchEvent, DispatchEventHof, DispatchPredicate, Handler, HandlerDeclaration, Metadata, HandlerRegistry
} from "@dits/dits"


import service from '@dits/dits'

import { buildSubgraphSchema } from '@apollo/federation'
import { ApolloServerPluginInlineTraceDisabled } from 'apollo-server-core'



const log = service.logger('dits_apollo')

export const GQL_KEY = Symbol.for('dits_apollo')
export class GQLEvent<A, P, CTX> extends DispatchEvent {

  constructor(
    public path: string,
    public args: A | undefined,
    public parent: P | undefined,
    public context: CTX,
    public info: GraphQLResolveInfo,
  ) {
    super(GQL_KEY)
  }
}


let reqIdx = 1
// export function createServer<HR>(app: Application, container: Container, registry: HandlerRegistry, config?: ApolloServerExpressConfig) {
export async function createServer<HR>(app: Application, registry: HandlerRegistry, config?: ApolloServerExpressConfig) {

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
    const { path } = hr.metadata[RESOLVER_META_KEY] as { path: string }
    if (!path) {
      log.warn('Bad HandlerDeclaration: ', hr)
      throw new Error('Could not determine correct metadata for Handler')
    }
    const existing = _.get(resolvers, path)
    if (existing) {
      throw new Error(`Resolver Path ${path} already defined with ${existing}; could not set ${hr.target} `)
    }
    _.set(resolvers, path, createHandlerResolver({ path }, hr))
  })



  const schemata: GraphQLSchemaModule = {
    typeDefs: GQL(typeDefs),
    resolvers
  }


  const schema = buildSubgraphSchema(schemata)
  const plugins = [
    ...(config?.plugins || []),
    ApolloServerPluginInlineTraceDisabled()
  ]
  const server: ApolloServer = new ApolloServer({
    debug: process.env.HX_GRAPHQL_DEBUG === 'true',
    // tracing: process.env.HX_GRAPHQL_TRACING === 'true',
    introspection: process.env.HX_GRAPHQL_INTROSPECTION_DISABLED === 'true' ? false : true,
    schema,
    ...config,
    plugins
  });

  // log.info('server', server)


  await server.start()

  server.applyMiddleware({ app })

}




export type ResolverPredicateSettings = {
  path: string
}

export const ResolverPredicate: DispatchEventHof<GQLEvent<unknown, unknown, any>> = (path: string) => {
  const pred = <A, P, CTX>(e: GQLEvent<A, P, CTX>, declaration: HandlerDeclaration<GQLEvent<A, P, CTX>>) => {
    return true
  }

  const settings: ResolverPredicateSettings = { path }
  Reflect.defineMetadata('gql_resolver', settings, pred)
  return pred
}




type HandlerResolver = <A, P, CTX, RT>({ path }: { path: string }, hd: HandlerDeclaration<GQLEvent<A, P, CTX>>) =>
  (parent: P,
    args: A | undefined,
    context: CTX,
    info: GraphQLResolveInfo,
    abstractType: GraphQLAbstractType,
  ) => Promise<RT>

const createHandlerResolver: HandlerResolver =
  ({ path }, hd) => {
    const resolver = async <A, P, CTX, RT>(parent: P, args: A | undefined, context: CTX, info: GraphQLResolveInfo, absType: GraphQLAbstractType) => {
      const e = new GQLEvent(path, args, parent, context, info)
      const container = service.Container()
      const principal = await service.context?.authenticate(e)
      const zone = service.zone!.fork({
        name: `gql-${reqIdx++}`,
        properties: {
          rootEvent: e,
          container,
          principal
        }
      })
      try {
        return await zone.run(async () => {
          const result = await hd.handler(e)
          return result
        }) as RT
      } catch (err) {
        log.warn('failed to do the zone thing', err)
        throw err
      }
    }
    return resolver
  }


export const RESOLVER_META_KEY = Symbol.for("dits_resolver");
export function Resolver(path: string, ...predicates: DispatchPredicate<GQLEvent<unknown, unknown, any>>[]) {
  // global.foobar1 = service
  // log.info('naw?', path)
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    service.onPreInitialization(async () => {
      // Metadata.defineMetadata(REGISTER_AS_META_KEY, GQLEvent, target, propertyKey)
      Metadata(RESOLVER_META_KEY, { path })(target, propertyKey)
      Handler(...predicates)(target, propertyKey, descriptor)
    })
  }
}
