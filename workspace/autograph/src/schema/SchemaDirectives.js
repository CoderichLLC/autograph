const { parse } = require('graphql');
const Pipeline = require('../data/Pipeline');

module.exports = function createFrameworkTypeDefs(directives) {
  const { model, field, link, index, transaction } = directives;

  return parse(`
    scalar AutoGraphMixed
    scalar AutoGraphDriver # DELETE WHEN MIGRATED

    enum AutoGraphIndexEnum { unique }
    enum AutoGraphAuthzEnum { private protected public } # DELETE WHEN MIGRATED
    enum AutoGraphOnDeleteEnum { cascade nullify restrict }
    enum AutoGraphPipelineEnum { ${Object.keys(Pipeline).filter(k => !k.startsWith('$')).join(' ')} }

    directive @${model}(
      id: String # Specify the generator strategy (default: "default")
      pk: String # Specify the PK field (default "id")
      key: String # Specify db table/collection name
      crud: AutoGraphMixed # CRUD API
      scope: AutoGraphMixed #
      meta: AutoGraphMixed # Custom input "meta" field for mutations
      source: AutoGraphMixed # Data source (default: "default")
      decorate: AutoGraphMixed # Decorator (default: "default")
      embed: Boolean # Mark this an embedded model (default false)
      persist: Boolean # Persist this model (default true)
      typeField: String # (interface) field holding the concrete-type discriminator value (default "type")
      typeValue: AutoGraphMixed # (implementer) discriminator value that maps to this concrete type (default: the type name)
      oneOf: Boolean # (interface) generate a @oneOf polymorphic input instead of a fat union input

      authz: AutoGraphAuthzEnum # Access level used for authorization (default: private)
      namespace: String # Logical grouping of models that can be globbed (useful for authz)
    ) on OBJECT | INTERFACE

    directive @${field}(
      id: String # Specify the generator strategy (default: "default")
      fk: String # Specify the FK field (default model.pk)
      key: String # Specify db key
      persist: Boolean # Persist this field (default true)
      connection: Boolean # Treat this field as a connection type (default false - rolling this out slowly)
      default: AutoGraphMixed # Define a default value
      crud: AutoGraphMixed # CRUD API
      onDelete: AutoGraphOnDeleteEnum # onDelete behavior

      # Pipeline Structure
      normalize: [AutoGraphPipelineEnum!]
      instruct: [AutoGraphPipelineEnum!]
      construct: [AutoGraphPipelineEnum!]
      restruct: [AutoGraphPipelineEnum!]
      serialize: [AutoGraphPipelineEnum!]
      deserialize: [AutoGraphPipelineEnum!]
      validate: [AutoGraphPipelineEnum!]

    ) on FIELD_DEFINITION | INPUT_FIELD_DEFINITION | SCALAR

    directive @${link}(
      to: AutoGraphMixed  # The MODEL to link to (default's to modelRef)
      by: AutoGraphMixed! # The FIELD to match yourself by
      use: AutoGraphMixed # The VALUE to use (default's to @link'd value); useful for many-to-many relationships
    ) on FIELD_DEFINITION

    directive @${index}(
      name: String
      on: [AutoGraphMixed!]!
      type: AutoGraphIndexEnum!
    ) repeatable on OBJECT

    # Executable (request-document) directive — the caller's opt-in to operation-scope
    # transactions: \`mutation @${transaction} { a, b, c }\` makes the operation's root mutation
    # fields one all-or-nothing unit of work (see OperationScope.js). Declared here so document
    # validation accepts it; without it on the operation, spec-standard partial-success
    # semantics apply.
    directive @${transaction} on MUTATION
  `);
};
