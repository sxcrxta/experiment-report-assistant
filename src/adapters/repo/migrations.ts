/**
 * SQLite 마이그레이션 실행기.
 *
 * IMPLEMENTATION_PLAN.md 0단계: "SQLite 스키마 마이그레이션 골격".
 * 도메인 테이블은 2단계부터 새 마이그레이션 파일로 추가한다. 기존 파일은 고치지 않는다.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** better-sqlite3 의 Database 가 구조적으로 만족하는 최소 인터페이스. */
export interface MigrationStatement {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

export interface MigrationDb {
  exec(sql: string): unknown
  prepare(sql: string): MigrationStatement
}

export interface Migration {
  version: number
  name: string
  sql: string
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/

const CREATE_HISTORY = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`

/** 마이그레이션 디렉터리에서 NNNN_name.sql 파일을 읽어 버전 순으로 돌려준다. */
export function loadMigrations(dir: string): Migration[] {
  const migrations: Migration[] = []

  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.sql')) continue
    const match = FILENAME.exec(entry)
    if (match === null) {
      throw new Error(
        `마이그레이션 파일 이름이 규칙에 맞지 않습니다: ${entry} (예: 0001_baseline.sql)`,
      )
    }
    migrations.push({
      version: Number(match[1]),
      name: match[2] as string,
      sql: readFileSync(join(dir, entry), 'utf8'),
    })
  }

  return sortAndValidate(migrations)
}

export function sortAndValidate(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  const seen = new Set<number>()
  for (const migration of sorted) {
    if (seen.has(migration.version)) {
      throw new Error(`마이그레이션 버전이 중복됩니다: ${migration.version}`)
    }
    seen.add(migration.version)
  }
  return sorted
}

/**
 * 아직 적용되지 않은 마이그레이션만 순서대로 적용한다.
 * 각 마이그레이션은 하나의 트랜잭션이며, 실패하면 그 마이그레이션은 통째로 되돌아간다.
 *
 * **이미 적용된 번호를 다른 이름으로 다시 쓰면 멈춘다.** 실행기는 번호만 보고 건너뛰므로,
 * 번호를 재사용하면 새 마이그레이션이 조용히 적용되지 않고 표가 없는 채로 앱이 돈다.
 * 2026-09-18 에 실제로 겪은 일이다 (10 번을 `document_pdf` 로 썼다가 지우고 `document_summary`
 * 로 다시 썼더니 보고서 목록을 읽지 못했다). 조용히 지나가느니 분명하게 실패하는 편이 낫다.
 *
 * @returns 이번에 적용한 버전 목록
 */
export function runMigrations(
  db: MigrationDb,
  migrations: readonly Migration[],
  now: () => string = () => new Date().toISOString(),
): number[] {
  db.exec(CREATE_HISTORY)

  const appliedRows = db.prepare('SELECT version, name FROM schema_migrations').all() as {
    version: number
    name: string
  }[]
  const appliedNames = new Map(appliedRows.map((row) => [row.version, row.name]))
  const applied = new Set(appliedNames.keys())

  const sorted = sortAndValidate(migrations)
  for (const migration of sorted) {
    const before = appliedNames.get(migration.version)
    if (before !== undefined && before !== migration.name) {
      throw new Error(
        `마이그레이션 ${String(migration.version).padStart(4, '0')} 번은 이미 '${before}' 로 적용되었습니다. `
        + `'${migration.name}' 에 새 번호를 주세요 (번호는 다시 쓰지 않습니다).`,
      )
    }
  }

  const pending = sorted.filter((m) => !applied.has(m.version))
  const done: number[] = []

  for (const migration of pending) {
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        now(),
      )
      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      throw new Error(
        `마이그레이션 ${String(migration.version).padStart(4, '0')}_${migration.name} 적용에 실패했습니다`,
        { cause },
      )
    }
    done.push(migration.version)
  }

  return done
}
