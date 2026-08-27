import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { z } from 'zod'

import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

type BoundStatement = D1PreparedStatement & { __run: () => Promise<D1Result> }

type SqlInput = null | number | bigint | string

const SqlInputSchema = z.union([
  z.null(), z.number(), z.bigint(), z.string(), z.boolean().transform(Number),
])

function sqlInputs(values: readonly unknown[]): SqlInput[] {
  return z.array(SqlInputSchema).parse(values)
}

function prepared(statement: StatementSync, onExecute: () => void, values: unknown[] = []): BoundStatement {
  const inputs = sqlInputs(values)
  const run = async () => {
    onExecute()
    const result = statement.run(...inputs)
    return d1Result([], Number(result.changes))
  }
  return {
    ...unsupportedStatement(),
    __run: run,
    all: async <T>() => {
      onExecute()
      // SAFETY: this test adapter mirrors D1: each caller owns the row type supplied to `all<T>()`.
      return d1Result(statement.all(...inputs) as T[])
    },
    bind: (...nextValues: unknown[]) => prepared(statement, onExecute, nextValues),
    first: async <T>(column?: string) => {
      onExecute()
      const row = statement.get(...inputs)
      if (!row) return null
      // SAFETY: this test adapter mirrors D1: each caller owns the selected `first<T>()` contract.
      return (column ? row[column] : row) as T
    },
    run,
  }
}

export function sqliteD1(sql: readonly string[]) {
  const sqlite = new DatabaseSync(':memory:')
  let executedQueries = 0
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const migration of sql) sqlite.exec(migration)
  const database: D1Database = {
    ...unsupportedDatabase(),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const results: D1Result<T>[] = []
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        for (const candidate of statements) {
          // SAFETY: this database produces every statement through `prepared`, which attaches `__run`.
          const statement = candidate as BoundStatement
          // SAFETY: `__run` has the same result envelope as D1; batch callers own their generic row type.
          results.push(await statement.__run() as D1Result<T>)
        }
        sqlite.exec('COMMIT')
      } catch (cause) {
        sqlite.exec('ROLLBACK')
        throw cause
      }
      return results
    },
    prepare: (query) => prepared(sqlite.prepare(query), () => { executedQueries++ }),
  }
  return { close: () => sqlite.close(), database, queryCount: () => executedQueries, sqlite }
}
