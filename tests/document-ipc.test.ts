/**
 * 메인 프로세스 문서 처리 — 등록·재선택이 실제 감시로 이어지는지.
 *
 * 저장 감지 로직이 아무리 맞아도 앱이 감시를 걸지 않으면 저장은 감지되지 않는다.
 * 여기서는 Electron 없이 핸들러를 만들어, 다이얼로그로 고른 문서가 감시되고 감시 결과가 화면 쪽으로
 * 전달되는지 확인한다.
 *
 * T-16 경로를 잃으면 감시를 멈추고 알린 뒤, 재선택으로 같은 문서에 이어진다
 * T-15 최초본·사용자 지정 체크포인트를 앱에서 남기고 되살릴 수 있다
 * T-13 되살려도 원본 HWPX 의 바이트가 변하지 않는다
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCheckpointStore, sha256File } from '../src/adapters/checkpoint/index.js'
import { hwpxReader } from '../src/adapters/hwpx/index.js'
import { createDocumentRepository, type DocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { WatchTargetError, type FileWatcher, type WatchEvent } from '../src/adapters/watcher/index.js'
import { createDocumentSession } from '../src/app/document-session.js'
import {
  createDocumentHandlers,
  HWPX_OPEN_DIALOG_OPTIONS,
  type ConfirmRequest,
  type DocumentHandlers,
  type HwpxOpenDialogOptions,
  type HwpxSaveDialogOptions,
  type OpenDialogResult,
  type SaveDialogResult,
} from '../src/main/document-ipc.js'
import type { DocumentEvent } from '../src/shared/ipc.js'

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

/**
 * 감시가 걸린 경로와 멈춘 경로를 기록하는 가짜 감시자.
 * 실제 감시자처럼 없는 경로는 감시하지 않고 거절한다.
 */
function fakeWatcher(): {
  watcher: FileWatcher
  active: () => string[]
  emit: (path: string, event: WatchEvent) => void
} {
  const active = new Map<string, (event: WatchEvent) => void>()
  return {
    watcher: {
      watch(path, onEvent): Promise<() => void> {
        if (!existsSync(path)) {
          return Promise.reject(new WatchTargetError(`문서 경로를 찾을 수 없습니다: ${path}`))
        }
        active.set(path, onEvent)
        return Promise.resolve(() => {
          if (active.get(path) === onEvent) active.delete(path)
        })
      },
    },
    active: () => [...active.keys()],
    emit: (path, event) => {
      const listener = active.get(path)
      // 실제 감시자도 path-lost 를 내기 전에 스스로 멈춘다 (fsevents-watcher.ts).
      if (event.kind === 'path-lost') active.delete(path)
      listener?.(event)
    },
  }
}

interface Harness {
  repo: DocumentRepository
  handlers: DocumentHandlers
  fake: ReturnType<typeof fakeWatcher>
  events: DocumentEvent[]
  dialogs: HwpxOpenDialogOptions[]
  saveDialogs: HwpxSaveDialogOptions[]
  confirms: ConfirmRequest[]
  /** 다음 파일 선택 창에서 사용자가 고를 경로. null 이면 취소 */
  pick: (path: string | null) => void
  /** 다음 저장 위치 창에서 사용자가 고를 경로. null 이면 취소 */
  pickSave: (path: string | null) => void
  /** 다음 확인 창에서 사용자가 누를 답 */
  answer: (confirmed: boolean) => void
  documentPath: string
}

let harness: Harness

function createHarness(): Harness {
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
    now: () => new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    newId: () => `id-${(counter += 1)}`,
  })

  const documentPath = join(tempDir('docs-'), '실험보고서.hwpx')
  writeFileSync(documentPath, hwpx(['실험 목적', '실험 방법', '실험 결과']))

  const events: DocumentEvent[] = []
  const dialogs: HwpxOpenDialogOptions[] = []
  const saveDialogs: HwpxSaveDialogOptions[] = []
  const confirms: ConfirmRequest[] = []
  let next: string | null = null
  let nextSave: string | null = null
  let nextAnswer = false

  const handlers = createDocumentHandlers({
    session,
    repo,
    showOpenDialog: (options): Promise<OpenDialogResult> => {
      dialogs.push(options)
      return Promise.resolve(
        next === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [next] },
      )
    },
    showSaveDialog: (options): Promise<SaveDialogResult> => {
      saveDialogs.push(options)
      return Promise.resolve(
        nextSave === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: nextSave },
      )
    },
    confirm: (request) => {
      confirms.push(request)
      return Promise.resolve(nextAnswer)
    },
    notify: (event) => events.push(event),
  })
  cleanups.push(() => handlers.stopWatching())

  return {
    repo,
    handlers,
    fake,
    events,
    dialogs,
    saveDialogs,
    confirms,
    pick: (path) => {
      next = path
    },
    pickSave: (path) => {
      nextSave = path
    },
    answer: (confirmed) => {
      nextAnswer = confirmed
    },
    documentPath,
  }
}

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

async function chooseInitial(): Promise<string> {
  harness.pick(harness.documentPath)
  const result = await harness.handlers.chooseDocument('화학')
  if (result.status !== 'registered') throw new Error(`등록 실패: ${JSON.stringify(result)}`)
  return result.document.documentId
}

describe('문서 선택', () => {
  it('작업 공간은 저장된 문단과 실제 버전 기록을 AI 없이 반환한다', async () => {
    const documentId = await chooseInitial()
    const result = harness.handlers.getDocumentWorkspace(documentId)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.workspace.document.documentId).toBe(documentId)
    expect(result.workspace.paragraphs.map((p) => p.number)).toEqual([1, 2, 3])
    expect(result.workspace.versions).toMatchObject([{ ordinal: 1, paragraphCount: 3 }])
    expect(result.workspace.paragraphs.every((p) => !p.changed)).toBe(true)
  })

  it('새로고침은 새 저장의 변경 표시·최신 버전을 반환하고 같은 저장은 중복 기록하지 않는다', async () => {
    const documentId = await chooseInitial()
    const old = harness.handlers.getDocumentWorkspace(documentId)
    if (old.status !== 'ok') throw new Error('작업 공간을 읽지 못했습니다.')
    const texts = old.workspace.paragraphs.map((p) => p.text)
    texts[1] = '새로 수정한 문단입니다.'
    writeFileSync(harness.documentPath, hwpx(texts))
    const result = harness.handlers.refreshDocument(documentId)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.workspace.versions[0]).toMatchObject({ ordinal: 2, changedCount: 1 })
    expect(result.workspace.paragraphs.filter((p) => p.changed).map((p) => p.text))
      .toEqual(['새로 수정한 문단입니다.'])
    harness.handlers.refreshDocument(documentId)
    expect(harness.repo.listVersions(documentId)).toHaveLength(2)
  })

  it('경로를 잃어도 작업 공간은 읽고, 임의 경로·잘못된 대상은 받지 않는다', async () => {
    const documentId = await chooseInitial()
    harness.repo.setPathLost(documentId, true)
    expect(harness.handlers.getDocumentWorkspace(documentId).status).toBe('ok')
    expect(harness.handlers.refreshDocument(documentId).status).toBe('failed')
    expect(harness.handlers.getDocumentWorkspace('/tmp/other.hwpx').status).toBe('failed')
    expect(harness.handlers.getDocumentWorkspace(null).status).toBe('failed')
  })
  it('고른 문서를 등록하고 바로 감시를 건다', async () => {
    const documentId = await chooseInitial()

    expect(harness.dialogs[0]).toEqual(HWPX_OPEN_DIALOG_OPTIONS)
    expect(harness.fake.active()).toEqual([harness.documentPath])
    expect(harness.repo.getDocument(documentId)?.path).toBe(harness.documentPath)
  })

  it('감시가 알린 저장을 버전으로 남기고 화면에 알린다', async () => {
    const documentId = await chooseInitial()

    writeFileSync(harness.documentPath, hwpx(['실험 목적', '실험 방법', '실험 결과와 고찰']))
    harness.fake.emit(harness.documentPath, {
      kind: 'saved',
      path: harness.documentPath,
      byteSize: 0,
    })

    expect(harness.events).toEqual([
      {
        kind: 'saved',
        documentId,
        versionOrdinal: 2,
        changedCount: 1,
        removedCount: 0,
        alreadyKnown: false,
      },
    ])
    expect(harness.repo.listVersions(documentId)).toHaveLength(2)
  })

  it('같은 문서를 다시 골라도 감시를 두 번 걸지 않는다', async () => {
    await chooseInitial()
    await chooseInitial()

    expect(harness.fake.active()).toEqual([harness.documentPath])
    expect(harness.repo.listDocuments()).toHaveLength(1)
  })

  it('취소하면 아무것도 등록하지도 감시하지도 않는다', async () => {
    harness.pick(null)
    expect(await harness.handlers.chooseDocument('화학')).toEqual({ status: 'canceled' })
    expect(harness.repo.listDocuments()).toEqual([])
    expect(harness.fake.active()).toEqual([])
  })

  it('등록할 때 입력한 과목을 정규화해 저장한다 (PRD 4.4)', async () => {
    harness.pick(harness.documentPath)
    const result = await harness.handlers.chooseDocument('  일반화학　실험 ')
    if (result.status !== 'registered') throw new Error('등록 실패')

    expect(result.document.subject).toBe('일반화학 실험')
    expect(harness.repo.getDocument(result.document.documentId)?.subject).toBe('일반화학 실험')
  })

  it('과목을 비워도 등록한다 — 과목은 선택이다 ([Q-52])', async () => {
    harness.pick(harness.documentPath)
    const result = await harness.handlers.chooseDocument('   ')

    expect(result).toMatchObject({ status: 'registered', document: { subject: null } })
    expect(harness.repo.listDocuments()).toHaveLength(1)
  })

  it('과목 없이 등록된 문서도 나중에 과목을 채울 수 있다', async () => {
    const documentId = await chooseInitial()

    const saved = harness.handlers.setSubject(documentId, '물리학 실험')
    expect(saved).toMatchObject({ status: 'saved', document: { subject: '물리학 실험' } })

    // 비우면 과목 없는 보고서로 돌아간다 ([Q-52]).
    expect(harness.handlers.setSubject(documentId, '  ')).toMatchObject({ status: 'saved', document: { subject: null } })
    expect(harness.repo.getDocument(documentId)?.subject).toBeNull()
  })

  it('HWPX 가 아니면 감시하지 않고 안내한다', async () => {
    const other = join(tempDir('other-'), '보고서.docx')
    writeFileSync(other, 'x')
    harness.pick(other)

    const result = await harness.handlers.chooseDocument('화학')
    expect(result.status).toBe('failed')
    expect(harness.fake.active()).toEqual([])
  })
})

describe('경로 유실과 재선택 (T-16)', () => {
  it('경로를 잃으면 감시를 멈추고 알린다', async () => {
    const documentId = await chooseInitial()

    harness.fake.emit(harness.documentPath, {
      kind: 'path-lost',
      path: harness.documentPath,
      reason: 'missing',
      message: '문서 경로를 찾을 수 없습니다.',
    })

    expect(harness.events).toEqual([
      { kind: 'path-lost', documentId, message: '문서 경로를 찾을 수 없습니다.' },
    ])
    expect(harness.repo.getDocument(documentId)?.pathLost).toBe(true)
    expect(harness.handlers.listDocuments()[0]?.pathLost).toBe(true)
  })

  it('저장 처리 중 경로가 사라진 것을 알게 돼도 감시를 멈추고 알린다', async () => {
    const documentId = await chooseInitial()
    rmSync(harness.documentPath)

    harness.fake.emit(harness.documentPath, {
      kind: 'saved',
      path: harness.documentPath,
      byteSize: 0,
    })

    expect(harness.events[0]?.kind).toBe('path-lost')
    expect(harness.fake.active()).toEqual([])
    expect(harness.repo.getDocument(documentId)?.pathLost).toBe(true)
  })

  it('다른 이름·다른 폴더로 다시 고르면 같은 문서에 이어지고 새 경로를 감시한다', async () => {
    const documentId = await chooseInitial()
    const moved = join(tempDir('moved-'), '실험보고서-최종.hwpx')
    renameSync(harness.documentPath, moved)
    harness.fake.emit(harness.documentPath, {
      kind: 'path-lost',
      path: harness.documentPath,
      reason: 'missing',
      message: '문서 경로를 찾을 수 없습니다.',
    })

    harness.pick(moved)
    const result = await harness.handlers.reconnectDocument(documentId)

    expect(result.status).toBe('reconnected')
    if (result.status !== 'reconnected') return
    // 새 문서가 아니라 원래 문서다. 버전·체크포인트 기록이 그대로 남는다.
    expect(result.document.documentId).toBe(documentId)
    expect(result.document.path).toBe(moved)
    expect(result.document.pathLost).toBe(false)
    expect(harness.repo.listDocuments()).toHaveLength(1)
    expect(harness.repo.listVersions(documentId)).toHaveLength(1)
    expect(harness.repo.listCheckpoints(documentId).map((c) => c.kind)).toEqual(['initial'])
    // 재선택 창은 새 문서 등록 창과 구별된다.
    expect(harness.dialogs[1]?.title).toContain('실험보고서.hwpx')

    // 이어 붙인 경로의 저장이 같은 문서의 다음 버전이 된다.
    expect(harness.fake.active()).toEqual([moved])
    writeFileSync(moved, hwpx(['실험 목적', '실험 방법', '실험 결과와 고찰']))
    harness.fake.emit(moved, { kind: 'saved', path: moved, byteSize: 0 })

    expect(harness.events.at(-1)).toMatchObject({
      kind: 'saved',
      documentId,
      versionOrdinal: 2,
      changedCount: 1,
    })
  })

  it('재선택을 취소하면 경로 유실 상태를 유지한다', async () => {
    const documentId = await chooseInitial()
    rmSync(harness.documentPath)
    harness.fake.emit(harness.documentPath, {
      kind: 'path-lost',
      path: harness.documentPath,
      reason: 'missing',
      message: '문서 경로를 찾을 수 없습니다.',
    })

    harness.pick(null)
    expect(await harness.handlers.reconnectDocument(documentId)).toEqual({ status: 'canceled' })
    expect(harness.repo.getDocument(documentId)?.pathLost).toBe(true)
    expect(harness.fake.active()).toEqual([])
  })

  it('다른 문서로 등록된 파일에는 이어 붙이지 않는다', async () => {
    const documentId = await chooseInitial()
    const otherPath = join(tempDir('other-'), '다른보고서.hwpx')
    writeFileSync(otherPath, hwpx(['다른 문서']))
    harness.pick(otherPath)
    await harness.handlers.chooseDocument('화학')

    harness.pick(otherPath)
    const result = await harness.handlers.reconnectDocument(documentId)
    expect(result.status).toBe('failed')
    expect(harness.repo.getDocument(documentId)?.path).toBe(harness.documentPath)
  })

  it('등록되지 않은 문서는 재선택 창을 열지 않는다', async () => {
    const result = await harness.handlers.reconnectDocument('없는-문서')
    expect(result.status).toBe('failed')
    expect(harness.dialogs).toEqual([])
  })
})

describe('체크포인트 남기기 (T-15)', () => {
  it('지금 시점을 이름을 붙여 남기고 문서 목록에 보인다', async () => {
    const documentId = await chooseInitial()
    writeFileSync(harness.documentPath, hwpx(['실험 목적', '실험 방법', '제출 직전 결과']))
    harness.fake.emit(harness.documentPath, { kind: 'saved', path: harness.documentPath, byteSize: 0 })

    const result = harness.handlers.markCheckpoint(documentId, '  제출 전  ')

    expect(result.status).toBe('marked')
    if (result.status !== 'marked') return
    expect(result.checkpoint).toMatchObject({ kind: 'user', label: '제출 전', versionOrdinal: 2 })
    expect(result.document.checkpoints.map((c) => [c.kind, c.label, c.versionOrdinal])).toEqual([
      ['initial', '최초본', 1],
      ['user', '제출 전', 2],
    ])
    expect(harness.handlers.listDocuments()[0]?.checkpoints).toEqual(result.document.checkpoints)

    // 보관 사본은 그 시점 파일과 바이트가 같다.
    const row = harness.repo.getCheckpoint(result.checkpoint.checkpointId)
    expect(row).not.toBeNull()
    if (row === null) return
    expect(readFileSync(row.filePath).equals(readFileSync(harness.documentPath))).toBe(true)
  })

  it('아직 기록되지 않은 저장이 있으면 먼저 버전으로 기록하고 그 버전을 가리킨다', async () => {
    const documentId = await chooseInitial()
    // 감시 알림 없이 파일만 바뀌었다 (앱이 꺼져 있던 동안의 저장 등).
    writeFileSync(harness.documentPath, hwpx(['실험 목적', '실험 방법', '앱 밖에서 고친 결과']))

    const result = harness.handlers.markCheckpoint(documentId, '제출 전')

    expect(result.status).toBe('marked')
    if (result.status !== 'marked') return
    expect(result.checkpoint.versionOrdinal).toBe(2)
    expect(result.document.versionCount).toBe(2)
  })

  it('이름이 비어 있으면 버전 번호로 이름을 붙여 남긴다 ([Q-39])', async () => {
    const documentId = await chooseInitial()

    const result = harness.handlers.markCheckpoint(documentId, '   ')

    expect(result.status).toBe('marked')
    if (result.status !== 'marked') return
    expect(result.checkpoint.label).toBe('버전 1 시점')
    expect(harness.repo.listCheckpoints(documentId)).toHaveLength(2)
  })

  it('경로를 잃은 문서는 남기지 않고, 감시를 멈추고 경로 유실로 알린다', async () => {
    const documentId = await chooseInitial()
    rmSync(harness.documentPath)

    const result = harness.handlers.markCheckpoint(documentId, '제출 전')

    expect(result.status).toBe('failed')
    expect(harness.events.at(-1)?.kind).toBe('path-lost')
    expect(harness.fake.active()).toEqual([])
    expect(harness.repo.getDocument(documentId)?.pathLost).toBe(true)
    expect(harness.repo.listCheckpoints(documentId)).toHaveLength(1)
  })

  it('등록되지 않은 문서에는 남기지 않는다', () => {
    expect(harness.handlers.markCheckpoint('없는-문서', '제출 전').status).toBe('failed')
  })
})

describe('체크포인트 되살리기 (T-15, T-13)', () => {
  function checkpointIdOf(documentId: string, kind: 'initial' | 'user'): string {
    const found = harness.repo.listCheckpoints(documentId).find((c) => c.kind === kind)
    if (found === undefined) throw new Error(`${kind} 체크포인트가 없습니다`)
    return found.id
  }

  it('저장 위치를 고르고 확인하면 최초본을 새 파일로 되살린다. 원본은 그대로다', async () => {
    const original = readFileSync(harness.documentPath)
    const documentId = await chooseInitial()
    const edited = hwpx(['전부 지워 버린 내용'])
    writeFileSync(harness.documentPath, edited)
    harness.fake.emit(harness.documentPath, { kind: 'saved', path: harness.documentPath, byteSize: 0 })

    const destination = join(tempDir('restore-'), '되살린보고서.hwpx')
    harness.pickSave(destination)
    harness.answer(true)
    const result = await harness.handlers.restoreCheckpoint(checkpointIdOf(documentId, 'initial'))

    expect(result).toEqual({ status: 'restored', path: destination })
    expect(readFileSync(destination).equals(original)).toBe(true)
    // 되살리기는 새 파일만 만든다. 지금 문서를 건드리지 않는다.
    expect(readFileSync(harness.documentPath).equals(Buffer.from(edited))).toBe(true)

    // 저장 창은 원본 옆에 원본과 다른 이름을 제안하고, 확인 창은 어디에 만드는지 알려 준다.
    const offered = harness.saveDialogs[0]?.defaultPath ?? ''
    expect(dirname(offered)).toBe(dirname(harness.documentPath))
    expect(basename(offered)).not.toBe(basename(harness.documentPath))
    expect(offered.endsWith('.hwpx')).toBe(true)
    expect(harness.confirms[0]?.detail).toContain(destination)
  })

  it('사용자 지정 체크포인트를 그 시점의 바이트로 되살린다', async () => {
    const documentId = await chooseInitial()
    writeFileSync(harness.documentPath, hwpx(['실험 목적', '실험 방법', '제출 직전 결과']))
    const atMark = readFileSync(harness.documentPath)
    const marked = harness.handlers.markCheckpoint(documentId, '제출 전')
    if (marked.status !== 'marked') throw new Error(marked.message)

    writeFileSync(harness.documentPath, hwpx(['나중에 크게 바꾼 내용']))
    harness.fake.emit(harness.documentPath, { kind: 'saved', path: harness.documentPath, byteSize: 0 })

    const destination = join(tempDir('restore-'), '제출전.hwpx')
    harness.pickSave(destination)
    harness.answer(true)
    const result = await harness.handlers.restoreCheckpoint(marked.checkpoint.checkpointId)

    expect(result.status).toBe('restored')
    expect(readFileSync(destination).equals(atMark)).toBe(true)
  })

  it('저장 위치 선택을 취소하면 확인을 묻지도 파일을 만들지도 않는다', async () => {
    const documentId = await chooseInitial()
    harness.pickSave(null)
    harness.answer(true)

    const result = await harness.handlers.restoreCheckpoint(checkpointIdOf(documentId, 'initial'))

    expect(result).toEqual({ status: 'canceled' })
    expect(harness.confirms).toEqual([])
  })

  it('확인 창에서 취소하면 파일을 만들지 않는다', async () => {
    const documentId = await chooseInitial()
    const destination = join(tempDir('restore-'), '되살린보고서.hwpx')
    harness.pickSave(destination)
    harness.answer(false)

    const result = await harness.handlers.restoreCheckpoint(checkpointIdOf(documentId, 'initial'))

    expect(result).toEqual({ status: 'canceled' })
    expect(existsSync(destination)).toBe(false)
  })

  it('확장자 없이 이름만 적어도 HWPX 로 되살린다', async () => {
    const documentId = await chooseInitial()
    const withoutExtension = join(tempDir('restore-'), '되살린보고서')
    harness.pickSave(withoutExtension)
    harness.answer(true)

    const result = await harness.handlers.restoreCheckpoint(checkpointIdOf(documentId, 'initial'))

    expect(result).toEqual({ status: 'restored', path: `${withoutExtension}.hwpx` })
    expect(existsSync(`${withoutExtension}.hwpx`)).toBe(true)
  })

  it('원본 자리를 골라도 덮어쓰지 않고 알린다', async () => {
    const documentId = await chooseInitial()
    writeFileSync(harness.documentPath, hwpx(['실험 목적', '고친 내용']))
    const before = readFileSync(harness.documentPath)
    harness.pickSave(harness.documentPath)
    harness.answer(true)

    const result = await harness.handlers.restoreCheckpoint(checkpointIdOf(documentId, 'initial'))

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.message).toContain('복구하지 않습니다')
    expect(readFileSync(harness.documentPath).equals(before)).toBe(true)
  })

  it('경로를 잃은 뒤에도 보관 사본에서 되살릴 수 있다', async () => {
    const original = readFileSync(harness.documentPath)
    const documentId = await chooseInitial()
    rmSync(harness.documentPath)
    harness.fake.emit(harness.documentPath, {
      kind: 'path-lost',
      path: harness.documentPath,
      reason: 'missing',
      message: '문서 경로를 찾을 수 없습니다.',
    })

    const destination = join(tempDir('restore-'), '되살린보고서.hwpx')
    harness.pickSave(destination)
    harness.answer(true)
    const result = await harness.handlers.restoreCheckpoint(checkpointIdOf(documentId, 'initial'))

    expect(result.status).toBe('restored')
    expect(readFileSync(destination).equals(original)).toBe(true)
  })

  it('없는 체크포인트는 저장 창을 열지 않는다', async () => {
    const result = await harness.handlers.restoreCheckpoint('없는-체크포인트')
    expect(result.status).toBe('failed')
    expect(harness.saveDialogs).toEqual([])
  })
})

describe('앱을 켜고 끌 때', () => {
  it('앱이 꺼진 동안 저장한 내용은 재시작 때 별도 저장 이벤트 없이 동기화된다', async () => {
    const documentId = await chooseInitial()
    harness.handlers.stopWatching()
    writeFileSync(harness.documentPath, hwpx(['새 목적', '실험 방법', '실험 결과']))
    const events: DocumentEvent[] = []
    const restarted = createHarnessOnSameRepo(events)
    try {
      await restarted.resumeWatching()
      const latest = harness.repo.latestVersion(documentId)!
      expect(latest.ordinal).toBe(2)
      expect(harness.repo.listParagraphs(latest.id)[0]?.paragraph.text).toBe('새 목적')
      expect(events).toContainEqual(expect.objectContaining({ kind: 'saved', versionOrdinal: 2 }))
    } finally {
      restarted.stopWatching()
    }
  })
  it('경로를 잃지 않은 문서의 감시를 다시 건다', async () => {
    const documentId = await chooseInitial()
    const lostPath = join(tempDir('lost-'), '사라질보고서.hwpx')
    writeFileSync(lostPath, hwpx(['사라질 문서']))
    harness.pick(lostPath)
    const lost = await harness.handlers.chooseDocument('화학')
    if (lost.status !== 'registered') throw new Error('등록 실패')

    // 앱을 끈다. 꺼져 있는 동안 한 문서가 사라진다.
    harness.handlers.stopWatching()
    expect(harness.fake.active()).toEqual([])
    rmSync(lostPath)

    // 앱을 다시 켠 것처럼 새 핸들러를 같은 저장소 위에 만든다.
    const events: DocumentEvent[] = []
    const restarted = createHarnessOnSameRepo(events)
    await restarted.resumeWatching()

    expect(harness.fake.active()).toEqual([harness.documentPath])
    // 꺼져 있는 동안 사라진 문서는 감시하지 않고 경로 유실로 알린다.
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'path-lost', documentId: lost.document.documentId }),
    )
    expect(harness.repo.getDocument(lost.document.documentId)?.pathLost).toBe(true)
    expect(harness.repo.getDocument(documentId)?.pathLost).toBe(false)
    restarted.stopWatching()
  })

  it('경로를 잃은 문서는 다시 고를 때까지 감시하지 않는다', async () => {
    const documentId = await chooseInitial()
    harness.handlers.stopWatching()
    harness.repo.setPathLost(documentId, true)

    const restarted = createHarnessOnSameRepo([])
    await restarted.resumeWatching()
    expect(harness.fake.active()).toEqual([])
    restarted.stopWatching()
  })

  it('끌 때 모든 감시를 멈춘다', async () => {
    await chooseInitial()
    harness.handlers.stopWatching()
    expect(harness.fake.active()).toEqual([])
  })
})

/** 같은 저장소·같은 가짜 감시자 위에 핸들러를 새로 만든다 (앱 재시작 흉내). */
function createHarnessOnSameRepo(events: DocumentEvent[]): DocumentHandlers {
  let counter = 1000
  const session = createDocumentSession({
    repo: harness.repo,
    reader: hwpxReader,
    watcher: harness.fake.watcher,
    checkpoints: createCheckpointStore(tempDir('cp-')),
    hashFile: sha256File,
    fileSize: (path) => statSync(path).size,
    now: () => new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    newId: () => `id-${(counter += 1)}`,
  })
  return createDocumentHandlers({
    session,
    repo: harness.repo,
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
    confirm: () => Promise.resolve(false),
    notify: (event) => events.push(event),
  })
}

describe('삭제 (사용자 결정 2026-09-27)', () => {
  it('확인하면 보고서의 기록과 체크포인트 사본을 모두 지우고 감시를 멈춘다. 한글 원본은 그대로다', async () => {
    const original = readFileSync(harness.documentPath)
    const documentId = await chooseInitial()
    const marked = harness.handlers.markCheckpoint(documentId, '제출 전')
    if (marked.status !== 'marked') throw new Error(marked.message)
    const copies = harness.repo.listCheckpoints(documentId).map((c) => c.filePath)
    expect(copies.every((path) => existsSync(path))).toBe(true)

    harness.answer(true)
    const result = await harness.handlers.deleteDocument(documentId)

    expect(result).toEqual({ status: 'deleted' })
    expect(harness.confirms.at(-1)?.detail).toContain('한글 원본 파일은 그대로')
    expect(harness.repo.getDocument(documentId)).toBeNull()
    expect(harness.repo.listVersions(documentId)).toEqual([])
    expect(harness.repo.listCheckpoints(documentId)).toEqual([])
    expect(copies.some((path) => existsSync(path))).toBe(false)
    expect(harness.fake.active()).toEqual([])
    expect(harness.handlers.listDocuments()).toEqual([])
    expect(readFileSync(harness.documentPath).equals(original)).toBe(true)
  })

  it('확인 창에서 취소하면 아무것도 지우지 않고 감시도 그대로다', async () => {
    const documentId = await chooseInitial()
    harness.answer(false)
    expect(await harness.handlers.deleteDocument(documentId)).toEqual({ status: 'canceled' })
    expect(harness.repo.getDocument(documentId)).not.toBeNull()
    expect(harness.fake.active()).toEqual([harness.documentPath])
  })

  it('지운 보고서를 다시 불러오면 새 보고서로 처음부터 기록한다', async () => {
    const documentId = await chooseInitial()
    harness.answer(true)
    await harness.handlers.deleteDocument(documentId)
    const again = await chooseInitial()
    expect(again).not.toBe(documentId)
    expect(harness.repo.listVersions(again)).toHaveLength(1)
  })

  it('사용자 체크포인트를 확인 후 사본과 함께 지운다', async () => {
    const documentId = await chooseInitial()
    const marked = harness.handlers.markCheckpoint(documentId, '제출 전')
    if (marked.status !== 'marked') throw new Error(marked.message)
    const copy = harness.repo.getCheckpoint(marked.checkpoint.checkpointId)?.filePath ?? ''

    harness.answer(true)
    const result = await harness.handlers.deleteCheckpoint(marked.checkpoint.checkpointId)

    expect(result).toEqual({ status: 'deleted' })
    expect(harness.repo.getCheckpoint(marked.checkpoint.checkpointId)).toBeNull()
    expect(existsSync(copy)).toBe(false)
    expect(harness.repo.listCheckpoints(documentId).map((c) => c.kind)).toEqual(['initial'])
  })

  it('최초본 체크포인트는 확인을 묻지도 지우지도 않는다 (PRD 4.5)', async () => {
    const documentId = await chooseInitial()
    const initial = harness.repo.listCheckpoints(documentId).find((c) => c.kind === 'initial')!
    harness.answer(true)
    const result = await harness.handlers.deleteCheckpoint(initial.id)
    expect(result.status).toBe('failed')
    expect(harness.confirms).toEqual([])
    expect(existsSync(initial.filePath)).toBe(true)
  })

  it('체크포인트 삭제를 취소하면 그대로 둔다', async () => {
    const documentId = await chooseInitial()
    const marked = harness.handlers.markCheckpoint(documentId, '')
    if (marked.status !== 'marked') throw new Error(marked.message)
    harness.answer(false)
    expect(await harness.handlers.deleteCheckpoint(marked.checkpoint.checkpointId)).toEqual({ status: 'canceled' })
    expect(harness.repo.listCheckpoints(documentId)).toHaveLength(2)
  })
})

describe('체크포인트 보관소의 삭제 범위', () => {
  it('보관 폴더 밖의 파일(사용자 문서)은 지우지 않는다', () => {
    const store = createCheckpointStore(tempDir('cp-'))
    const outside = join(tempDir('docs-'), '원본.hwpx')
    writeFileSync(outside, 'x')
    expect(() => store.remove(outside, { confirmed: true })).toThrow()
    expect(() => store.removeDocument('../..', { confirmed: true })).toThrow()
    expect(existsSync(outside)).toBe(true)
  })

  it('확인 없이는 지우지 않는다', () => {
    const root = tempDir('cp-')
    const store = createCheckpointStore(root)
    expect(() => store.remove(join(root, 'a.hwpx'), { confirmed: false })).toThrow()
    expect(() => store.removeDocument('doc', { confirmed: false })).toThrow()
  })
})
