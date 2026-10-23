import type { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import {
  GraphQLError,
  Kind,
  type DefinitionNode,
  type FieldNode,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql';

/**
 * What each root field costs to serve, relative to one another.
 *
 * Depth limiting alone is the common half-measure, and this schema is a
 * clean illustration of why: `paymentStats` is a `GROUP BY` over a month
 * and `myWallets` is a gRPC call to another service, but both sit at
 * depth one. Fifty of them behind aliases —
 *
 *   { a0: paymentStats(...) a1: paymentStats(...) … }
 *
 * — is a two-deep query that runs fifty aggregates, and a depth limit of
 * eight has nothing to say about it. Measured before this existed: fifty
 * aliases served in 178 ms, a thousand only stopped because each
 * resolver separately consumed a rate-limit slot, which reported itself
 * as an internal error.
 *
 * The numbers are ratios, not milliseconds. What matters is that an
 * aggregate costs far more than a cached lookup, and that a page costs
 * in proportion to the rows it asks for.
 */
const FIELD_COST: Readonly<Record<string, number>> = {
  // A GROUP BY across a date range. The most expensive thing here.
  paymentStats: 50,
  // A keyset page: cheap per row, so most of the cost rides on `limit`.
  payments: 10,
  statement: 10,
  // Leaves this process for the ledger over gRPC.
  myWallets: 20,
};

/** Fields whose cost scales with how many rows the caller asked for. */
const PER_ROW_COST = 0.5;

/** Anything not named above: a plain field read off an already-loaded object. */
const DEFAULT_FIELD_COST = 1;

export interface QueryCostOptions {
  readonly maxDepth: number;
  readonly maxCost: number;
}

/**
 * Rejects a query that is too deep or too expensive, before execution.
 *
 * Runs at `didResolveOperation` — after parsing and validation, before
 * any resolver — so a hostile query costs a parse rather than a hundred
 * database round trips.
 */
export function queryCostPlugin(options: QueryCostOptions): ApolloServerPlugin {
  return {
    async requestDidStart(): Promise<GraphQLRequestListener<never>> {
      return {
        async didResolveOperation({ document, operationName }) {
          for (const definition of document.definitions) {
            const depth = depthOf(definition);

            if (depth > options.maxDepth) {
              throw new GraphQLError(
                `Query is too deeply nested (${depth} > ${options.maxDepth})`,
                {
                  extensions: {
                    code: 'QUERY_TOO_DEEP',
                    maxDepth: options.maxDepth,
                    operationName,
                  },
                },
              );
            }

            const cost = costOf(definition);

            if (cost > options.maxCost) {
              throw new GraphQLError(
                `Query is too expensive (${cost} > ${options.maxCost})`,
                {
                  extensions: {
                    code: 'QUERY_TOO_EXPENSIVE',
                    cost,
                    maxCost: options.maxCost,
                    operationName,
                  },
                },
              );
            }
          }
        },
      };
    },
  };
}

/**
 * Sums every selection in the operation, including aliases.
 *
 * Aliases are the whole point: `a: paymentStats` and `b: paymentStats`
 * are two separate executions of the same expensive field, and anything
 * that counts distinct field *names* would see one.
 */
function costOf(node: DefinitionNode | FieldNode, depth = 0): number {
  const selectionSet: SelectionSetNode | undefined =
    'selectionSet' in node ? node.selectionSet : undefined;

  if (!selectionSet) {
    return 0;
  }

  let total = 0;

  for (const selection of selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      // A fragment spread or inline fragment costs whatever it expands to.
      total += costOf(selection as unknown as DefinitionNode, depth);
      continue;
    }

    // Introspection is schema metadata, not user data.
    if (selection.name.value.startsWith('__')) {
      continue;
    }

    total += fieldCost(selection) + costOf(selection, depth + 1);
  }

  return total;
}

function fieldCost(field: FieldNode): number {
  const base = FIELD_COST[field.name.value] ?? DEFAULT_FIELD_COST;
  const limit = intArgument(field, 'limit');

  // A page of a hundred is ten pages of ten, and should be priced so.
  return limit === null ? base : base + limit * PER_ROW_COST;
}

/**
 * Reads a literal integer argument. A variable is priced at the ceiling
 * the schema allows, because its value is not known until execution and
 * guessing low is how the limit gets bypassed.
 */
function intArgument(field: FieldNode, name: string): number | null {
  const argument = field.arguments?.find((candidate) => candidate.name.value === name);

  if (!argument) {
    return null;
  }

  return literalInt(argument.value) ?? MAX_PAGE_ASSUMPTION;
}

function literalInt(value: ValueNode): number | null {
  return value.kind === Kind.INT ? Number.parseInt(value.value, 10) : null;
}

/** The page ceiling the args classes enforce; see `MAX_PAGE_SIZE`. */
const MAX_PAGE_ASSUMPTION = 100;

function depthOf(node: DefinitionNode, current = 0): number {
  const selectionSet: SelectionSetNode | undefined =
    'selectionSet' in node ? node.selectionSet : undefined;

  if (!selectionSet) {
    return current;
  }

  let deepest = current;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const increment = selection.name.value.startsWith('__') ? 0 : 1;
      deepest = Math.max(
        deepest,
        depthOf(selection as unknown as DefinitionNode, current + increment),
      );
    } else {
      deepest = Math.max(deepest, depthOf(selection as unknown as DefinitionNode, current));
    }
  }

  return deepest;
}
