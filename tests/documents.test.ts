/**
 * 문서 등록·저장 처리 유스케이스와 저장소 테스트.
 *
 * T-9  해시·Diff 경로에서 모델 어댑터가 호출되지 않는다 (이 경로에는 AI 가 없다)
 * T-13 원본 HWPX 의 바이트가 변하지 않는다
 * T-15 최초본·사용자 지정 체크포인트로 복구가 가능하다
 * T-16 경로를 잃으면 알리고, 재선택으로 같은 문서에 이어진다
 * T-22 문단 분할·병합 시 새 uuid 와 계보가 저장된다
 * T-31 전체 디스크 접근 권한을 요청하는 코드가 없다
 */
import { readFileSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCheckpointStore, sha256File } from '../src/adapters/checkpoint/index.js'
import { hwpxReader } from '../src/adapters/hwpx/index.js'
import { createDocumentRepository, type DocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { icloudPlaceholderName, type FileWatcher, type WatchEvent } from '../src/adapters/watcher/index.js'
import {
  createDocumentSession,
  type DocumentSession,
  type SessionEvent,
} from '../src/app/document-session.js'

import { makeHwpx, para } from './helpers/make-hwpx.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')

const cleanups: (() => void)[] = []

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function hwpx(texts: readonly string[]): Uint8Array {
  return makeHwpx({ sections: [texts.map((text) => para(text)).join('')] })
}

/** 저장 이벤트를 손으로 낼 수 있는 가짜 감시자. */
function fakeWatcher(): { watcher: FileWatcher; emit: (event: WatchEvent) => void; stopped: () => boolean } {
  let listener: ((event: WatchEvent) => void) | null = null
  let stopped = false
  return {
    watcher: {
      watch(_path, onEvent): Promise<() => void> {
        listener = onEvent
        return Promise.resolve(() => {
          stopped = true
        })
      },
    },
    emit: (event) => listener?.(event),
    stopped: () => stopped,
  }
}

interface Harness {
  db: Database.Database
  repo: DocumentRepository
  session: DocumentSession
  documentPath: string
  checkpointRoot: string
  write: (texts: readonly string[]) => void
}

let harness: Harness

function createHarness(initial: readonly string[]): Harness {
  const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })
  cleanups.push(() => db.close())

  const repo = createDocumentRepository(db)
  const documentDir = tempDir('docs-')
  const checkpointRoot = tempDir('checkpoints-')
  const documentPath = join(documentDir, '실험보고서.hwpx')
  writeFileSync(documentPath, hwpx(initial))

  let counter = 0
  const session = createDocumentSession({
    repo,
    reader: hwpxReader,
    watcher: fakeWatcher().watcher,
    checkpoints: createCheckpointStore(checkpointRoot),
    hashFile: sha256File,
    fileSize: (path) => statSync(path).size,
    now: () => new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    newId: () => `id-${(counter += 1)}`,
  })

  return {
    db,
    repo,
    session,
    documentPath,
    checkpointRoot,
    write: (texts) => writeFileSync(documentPath, hwpx(texts)),
  }
}

beforeEach(() => {
  harness = createHarness(['실험 목적', '실험 방법', '실험 결과'])
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function register(): { documentId: string } {
  const result = harness.session.registerDocument({ path: harness.documentPath, subject: '화학' })
  if (!result.ok) throw new Error(result.message)
  return { documentId: result.document.id }
}

describe('문서 등록', () => {
  it('손상된 최초 파일은 버전 없는 빈 문서 항목도 남기지 않는다', () => {
    writeFileSync(harness.documentPath, 'invalid zip')
    expect(harness.session.registerDocument({ path: harness.documentPath })).toMatchObject({ ok: false })
    expect(harness.repo.listDocuments()).toEqual([])
  })
  it('앱 밖에서 저장한 문서를 다시 선택하면 최신 내용이 새 버전으로 기록된다', () => {
    const { documentId } = register()
    harness.write(['다시 저장한 목적', '실험 방법', '실험 결과'])
    const result = harness.session.registerDocument({ path: harness.documentPath })
    expect(result.ok && result.version.ordinal).toBe(2)
    const latest = harness.repo.latestVersion(documentId)!
    expect(harness.repo.listParagraphs(latest.id)[0]?.paragraph.text).toBe('다시 저장한 목적')
    expect(harness.repo.listCheckpoints(documentId)).toHaveLength(1)
  })

  it('새 경로의 바뀐 내용을 재연결 즉시 읽고, 잘못된 재선택은 기존 경로를 보존한다', () => {
    const { documentId } = register()
    const moved = join(tempDir('reconnect-'), '새 보고서.hwpx')
    writeFileSync(moved, hwpx(['다른 위치에서 저장한 목적', '실험 방법', '실험 결과']))
    const connected = harness.session.reconnect(documentId, moved)
    expect(connected.ok && connected.version.ordinal).toBe(2)
    const bad = join(tempDir('invalid-'), '손상된 보고서.hwpx')
    writeFileSync(bad, 'invalid zip')
    expect(harness.session.reconnect(documentId, bad)).toMatchObject({ ok: false, reason: 'read-failed' })
    expect(harness.repo.getDocument(documentId)?.path).toBe(moved)
  })

  it('읽는 도중 파일이 다시 저장되면 서로 다른 문단과 해시를 버전으로 기록하지 않는다', () => {
    const { documentId } = register()
    const session = createDocumentSession({
      repo: harness.repo,
      reader: { read(path) {
        const parsed = hwpxReader.read(path)
        harness.write(['읽는 중 바뀐 내용', '실험 방법', '실험 결과'])
        return parsed
      } },
      watcher: fakeWatcher().watcher, checkpoints: createCheckpointStore(harness.checkpointRoot),
      hashFile: sha256File, fileSize: (path) => statSync(path).size,
      now: () => '2026-09-12', newId: () => 'race-id',
    })
    expect(session.handleSaved(documentId)).toMatchObject({ ok: false, reason: 'read-failed' })
    expect(harness.repo.listVersions(documentId)).toHaveLength(1)
  })
  it('최초본 버전과 체크포인트를 함께 만든다', () => {
    const before = readFileSync(harness.documentPath)

    const result = harness.session.registerDocument({
      path: harness.documentPath,
      subject: '화학',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.document.subject).toBe('화학')
    expect(result.version.ordinal).toBe(1)
    expect(result.version.paragraphCount).toBe(3)
    expect(result.checkpoint.kind).toBe('initial')

    // 체크포인트는 원본을 그대로 복사한 사본이다 (T-15).
    expect(readFileSync(result.checkpoint.filePath).equals(before)).toBe(true)
    // 원본은 바이트가 변하지 않는다 (T-13).
    expect(readFileSync(harness.documentPath).equals(before)).toBe(true)
  })

  it('최초본에는 비교할 이전 버전이 없어 변경 기록이 없다', () => {
    const { documentId } = register()
    const version = harness.repo.latestVersion(documentId)
    expect(version).not.toBeNull()
    expect(harness.repo.listDiffEntries(version?.id ?? '')).toEqual([])
  })

  it('같은 파일을 다시 고르면 새 문서를 만들지 않는다', () => {
    const first = register()
    const again = harness.session.registerDocument({ path: harness.documentPath })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.reused).toBe(true)
    expect(again.document.id).toBe(first.documentId)
    expect(harness.repo.listDocuments()).toHaveLength(1)
  })

  it('HWPX 가 아니면 등록하지 않고 안내한다', () => {
    const other = join(tempDir('other-'), '보고서.docx')
    writeFileSync(other, 'x')

    const result = harness.session.registerDocument({ path: other })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unsupported-format')
    expect(result.message).toContain('HWPX')
  })

  it('iCloud 에서 내려받지 않은 문서는 안내한다', () => {
    const dir = tempDir('icloud-')
    writeFileSync(join(dir, icloudPlaceholderName('보고서.hwpx')), 'placeholder')

    const result = harness.session.registerDocument({ path: join(dir, '보고서.hwpx') })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('icloud-not-downloaded')
    expect(result.message).toContain('iCloud')
  })

  it('HWPX 가 아닌 내용이면 읽기 실패로 알린다', () => {
    const path = join(tempDir('broken-'), '보고서.hwpx')
    writeFileSync(path, 'HWPX 가 아닙니다')

    const result = harness.session.registerDocument({ path })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('read-failed')
  })
})

describe('저장 처리', () => {
  it('바뀐 문단만 뽑아 새 버전으로 남긴다', () => {
    const { documentId } = register()
    harness.write(['실험 목적', '실험 방법을 자세히 적었다', '실험 결과'])

    const result = harness.session.handleSaved(documentId)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.alreadyKnown).toBe(false)
    expect(result.version.ordinal).toBe(2)
    expect(result.unchangedCount).toBe(2)
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]?.paragraph.text).toBe('실험 방법을 자세히 적었다')

    const entries = harness.repo.listDiffEntries(result.version.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.change).toBe('modified')
    expect(entries[0]?.paraIndex).toBe(1)
  })

  it('바뀌지 않은 문단은 uuid 를 유지한다', () => {
    const { documentId } = register()
    const firstVersion = harness.repo.latestVersion(documentId)
    const before = harness.repo.listPreviousParagraphs(firstVersion?.id ?? '')

    harness.write(['실험 목적', '실험 방법', '실험 결과와 고찰'])
    const result = harness.session.handleSaved(documentId)
    if (!result.ok) return

    const after = harness.repo.listPreviousParagraphs(result.version.id)
    expect(after[0]?.uuid).toBe(before[0]?.uuid)
    expect(after[1]?.uuid).toBe(before[1]?.uuid)
    expect(after[2]?.uuid).toBe(before[2]?.uuid) // 수정이라 uuid 는 이어진다
    expect(after[2]?.text).toBe('실험 결과와 고찰')
  })

  it('바이트가 그대로면 새 버전을 만들지 않는다', () => {
    const { documentId } = register()

    const result = harness.session.handleSaved(documentId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alreadyKnown).toBe(true)
    expect(result.changed).toEqual([])
    expect(harness.repo.listVersions(documentId)).toHaveLength(1)
  })

  it('문단이 나뉘면 계보를 저장한다 (T-22)', () => {
    harness = createHarness(['비커에 물을 넣었다. 그리고 소금을 넣었다.'])
    const { documentId } = register()
    const firstVersion = harness.repo.latestVersion(documentId)
    const parent = harness.repo.listPreviousParagraphs(firstVersion?.id ?? '')[0]?.uuid

    harness.write(['비커에 물을 넣었다.', '그리고 소금을 넣었다.'])
    const result = harness.session.handleSaved(documentId)
    if (!result.ok) return

    const lineage = harness.repo.listLineage(result.version.id)
    expect(lineage).toHaveLength(2)
    expect(lineage.every((row) => row.parentUuid === parent)).toBe(true)
    expect(lineage.every((row) => row.relation === 'split')).toBe(true)
    expect(lineage.map((row) => row.childUuid)).not.toContain(parent)

    expect(harness.repo.listDiffEntries(result.version.id).map((e) => e.change)).toEqual([
      'split',
      'split',
    ])
  })

  it('지워진 문단은 삭제로 남는다', () => {
    const { documentId } = register()
    harness.write(['실험 목적', '실험 결과'])

    const result = harness.session.handleSaved(documentId)
    if (!result.ok) return

    const entries = harness.repo.listDiffEntries(result.version.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.change).toBe('deleted')
    expect(entries[0]?.paraIndex).toBeNull()
    expect(result.removed[0]?.text).toBe('실험 방법')
  })

  it('경로를 잃으면 알리고 문서에 표시한다', () => {
    const { documentId } = register()
    rmSync(harness.documentPath)

    const result = harness.session.handleSaved(documentId)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('missing')
    expect(harness.repo.getDocument(documentId)?.pathLost).toBe(true)
  })
})

describe('감시 연결', () => {
  it('saved 이벤트를 받으면 버전을 남기고 알린다', async () => {
    const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })
    cleanups.push(() => db.close())
    const repo = createDocumentRepository(db)
    const fake = fakeWatcher()

    let counter = 0
    const session = createDocumentSession({
      repo,
      reader: hwpxReader,
      watcher: fake.watcher,
      checkpoints: createCheckpointStore(tempDir('cp-')),
      hashFile: sha256File,
      fileSize: (path) => statSync(path).size,
      now: () => new Date(1_700_000_000_000).toISOString(),
      newId: () => `id-${(counter += 1)}`,
    })

    const registered = session.registerDocument({ path: harness.documentPath })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return

    const events: SessionEvent[] = []
    await session.startWatching(registered.document.id, (event) => events.push(event))

    harness.write(['실험 목적', '실험 방법', '실험 결과와 고찰'])
    fake.emit({ kind: 'saved', path: harness.documentPath, byteSize: 0 })

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('saved')
    if (events[0]?.kind !== 'saved') return
    expect(events[0].changed).toHaveLength(1)

    fake.emit({
      kind: 'path-lost',
      path: harness.documentPath,
      reason: 'missing',
      message: '문서 경로를 찾을 수 없습니다.',
    })
    expect(events[1]?.kind).toBe('path-lost')
    expect(repo.getDocument(registered.document.id)?.pathLost).toBe(true)

    // 처리 도중 예외가 나도 조용히 사라지지 않고 실패로 알린다 (CLAUDE.md §7).
    db.close()
    fake.emit({ kind: 'saved', path: harness.documentPath, byteSize: 0 })
    expect(events[2]?.kind).toBe('failed')
  })
})

describe('재연결 (T-16)', () => {
  it('사용자가 다시 고른 경로로 같은 문서에 이어 붙인다', () => {
    const { documentId } = register()
    const moved = join(tempDir('moved-'), '실험보고서-최종.hwpx')
    renameSync(harness.documentPath, moved)

    expect(harness.session.handleSaved(documentId).ok).toBe(false)

    const result = harness.session.reconnect(documentId, moved)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.document.id).toBe(documentId)
    expect(result.document.pathLost).toBe(false)
    expect(result.document.path).toBe(moved)
    // 버전 기록이 그대로 이어진다.
    expect(harness.repo.listVersions(documentId)).toHaveLength(1)

    writeFileSync(moved, hwpx(['실험 목적', '실험 방법', '실험 결과와 고찰']))
    const saved = harness.session.handleSaved(documentId)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.version.ordinal).toBe(2)
    expect(saved.changed).toHaveLength(1)
  })

  it('다른 문서로 이미 등록된 파일에는 이어 붙이지 않는다', () => {
    const { documentId } = register()

    const otherPath = join(tempDir('other-'), '다른보고서.hwpx')
    writeFileSync(otherPath, hwpx(['다른 문서']))
    const other = harness.session.registerDocument({ path: otherPath })
    expect(other.ok).toBe(true)

    const result = harness.session.reconnect(documentId, otherPath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('already-linked')
  })
})

describe('체크포인트 (T-15)', () => {
  it('사용자가 지정한 시점을 따로 보관한다', () => {
    const { documentId } = register()
    harness.write(['실험 목적', '실험 방법', '고쳐 쓴 결과'])
    harness.session.handleSaved(documentId)

    const marked = harness.session.markCheckpoint(documentId, '제출 전')
    expect('ok' in marked).toBe(false)
    if ('ok' in marked) return

    expect(marked.kind).toBe('user')
    expect(marked.label).toBe('제출 전')
    expect(readFileSync(marked.filePath).equals(readFileSync(harness.documentPath))).toBe(true)
    expect(harness.repo.listCheckpoints(documentId).map((c) => c.kind)).toEqual([
      'initial',
      'user',
    ])
  })

  it('같은 버전에서 체크포인트를 여러 번 남길 수 있다', () => {
    const { documentId } = register()
    harness.write(['실험 목적', '실험 방법', '고쳐 쓴 결과'])
    harness.session.handleSaved(documentId)

    const first = harness.session.markCheckpoint(documentId, '1차 점검')
    const second = harness.session.markCheckpoint(documentId, '2차 점검')
    if ('ok' in first) throw new Error(first.message)
    if ('ok' in second) throw new Error(second.message)

    expect(second.versionId).toBe(first.versionId)
    expect(second.filePath).not.toBe(first.filePath)
    expect(readFileSync(first.filePath).equals(readFileSync(second.filePath))).toBe(true)
    expect(harness.repo.listCheckpoints(documentId).map((c) => c.label)).toEqual([
      '최초본',
      '1차 점검',
      '2차 점검',
    ])
  })

  it('기록되지 않은 저장이 있으면 먼저 버전으로 기록한 뒤 그 버전에 체크포인트를 단다', () => {
    const { documentId } = register()
    // 저장 알림 없이 파일만 바뀌었다.
    harness.write(['실험 목적', '실험 방법', '알림 없이 고친 결과'])

    const marked = harness.session.markCheckpoint(documentId, '제출 전')
    if ('ok' in marked) throw new Error(marked.message)

    const latest = harness.repo.latestVersion(documentId)
    expect(latest?.ordinal).toBe(2)
    expect(marked.versionId).toBe(latest?.id)
    // 체크포인트가 가리키는 버전과 보관한 바이트가 같다.
    expect(marked.contentHash).toBe(latest?.contentHash)
    expect(marked.contentHash).toBe(sha256File(harness.documentPath))
  })

  it('이름이 너무 길면 남기지 않는다', () => {
    const { documentId } = register()

    const marked = harness.session.markCheckpoint(documentId, '가'.repeat(51))
    expect('ok' in marked && marked.reason).toBe('invalid-label')
    expect(harness.repo.listCheckpoints(documentId)).toHaveLength(1)
    expect(readdirSync(join(harness.checkpointRoot, documentId))).toHaveLength(1)
  })

  it('이름을 비우면 가리키는 버전으로 이름을 붙인다 ([Q-39])', () => {
    const { documentId } = register()

    for (const label of ['', '   ']) {
      const marked = harness.session.markCheckpoint(documentId, label)
      expect('ok' in marked).toBe(false)
      if ('ok' in marked) return
      expect(marked.label).toBe('버전 1 시점')
    }
    expect(harness.repo.listCheckpoints(documentId)).toHaveLength(3)
  })

  it('복사한 사본이 가리킬 버전과 다르면 사본을 남기지 않는다', () => {
    const store = createCheckpointStore(tempDir('store-'))
    const input = {
      checkpointId: 'cp-1',
      documentId: 'doc-1',
      versionId: 'ver-1',
      kind: 'user' as const,
      sourcePath: harness.documentPath,
    }

    // 복사하는 사이 한글이 다시 저장해 기록된 해시와 다른 바이트가 복사된 상황.
    expect(() => store.save({ ...input, expectedContentHash: 'a'.repeat(64) })).toThrow(
      '다시 저장됐습니다',
    )
    const saved = store.save({ ...input, expectedContentHash: sha256File(harness.documentPath) })
    expect(store.verify(saved)).toBe(true)
  })

  it('최초본을 새 경로로 되살릴 수 있다', () => {
    const original = readFileSync(harness.documentPath)
    const { documentId } = register()

    harness.write(['전부 지워 버린 내용'])
    harness.session.handleSaved(documentId)

    const initial = harness.repo.listCheckpoints(documentId).find((c) => c.kind === 'initial')
    expect(initial).toBeDefined()
    if (initial === undefined) return

    const destination = join(tempDir('restore-'), '되살린보고서.hwpx')
    const restored = harness.session.restoreCheckpoint(initial.id, destination, {
      confirmed: true,
    })
    expect(restored.ok).toBe(true)
    expect(readFileSync(destination).equals(original)).toBe(true)
    // 되살려도 지금 문서를 건드리지 않는다.
    expect(hwpxReader.read(harness.documentPath).paragraphs).toHaveLength(1)
  })

  it('확인 없이는 복구하지 않는다', () => {
    const { documentId } = register()
    const initial = harness.repo.listCheckpoints(documentId)[0]
    expect(initial).toBeDefined()
    if (initial === undefined) return

    const destination = join(tempDir('restore-'), '되살린보고서.hwpx')
    expect(() =>
      harness.session.restoreCheckpoint(initial.id, destination, { confirmed: false }),
    ).toThrow('확인')
  })

  it('이미 파일이 있는 경로는 덮어쓰지 않는다', () => {
    const { documentId } = register()
    const initial = harness.repo.listCheckpoints(documentId)[0]
    if (initial === undefined) return

    const before = sha256File(harness.documentPath)
    expect(() =>
      harness.session.restoreCheckpoint(initial.id, harness.documentPath, { confirmed: true }),
    ).toThrow('복구하지 않습니다')
    // 원본은 그대로다 (T-13).
    expect(sha256File(harness.documentPath)).toBe(before)
  })
})

describe('이 경로에는 AI 가 없다 (T-9)', () => {
  const ROOT = join(import.meta.dirname, '..', 'src')

  function sourcesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return sourcesUnder(full)
      return entry.name.endsWith('.ts') ? [full] : []
    })
  }

  /** 주석은 걷어낸다. 문서 안의 "CLAUDE.md" 언급까지 잡히면 오탐이다. */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  it('저장 감지·Diff·버전 경로가 모델 어댑터를 부르지 않는다', () => {
    // 저장 감지·Diff·버전 경로만 본다. app/review-request.ts 는 검토 경로이고
    // 모델을 부르는 것이 그 파일의 일이므로 대상이 아니다 (T-9 는 저장 경로에 대한 불변식이다).
    const savePathFiles = [
      ...sourcesUnder(join(ROOT, 'core', 'diff')),
      ...sourcesUnder(join(ROOT, 'adapters', 'watcher')),
      ...sourcesUnder(join(ROOT, 'adapters', 'checkpoint')),
      join(ROOT, 'app', 'document-session.ts'),
    ]
    const offenders = savePathFiles.filter((file) =>
      /adapters\/model|openrouter|claude/i.test(code(file)),
    )
    expect(offenders).toEqual([])
  })

  it('전체 디스크 접근 권한을 요청하는 코드가 없다 (T-31)', () => {
    const offenders = sourcesUnder(ROOT).filter((file) =>
      /askForMediaAccess|kTCCService|Full ?Disk ?Access|fullDiskAccess/i.test(
        readFileSync(file, 'utf8'),
      ),
    )
    expect(offenders).toEqual([])
  })
})
