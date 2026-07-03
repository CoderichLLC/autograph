# CHANGELOG

## v0.15.x (BREAKING)
  - PageInfo and cursor no longer required schema (only defined when cursorPaginating...)
  - Revamped Pipeline { schema, context, resolver, query, model, field, value, path, startValue }
    - Pipeline "toId" is completely removed (use custom "toObjectId" Pipeline etc)
    - Removed Pipelines [transform, destruct]
      - transform -> normalize
  - Revamped Emitter { schema, context, resolver, query }
    - query IS the single source of truth
    - "Basic" functions are hoisted to the top for execution; RETURNING a value will bypass thunk()
    - "Next" functions are run next, next() must ALWAYS be called; passing a value to next() will bypass thunk()
    - Event shape refactored:
      - event.query.input  (replaces event.merged and old event.input)
      - event.query.result (replaces event.result shortcut)
  - Emitter.on('setup') is passed the "parsedSchema" object
  - No more gqlScope, dalScope, fieldScope (use crud + scope)
  - resolver.resolve() now takes 1 argument (info) and requires you to use .args() etc if need be
  - $magic methods now have signature doc.$.<method> and are more powerful and chainable
  - Resolver now sets itself at context.autograph (configurable)
  - createNamedQuery is replaced by Resolver.$loader
    - cb function now has signature (args, context)
    - cache is on by default and persists indefinitely (must be managed)
  - MongoClient now seperate NPM module @coderich/autograph-mongodb

## v0.11.x
- Node 18.12.1
- Engine >=16.20.0
- Updated deps for vulnerabilities

## v0.10.x
- Replaced ResultSet -> POJOs
  - Removed all $field methods (auto populated)
  - Removed .toObject()
  - $model $save remove $delete $lookup $cursor $pageInfo
- Removed embedded API completely
- Removed Directives
  - embedApi -> no replacement
  - enforce -> use pipeline methods
  - resolve -> use graphql resolvers
  - @value -> use @field.instruct directive
- Removed Model.tform() -> use Model.shapeObject(shape, data)
- Removed Transformer + Rule -> use Pipeline
  - Removed many pre-defined rules + transformers
  - Moved "validator" to dev dependency -> isEmail
- Added QueryBuilder.resolve() terminal command
- Exported SchemaDecorator -> Schema
- Removed embedded schema SystemEvents (internal emitter also removed)
- Removed spread of arguments in QueryBuilder terminal commands (must pass in array)
- Mutate "merged" instead of "input"
- Validate "payload"

## v0.9.x
- Subscriptions API
- postMutation no longer mutates "doc" and adds "result"
- Added onDelete defer option

## v0.8.x
- Engine 14+

## v0.7.x
- Complete overhaul of Query to Mongo Driver (pagination, sorting, counts, etc)
- Removed countModel Queries from the API (now available as `count` property on `Connetion` types)
- Dropped Neo4J (temporarily)

## v0.6.x
- Mongo driver no longer checks for `version` directive
- Models no longer share a Connection type; removing the need to use `... on Model` for GraphQL queries
- Added `@field(connection: Boolean)` parameter to specifically indicate fields that should return a Connection type
