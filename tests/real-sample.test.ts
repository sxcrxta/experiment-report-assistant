/**
 * 실제 한글 for Mac 이 저장한 HWPX 로 하는 검증.
 *
 * 샘플은 개인 문서라 저장소에 커밋하지 않는다 (tests/fixtures/README.md).
 * 샘플이 없으면 이 테스트는 실패하지 않고 건너뛴다. 대신 건너뛴 사실이 출력에 남는다.
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createCheckpointStore, sha256File } from '../src/adapters/checkpoint/index.js'
import { hwpxReader, readHwpx } from '../src/adapters/hwpx/index.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createFileWatcher, type WatchEvent } from '../src/adapters/watcher/index.js'
import { createDocumentSession } from '../src/app/document-session.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const samples = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .filter((name) => name.endsWith('.hwpx'))
      .map((name) => join(FIXTURES, name))
  : []

/** 테스트 이름에 전체 경로 대신 파일 이름만 쓴다. */
const cases = samples.map((path) => [basename(path), path] as const)

describe.skipIf(cases.length === 0)('실제 HWPX 샘플', () => {
  it.each(cases)('%s 에서 문단을 뽑는다', (_name, path) => {
    const doc = readHwpx(path)
    expect(doc.sectionCount).toBeGreaterThan(0)
    expect(doc.paragraphs.length).toBeGreaterThan(0)
    // 문단 번호는 0부터 빈틈없이 이어진다.
    expect(doc.paragraphs.map((p) => p.index)).toEqual(doc.paragraphs.map((_, i) => i))
    // UUID 는 서로 겹치지 않는다.
    expect(new Set(doc.paragraphs.map((p) => p.uuid)).size).toBe(doc.paragraphs.length)
  })

  it.each(cases)('%s 를 두 번 읽으면 같은 결과다', (_name, path) => {
    expect(readHwpx(path)).toEqual(readHwpx(path))
  })

  it.each(cases)('%s 를 읽어도 파일이 변하지 않는다', (_name, path) => {
    const before = readFileSync(path)
    readHwpx(path)
    expect(readFileSync(path).equals(before)).toBe(true)
  })
})

/**
 * 2단계 — 실제 HWPX 로 저장 감지·버전 기록까지 한 번에 지난다.
 *
 * 합성 파일은 크기도 구조도 실제와 다르다. 2MB 짜리 실제 보고서에서도 디바운스와 온전성 확인이
 * 같은 결과를 내는지 확인한다 (`CLAUDE.md` §7: 실제 샘플로 검증하지 않은 문서 처리 코드는
 * 완료로 보고하지 않는다). 실제 한글로 저장해서 하는 확인은 V-1 통합 테스트가 따로 맡는다.
 */
const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')
const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe.skipIf(samples.length === 0)('실제 HWPX — 저장 감지와 버전 (2단계)', () => {
  const source = samples[0] as string

  it('저장을 한 번 감지하고 최초본·체크포인트를 남긴다', async () => {
    const workDir = tempDir('real-watch-')
    const path = join(workDir, '실험보고서.hwpx')
    copyFileSync(source, path)
    const originalHash = sha256File(path)

    const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })
    cleanups.push(() => db.close())
    const repo = createDocumentRepository(db)

    let counter = 0
    const session = createDocumentSession({
      repo,
      reader: hwpxReader,
      watcher: createFileWatcher({ quietPeriodMs: 60, safetyPollMs: 200, missingGraceMs: 200 }),
      checkpoints: createCheckpointStore(tempDir('real-cp-')),
      hashFile: sha256File,
      fileSize: (file) => statSync(file).size,
      now: () => new Date(1_700_000_000_000).toISOString(),
      newId: () => `id-${(counter += 1)}`,
    })

    const registered = session.registerDocument({ path, subject: '화학' })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return

    const paragraphCount = readHwpx(path).paragraphs.length
    expect(registered.version.paragraphCount).toBe(paragraphCount)
    // 체크포인트는 원본과 바이트가 같은 사본이다.
    expect(sha256File(registered.checkpoint.filePath)).toBe(originalHash)

    const events: WatchEvent[] = []
    const stop = await createFileWatcher({
      quietPeriodMs: 60,
      integrityRetries: 20,
      integrityRetryMs: 40,
      missingGraceMs: 200,
      safetyPollMs: 200,
    }).watch(path, (event) => events.push(event))
    cleanups.push(stop)

    // 관찰된 저장 순서를 실제 파일 크기로 재현한다.
    const bytes = readFileSync(path)
    copyFileSync(path, join(workDir, '실험보고서.BAK'))
    truncateSync(path, 8192)
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(path, bytes)
    rmSync(join(workDir, '실험보고서.BAK'))

    const deadline = Date.now() + 10_000
    while (events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('saved')

    // 저장 도중의 잘린 파일을 읽지 않았다. 내용이 같으니 새 버전도 만들지 않는다.
    const saved = session.handleSaved(registered.document.id)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.alreadyKnown).toBe(true)
    expect(repo.listVersions(registered.document.id)).toHaveLength(1)
    expect(sha256File(path)).toBe(originalHash)
  })
})

if (samples.length === 0) {
  console.warn(
    '[건너뜀] tests/fixtures 에 HWPX 샘플이 없어 실제 문서 검증을 하지 못했습니다. ' +
      'tests/fixtures/README.md 를 참고해 샘플을 두면 이 테스트가 켜집니다.',
  )
}
