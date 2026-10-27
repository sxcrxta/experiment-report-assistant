import { join } from 'node:path'

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { loadMigrations, runMigrations, sortAndValidate } from '../src/adapters/repo/migrations.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')

describe('마이그레이션 파일', () => {
  it('디렉터리에서 버전 순으로 읽는다', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR)
    expect(migrations.length).toBeGreaterThan(0)
    expect(migrations[0]).toMatchObject({ version: 1, name: 'baseline' })
    const versions = migrations.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
  })

  it('버전이 중복되면 거부한다', () => {
    expect(() =>
      sortAndValidate([
        { version: 1, name: 'a', sql: '' },
        { version: 1, name: 'b', sql: '' },
      ]),
    ).toThrow('중복')
  })
})

describe('마이그레이션 실행', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('6단계 DB의 검토·피드백을 보존하며 0회 호출과 전송 기록을 지원한다', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR)
    runMigrations(db, migrations.filter((migration) => migration.version <= 6))
    db.pragma('foreign_keys = ON')
    db.exec(`
      INSERT INTO document (id,path,display_name,created_at) VALUES ('d','/tmp/d.hwpx','d','now');
      INSERT INTO document_version VALUES ('v','d',1,'now','/tmp/d.hwpx',1,'hash',1);
      INSERT INTO rubric_version VALUES ('r','d',1,'hash','now');
      INSERT INTO review_request (id,document_id,version_id,rubric_version,scope,stage,perspectives,
        target_paragraph_ids,context_paragraph_ids,model_id,prompt_version,requested_at,completed_at,
        attempts,status,summary) VALUES ('req','d','v','r','paragraph','question','["logic"]',
        '["p"]','[]','model','prompt','now','now',2,'succeeded','과거 검토');
      INSERT INTO feedback_item (id,request_id,position,paragraph_uuid,perspective,stage,severity,body,
        rationale,applied_rubric_item_ids) VALUES ('item','req',0,'p','logic','question',3,'피드백','근거','[]');
    `)
    runMigrations(db, migrations)
    expect(db.prepare('SELECT attempts, sent_target_paragraph_ids FROM review_request').get())
      .toEqual({ attempts: 2, sent_target_paragraph_ids: null })
    expect(db.prepare('SELECT body FROM feedback_item').get()).toEqual({ body: '피드백' })
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(() => db.prepare('UPDATE review_request SET attempts = 0').run()).not.toThrow()
    expect(() => db.prepare('UPDATE review_request SET attempts = -1').run()).toThrow()
    expect(runMigrations(db, migrations)).toEqual([])
    db.close()
  })

  it('7단계까지 쓰던 DB 에 8·9단계 표를 더해도 기존 기록이 남는다', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR)
    runMigrations(db, migrations.filter((migration) => migration.version <= 7))
    db.exec(`
      INSERT INTO document (id,path,display_name,created_at) VALUES ('d','/tmp/d.hwpx','d','now');
      INSERT INTO document_version VALUES ('v','d',1,'now','/tmp/d.hwpx',1,'hash',1);
    `)
    const before = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n

    runMigrations(db, migrations)

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'user_reaction', 'self_assessment', 'personal_guideline', 'observation_annotation', 'growth_summary',
      // 0009: 심층 검토를 붙이며 더한 앱 설정 표 ([Q-30])
      'app_settings',
      // 0011: 보고서 목록에 보여 줄 한 문단 요약 ([Q-36]). 10 번은 쓰고 버린 번호다
      'document_summary',
      // 0012: 평가 지침 모음 ([Q-40])
      'rubric_template', 'rubric_template_item', 'document_rubric_link',
      // 0013: 보고서 목차 ([Q-47])
      'document_outline',
      // 0014: 문서 종류와 제출 점검 결과 ([Q-48])
      'document_profile', 'document_check',
    ]))
    expect(tables).toHaveLength(before + 13)
    // 뒤 단계의 마이그레이션은 기존 문서·버전 기록을 건드리지 않는다.
    expect(db.prepare('SELECT id FROM document').all()).toEqual([{ id: 'd' }])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('실제 마이그레이션을 적용하고 기록을 남긴다', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR)
    const applied = runMigrations(db, migrations)

    expect(applied).toEqual(migrations.map((m) => m.version))

    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
    expect(rows).toEqual(migrations.map((m) => ({ version: m.version, name: m.name })))

    // 기준선이 만든 테이블이 실제로 존재한다.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_meta'").get()).toBeTruthy()
  })

  it('두 번 실행해도 같은 결과다 (멱등)', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR)
    runMigrations(db, migrations)
    expect(runMigrations(db, migrations)).toEqual([])
  })

  it('실패한 마이그레이션은 통째로 되돌아간다', () => {
    const broken = [
      { version: 1, name: 'ok', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' },
      { version: 2, name: 'broken', sql: 'CREATE TABLE b (id INTEGER); NOT SQL AT ALL;' },
    ]

    expect(() => runMigrations(db, broken)).toThrow('0002_broken')

    // 1번은 남고, 2번이 만들려던 테이블은 남지 않는다.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeUndefined()
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }])
  })
})

/**
 * 2026-09-18 에 실제로 겪은 사고를 고정한다.
 *
 * 10 번을 `document_pdf` 로 만들어 한 번 적용한 뒤 그 파일을 지우고, 같은 10 번을
 * `document_summary` 로 다시 썼다. 실행기는 번호만 보고 "이미 적용됨" 으로 건너뛰었고,
 * 표가 없는 채로 앱이 돌아 보고서 목록을 읽지 못했다.
 */
describe('번호를 다시 쓰면 조용히 건너뛰지 않는다', () => {
  it('이미 적용된 번호를 다른 이름으로 다시 쓰면 분명하게 실패한다', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db, [{ version: 1, name: 'document_pdf', sql: 'CREATE TABLE a (x TEXT);' }])
      expect(() => runMigrations(db, [
        { version: 1, name: 'document_summary', sql: 'CREATE TABLE b (x TEXT);' },
      ])).toThrow(/이미 'document_pdf' 로 적용/)
      // 멈췄으니 새 표가 반쯤 생기지도 않는다.
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='b'").all()).toEqual([])
    } finally { db.close() }
  })

  it('같은 번호·같은 이름을 다시 돌리는 것은 그대로 건너뛴다 (멱등)', () => {
    const db = new Database(':memory:')
    try {
      const migrations = [{ version: 1, name: 'documents', sql: 'CREATE TABLE a (x TEXT);' }]
      expect(runMigrations(db, migrations)).toEqual([1])
      expect(runMigrations(db, migrations)).toEqual([])
    } finally { db.close() }
  })

  it('번호가 비어 있어도 뒤 마이그레이션은 적용된다 (10 번을 버렸다)', () => {
    const db = new Database(':memory:')
    try {
      expect(runMigrations(db, [
        { version: 9, name: 'app_settings', sql: 'CREATE TABLE a (x TEXT);' },
        { version: 11, name: 'document_summary', sql: 'CREATE TABLE b (x TEXT);' },
      ])).toEqual([9, 11])
    } finally { db.close() }
  })
})
