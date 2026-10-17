import { DefaultNamingStrategy, type NamingStrategyInterface, Table, View } from 'typeorm';

/**
 * snake_case naming strategy.
 *
 * TypeORM's default strategy keeps the property name as the column name, so
 * `aggregateType` becomes a column literally called `"aggregateType"` —
 * while hand-written migrations (and every other tool that touches the
 * database) use `aggregate_type`. The two agree only as long as every single
 * `@Column` carries an explicit `name:`, and the day somebody forgets, the
 * failure is a runtime `column does not exist` on a code path that may only
 * run in production.
 *
 * Making the convention mechanical removes that whole class of bug. Explicit
 * `name:` options still win where a column needs a name the convention would
 * not produce.
 */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  override tableName(targetName: string, userSpecifiedName: string | undefined): string {
    return userSpecifiedName ?? snake(targetName);
  }

  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    const prefix = embeddedPrefixes.length > 0 ? `${snake(embeddedPrefixes.join('_'))}_` : '';
    return prefix + (customName ?? snake(propertyName));
  }

  override relationName(propertyName: string): string {
    return snake(propertyName);
  }

  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return snake(`${relationName}_${referencedColumnName}`);
  }

  override joinTableName(
    firstTableName: string,
    secondTableName: string,
    firstPropertyName: string,
  ): string {
    return snake(`${firstTableName}_${firstPropertyName.replace(/\./gi, '_')}_${secondTableName}`);
  }

  override joinTableColumnName(
    tableName: string,
    propertyName: string,
    columnName?: string,
  ): string {
    return snake(`${tableName}_${columnName ?? propertyName}`);
  }

  classTableInheritanceParentColumnName(
    parentTableName: unknown,
    parentTableIdPropertyName: unknown,
  ): string {
    return snake(`${parentTableName as string}_${parentTableIdPropertyName as string}`);
  }

  eagerJoinRelationAlias(alias: string, propertyPath: string): string {
    return `${alias}__${propertyPath.replace('.', '_')}`;
  }

  /** Deterministic constraint names, so a migration diff stays readable. */
  override primaryKeyName(tableOrName: Table | string, columnNames: string[]): string {
    return `pk_${nameOf(tableOrName)}_${columnNames.join('_')}`;
  }

  override foreignKeyName(tableOrName: Table | string, columnNames: string[]): string {
    return `fk_${nameOf(tableOrName)}_${columnNames.join('_')}`;
  }

  override indexName(tableOrName: Table | View | string, columnNames: string[]): string {
    return `ix_${nameOf(tableOrName)}_${columnNames.join('_')}`;
  }
}

function nameOf(tableOrName: Table | View | string | undefined): string {
  if (!tableOrName) {
    return 'unknown';
  }
  const raw = typeof tableOrName === 'string' ? tableOrName : tableOrName.name;
  return raw.split('.').pop() ?? raw;
}

function snake(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1_$2')
    .replace(/\s+/g, '_')
    .toLowerCase();
}
