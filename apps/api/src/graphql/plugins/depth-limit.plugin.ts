import type { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import { GraphQLError, Kind, type DefinitionNode, type SelectionSetNode } from 'graphql';

/**
 * Query depth limiter.
 *
 * GraphQL lets a client write `payments { merchant { payments { merchant …` and
 * walk a cycle until the server runs out of memory. Depth limiting is the
 * cheapest effective defence; a full cost-analysis plugin is the next step
 * once field costs differ meaningfully.
 *
 * Runs at `didResolveOperation`, i.e. after parsing and validation but
 * before execution, so a hostile query is rejected before it touches the
 * database.
 */
export function depthLimitPlugin(maxDepth: number): ApolloServerPlugin {
  return {
    async requestDidStart(): Promise<GraphQLRequestListener<never>> {
      return {
        async didResolveOperation({ document, operationName }) {
          for (const definition of document.definitions) {
            const depth = depthOf(definition);

            if (depth > maxDepth) {
              throw new GraphQLError(
                `Query is too deeply nested (${depth} > ${maxDepth})`,
                { extensions: { code: 'QUERY_TOO_DEEP', maxDepth, operationName } },
              );
            }
          }
        },
      };
    },
  };
}

function depthOf(node: DefinitionNode, current = 0): number {
  const selectionSet: SelectionSetNode | undefined =
    'selectionSet' in node ? node.selectionSet : undefined;

  if (!selectionSet) {
    return current;
  }

  let deepest = current;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      // Introspection fields are not user data and do not count.
      const increment = selection.name.value.startsWith('__') ? 0 : 1;
      deepest = Math.max(deepest, depthOf(selection as unknown as DefinitionNode, current + increment));
    } else {
      deepest = Math.max(deepest, depthOf(selection as unknown as DefinitionNode, current));
    }
  }

  return deepest;
}
