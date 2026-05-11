/**
 * Apollo Server v4-compatible plugin. Bridges autograph's per-request lifecycle to the GQL
 * response boundary: at `willSendResponse` it tells the request's resolver to drain its
 * postResponse queue. The drain itself is fire-and-forget, so installing this plugin does not
 * delay the response.
 *
 * Usage:
 *   const { apolloPlugin } = require('@coderich/autograph');
 *   new ApolloServer({ schema, plugins: [apolloPlugin()] });
 *
 * `namespace` matches the autograph schema's namespace (defaults to 'autograph'). The plugin
 * looks up `context[namespace].resolver` to find the request's resolver.
 */
module.exports = (namespace = 'autograph') => ({
  async requestDidStart() {
    return {
      async willSendResponse(requestContext) {
        const resolver = requestContext?.contextValue?.[namespace]?.resolver;
        if (resolver && typeof resolver.firePostResponseEvents === 'function') {
          resolver.firePostResponseEvents();
        }
      },
    };
  },
});
