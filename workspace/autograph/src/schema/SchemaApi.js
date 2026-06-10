/* eslint-disable indent */

const { fromGUID } = require('../service/AppService');

function getGQLType(field, suffix) {
  let { type } = field;
  const { isEmbedded, isRequired, isScalar, isEnum, isArray, isArrayRequired, isPrimaryKey, defaultValue } = field;
  const modelType = `${type}${suffix}`;
  if (suffix && !isScalar && !isEnum) type = isEmbedded ? modelType : 'ID';
  type = isArray ? `[${type}${isArrayRequired ? '!' : ''}]` : type;
  if (!suffix && isRequired) type += '!';
  if (suffix === 'InputCreate' && !isPrimaryKey && isRequired && defaultValue == null) type += '!';
  return type;
}

// AG12-compatible subscription field typing: FK references emit as `ID` (or `[ID]`) so the
// schema matches the raw FK-scalar values published in subscription events. AG15 should swap
// this to the full `getGQLType(field)` form and pair it with the (currently commented out)
// subscription payload field resolvers below — restoring full symmetry with query/mutation.
function getSubscriptionType(field) {
  if (field.isFKReference) return field.isArray ? '[ID]' : 'ID';
  return getGQLType(field);
}

function getConnectionArguments(model) {
  return `
    where: ${model}InputWhere
    sortBy: ${model}InputSort
    limit: Int
    skip: Int
    first: Int
    after: String
    last: Int
    before: String
  `;
}

function generateApi(schema) {
  // These models are for creating types
  const readModels = Object.values(schema.models).filter(model => [model.crud, model.scope].join()?.includes('r'));
  const createModels = Object.values(schema.models).filter(model => [model.crud, model.scope].join()?.includes('c'));
  const updateModels = Object.values(schema.models).filter(model => [model.crud, model.scope].join()?.includes('u'));

  // These are for defining schema queries/mutations
  const entityModels = Object.values(schema.models).filter(model => model.isEntity);
  const queryModels = entityModels.filter(model => model.crud?.includes('r'));
  const mutationModels = entityModels.filter(model => ['c', 'u', 'd'].some(el => model.crud?.includes(el)));
  const subscriptionModels = entityModels.filter(model => model.crud?.includes('s'));

  return {
    typeDefs: `
      scalar AutoGraphMixed
      scalar AutoGraphDateTime

      interface Node { id: ID! }

      enum SortOrderEnum { asc desc }
      enum SubscriptionCrudEnum { create update delete }
      enum SubscriptionWhenEnum { preEvent postEvent }

      type PageInfo {
        startCursor: String!
        endCursor: String!
        hasPreviousPage: Boolean!
        hasNextPage: Boolean!
      }

      ${entityModels.map(model => `
        extend type ${model} implements Node {
          id: ID!
        }
      `)}

      ${readModels.map((model) => {
        const fields = Object.values(model.fields).filter(field => field.crud?.includes('r'));

        // Note: connection fields (`@field(connection: true)`) are rewritten in place on the
        // user's existing type by Schema#rewriteConnections, called from .api() before this
        // generator runs — so we don't emit a competing `extend type X { ... }` here.
        return `
          input ${model}InputWhere {
            ${fields.map(field => `${field}: ${field.model ? `${field.model}InputWhere` : 'AutoGraphMixed'}`)}
          }
          input ${model}InputSort {
            ${fields.map(field => `${field}: ${field.model ? `${field.model}InputSort` : 'SortOrderEnum'}`)}
          }
          type ${model}Connection {
            count: Int!
            pageInfo: PageInfo
            edges: [${model}Edge]
          }
          type ${model}Edge {
            node: ${model}
            cursor: String
          }
        `;
      })}

      ${createModels.map((model) => {
        // Polymorphic interface input: @oneOf keyed by each implementer's typeValue -> its own input.
        if (model.oneOf) {
          return `
            input ${model}InputCreate @oneOf {
              ${Object.entries(model.typeMap).map(([key, typeName]) => `${key}: ${typeName}InputCreate`).join('\n')}
            }
          `;
        }

        const fields = Object.values(model.fields).filter(field => field.crud?.includes('c') && !field.isVirtual);

        return `
          input ${model}InputCreate {
            ${fields.map(field => `${field}: ${getGQLType(field, 'InputCreate')}`)}
          }
        `;
      })}

      ${updateModels.map((model) => {
        if (model.oneOf) {
          return `
            input ${model}InputUpdate @oneOf {
              ${Object.entries(model.typeMap).map(([key, typeName]) => `${key}: ${typeName}InputUpdate`).join('\n')}
            }
          `;
        }

        const fields = Object.values(model.fields).filter(field => field.crud?.includes('u') && !field.isVirtual);

        return `
          input ${model}InputUpdate {
            ${fields.map(field => `${field}: ${getGQLType(field, 'InputUpdate')}`)}
          }
        `;
      })}

      type Query {
        node(id: ID!): Node
        ${queryModels.map(model => `
          get${model}(id: ID!): ${model}
          find${model}(${getConnectionArguments(model)}): ${model}Connection!
        `)}
      }

      ${mutationModels.length ? `
        type Mutation {
          ${mutationModels.map((model) => {
            const api = [];
            const meta = model.meta ? `meta: ${model.meta}` : '';
            if (model.crud?.includes('c')) api.push(`create${model}(input: ${model}InputCreate! ${meta}): ${model}!`);
            if (model.crud?.includes('u')) api.push(`update${model}(id: ID! input: ${model}InputUpdate ${meta}): ${model}!`);
            if (model.crud?.includes('d')) api.push(`delete${model}(id: ID! ${meta}): ${model}!`);
            return api.join('\n');
          })}
        }
      ` : ''}

      ${subscriptionModels.length ? `
        type Subscription {
          ${subscriptionModels.map(model => `
            ${model}(
              on: [SubscriptionCrudEnum!]! = [create, update, delete]
              filter: ${model}SubscriptionInputFilter
            ): ${model}SubscriptionPayload!
          `)}
        }

        ${subscriptionModels.map((model) => {
          const fields = Object.values(model.fields).filter(field => field.crud?.includes('r'));

          return `
            input ${model}SubscriptionInputFilter {
              when: [SubscriptionWhenEnum!]! = [preEvent, postEvent]
              where: ${model}SubscriptionInputWhere! = {}
            }

            input ${model}SubscriptionInputWhere {
              ${fields.map(field => `${field}: ${field.model ? `${field.model}InputWhere` : 'AutoGraphMixed'}`)}
            }

            type ${model}SubscriptionPayload {
              event: ${model}SubscriptionPayloadEvent
              query: ${model}SubscriptionQuery
            }

            type ${model}SubscriptionPayloadEvent {
              crud: SubscriptionCrudEnum!
              data: ${model}SubscriptionPayloadEventData!
            }

            # AG15 target: emit full FK ref types here (Network!, [Network!]) for symmetry with
            # query/mutation. Requires the resolver block below to be enabled. For now we emit
            # ID / [ID] (matching AG12) to preserve subscription client compatibility.
            type ${model}SubscriptionPayloadEventData {
              ${fields.map(field => `${field}: ${getSubscriptionType(field)}`)}
            }

            interface ${model}SubscriptionQuery {
              ${fields.map(field => `${field}: ${getSubscriptionType(field)}`)}
            }

            type ${model}Create implements ${model}SubscriptionQuery {
              ${fields.map(field => `${field}: ${getSubscriptionType(field)}`)}
            }

            type ${model}Update implements ${model}SubscriptionQuery {
              ${fields.map(field => `${field}: ${getSubscriptionType(field)}`)}
            }
          `;
        })}
      ` : ''}
    `,
    resolvers: {
      Node: {
        __resolveType: (doc, args, context, info) => doc.__typename,
      },
      ...queryModels.reduce((prev, model) => {
        return Object.assign(prev, {
          [`${model}Connection`]: {
            count: ({ count }) => count(),
            edges: ({ edges }) => edges().then(rs => rs.map(node => ({ cursor: node.$cursor, node }))),
            pageInfo: ({ pageInfo }) => pageInfo().then(rs => rs?.$pageInfo),
          },
        });
      }, {}),
      Query: queryModels.reduce((prev, model) => {
        return Object.assign(prev, {
          [`get${model}`]: (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).one({ required: true }),
          [`find${model}`]: (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).resolve(info),
        });
      }, {
        node: (doc, args, context, info) => {
          const { id } = args;
          const [modelName] = fromGUID(id);
          const model = schema.models[modelName];
          return context[schema.namespace].resolver.match(model).id(id).info(info).one().then((result) => {
            if (result == null) return result;
            result.__typename = modelName;
            return result;
          });
        },
      }),
      ...(mutationModels.length ? {
        Mutation: mutationModels.reduce((prev, model) => {
          if (model.crud?.includes('c')) prev[`create${model}`] = (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).save(args.input);
          if (model.crud?.includes('u')) prev[`update${model}`] = (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).save(args.input);
          if (model.crud?.includes('d')) prev[`delete${model}`] = (doc, args, context, info) => context[schema.namespace].resolver.match(model).args(args).info(info).delete();
          return prev;
        }, {}),
      } : {}),
      ...readModels.reduce((prev, model) => {
        return Object.assign(prev, {
          // For interface models, `model.fields` includes implementer fields aggregated for
          // input/pipeline purposes — but those live on the concrete GraphQL types, not the interface
          // type. Scope interface field-resolvers to the interface's OWN fields; concrete types emit
          // the rest. (Without this, an entity-typed variant field e.g. `imageTile` would be emitted
          // as `Interface.imageTile` and makeExecutableSchema rejects it as not-in-schema.)
          [model]: Object.values(model.fields).filter(field => field.model?.isEntity && field.crud?.includes('r') && (!model.isInterface || model.ownFields?.has(field.name))).reduce((prev2, field) => {
            // Hot path: this resolver fires per FK/embedded entity field per doc. Inlining the
            // `doc.$.lookup(field)` chain avoids one Proxy allocation and one wasted QueryResolver
            // allocation (the proxy creates `match(model).id(doc.id)` but the lookup branch never
            // uses it). Field model + virtual/fk metadata are closed over at schema-build time.
            const { isVirtual, linkBy, linkField, fkField, model: fieldModel } = field;
            return Object.assign(prev2, {
              [field]: (doc, args, context, info) => {
                if (!doc.$) doc = context[schema.namespace].resolver.toResultSet(model, doc); // Ensure resultSet
                const where = isVirtual ? { [linkBy]: doc[linkField] } : { [fkField]: doc[field] };
                return context[schema.namespace].resolver.match(fieldModel).where(where).args(args).info(info).resolve(info);
              },
            });
            // Interface models also need a __resolveType so GraphQL can pick the concrete type for
            // interface-typed fields. The typeField (default "type") holds the value that
            // maps to a concrete type via typeMap. Seeded here (the last writer of resolvers[model])
            // so it merges with the field resolvers above instead of being clobbered by them.
          }, model.isInterface ? { __resolveType: doc => model.typeMap[doc[model.typeField]] } : {}),
        });
      }, {}),
      // AG15 — Subscription payload field resolvers (currently disabled).
      //
      // When enabled, this generates entity-field resolvers on the subscription payload types
      // (<Model>SubscriptionPayloadEventData / <Model>Create / <Model>Update) using the same
      // doc.$.lookup(field) pattern that powers the query/mutation path. With these resolvers
      // in place, the subscription SDL can emit full FK reference types (`network: Network!`)
      // instead of `ID`, restoring symmetry with query/mutation — subscribers can select
      // `event.data.network { id name }` and get resolved entities, lazily (DataLoader-batched).
      //
      // Re-enabling requires:
      //   1. Uncomment this block
      //   2. Swap `getSubscriptionType(field)` -> `getGQLType(field)` in the subscription SDL above
      //   3. Remove `getSubscriptionType` (it would become a one-line wrapper)
      //
      // Currently commented out because flipping the subscription SDL types is a breaking
      // change for existing clients who select FK fields scalar-style (`network` without
      // subfields). AG15 is the right place to ship the breakage with a migration note.
      //
      // ...subscriptionModels.reduce((prev, model) => {
      //   const fieldResolvers = Object.values(model.fields).filter(field => field.model?.isEntity && field.crud?.includes('r')).reduce((acc, field) => {
      //     return Object.assign(acc, {
      //       [field]: (doc, args, context, info) => {
      //         if (!doc.$) doc = context[schema.namespace].resolver.toResultSet(model, doc);
      //         return doc.$.lookup(field).args(args).info(info).resolve(info);
      //       },
      //     });
      //   }, {});
      //   return Object.assign(prev, {
      //     [`${model}SubscriptionPayloadEventData`]: fieldResolvers,
      //     [`${model}Create`]: fieldResolvers,
      //     [`${model}Update`]: fieldResolvers,
      //   });
      // }, {}),
    },
  };
}

module.exports = { generateApi, getConnectionArguments };
