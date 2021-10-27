
import 'reflect-metadata'
import fs from 'fs/promises'
import glob from 'glob'
import * as _ from 'lodash'
import { Application } from 'express'
import { GraphQLSchemaModule } from 'apollo-graphql'
import { gql as GQL, ApolloServer, ApolloServerExpressConfig, } from 'apollo-server-express'
import { GraphQLResolveInfo, GraphQLAbstractType } from 'graphql'


import {
  Container, service, REGISTER_AS_META_KEY,
  DispatchEvent, DispatchEventHof, DispatchPredicate, Handler, HandlerDeclaration, Metadata, HandlerRegistry
} from "@dits/dits/lib/di/di"
import { buildSubgraphSchema } from '@apollo/federation'
import { ApolloServerPluginInlineTraceDisabled } from 'apollo-server-core'

let reqIdx = 1
export async function createServer(app: Application, container: Container, config?: ApolloServerExpressConfig) {
  const registry: HandlerRegistry | undefined = container.get(HandlerRegistry)
  if (!registry) {
    throw new Error('Could not initialize press: no zone handler registry found; are you sure you are running inside `initApp` handler?')
  }

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

  // set the path on resolvers 
  const resolvers: any = {}
  registry.getDeclarations(GQLEvent).forEach(hr => {
    const { path } = hr.metadata[RESOLVER_META_KEY] as { path: string }
    if (!path) {
      console.warn('Bad HandlerDeclaration: ', hr)
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

  // console.log('server', server)


  await server.start()

  server.applyMiddleware({ app, })
}



export const GQL_KEY = Symbol('dits:apollo')
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
      const container = new Container(service.container!)
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
        console.warn('failed to do the zone thing', err)
        throw err
      }
    }
    return resolver
  }


export const RESOLVER_META_KEY = Symbol("resolver");
export function Resolver(path: string, ...predicates: DispatchPredicate<GQLEvent<unknown, unknown, any>>[]) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    Metadata.defineMetadata(REGISTER_AS_META_KEY, GQLEvent, target, propertyKey)
    Metadata(RESOLVER_META_KEY, { path })(target, propertyKey)
    Handler(...predicates)(target, propertyKey, descriptor)
  }
}
