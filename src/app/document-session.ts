/**
 * 문서 등록과 저장 처리 유스케이스.
 *
 * IMPLEMENTATION_PLAN.md §2.2 의 흐름을 그대로 옮긴다.
 *
 * ```
 * 한글에서 저장 → FileWatcher 가 saved → HWPX 읽기 → 문단 해시 비교
 *   ├ 같은 문단 → 분석 대상에서 제외 (메모이제이션)
 *   └ 다른 구간 → Myers Diff → 문단 추적(분할·병합) → 버전·문단·계보·변경 저장
 * 경로 유실 → 감시 중단 + 알림 → 사용자가 재선택 → 같은 Document 에 재연결
 * ```
 *
 * **이 경로에는 AI 가 전혀 없다** (PRD 4.3, `CLAUDE.md` §2).
 * 이 파일은 조합만 한다. 알고리즘은 `core/diff`, 파일 접근은 어댑터가 맡는다.
 */
import type { CheckpointStore } from '../adapters/checkpoint/index.js'
import type { HwpxReader } from '../adapters/hwpx/index.js'
import type {
  CheckpointRow,
  DiffEntryRow,
  DocumentRepository,
  DocumentRow,
  DocumentVersionRow,
} from '../adapters/repo/documents.js'
import {
  classifyPath,
  toNfc,
  type FileWatcher,
  type PathStatusKind,
  type WatchEvent,
} from '../adapters/watcher/index.js'
import { trackParagraphs, type RemovedParagraph, type TrackedParagraph } from '../core/diff/track.js'
import { normalizeText } from '../core/document/normalize.js'
import { CHECKPOINT_LABEL_MAX_LENGTH, SUBJECT_MAX_LENGTH } from '../shared/ipc.js'

export interface DocumentSessionDeps {
  repo: DocumentRepository
  reader: HwpxReader
  watcher: FileWatcher
  checkpoints: CheckpointStore
  /** 파일 바이트의 sha256 */
  hashFile: (absolutePath: string) => string
  /** 파일 크기 */
  fileSize: (absolutePath: string) => number
  now: () => string
  newId: () => string
}

export type FailureReason =
  | PathStatusKind
  | 'read-failed'
  | 'unknown-document'
  | 'already-linked'
  | 'invalid-label'
  | 'invalid-subject'
  | 'protected-checkpoint'

export interface Failure {
  ok: false
  reason: FailureReason
  /** 사용자에게 그대로 보여 줄 한국어 안내 */
  message: string
}

export interface RegisterInput {
  path: string
  /**
   * 과목 (PRD 4.4: 등록할 때 묻되 선택이다, [Q-52]).
   * 주면 검사해서 저장한다. null 이나 빈 글이면 과목 없이 둔다.
   */
  subject?: string | null
}

export interface RegisterSuccess {
  ok: true
  document: DocumentRow
  version: DocumentVersionRow
  checkpoint: CheckpointRow
  /** 이미 등록돼 있던 문서를 그대로 이어 쓴 경우 */
  reused: boolean
}

export interface SaveSuccess {
  ok: true
  document: DocumentRow
  version: DocumentVersionRow
  changed: TrackedParagraph[]
  removed: RemovedParagraph[]
  unchangedCount: number
  /** 바이트가 이전 버전과 같아 새 버전을 만들지 않은 경우 */
  alreadyKnown: boolean
}

export type SessionEvent =
  | ({ kind: 'saved' } & Omit<SaveSuccess, 'ok'>)
  | { kind: 'path-lost'; documentId: string; message: string }
  | { kind: 'unreadable'; documentId: string; message: string }
  | { kind: 'failed'; documentId: string; reason: FailureReason; message: string }

export interface DocumentSession {
  registerDocument(input: RegisterInput): RegisterSuccess | Failure
  handleSaved(documentId: string): SaveSuccess | Failure
  /** 감시를 시작한다. @returns 감시를 멈추는 함수 */
  startWatching(
    documentId: string,
    listener: (event: SessionEvent) => void,
  ): Promise<() => void>
  /**
   * 사용자가 지금 시점을 체크포인트로 남긴다 (PRD 4.5).
   * 아직 기록되지 않은 저장이 있으면(앱이 꺼져 있던 동안의 저장 등) 먼저 버전으로 기록한 뒤 복사한다.
   * 그래야 체크포인트가 가리키는 버전과 보관한 바이트가 어긋나지 않는다.
   */
  markCheckpoint(documentId: string, label: string): CheckpointRow | Failure
  /** 등록한 문서의 과목을 고친다. 과목 없이 등록된 문서도 여기서 채운다 */
  setSubject(documentId: string, subject: string): DocumentRow | Failure
  /** 경로를 잃은 문서를 사용자가 다시 고른 경로에 이어 붙인다 */
  reconnect(documentId: string, newPath: string): RegisterSuccess | Failure
  /** 체크포인트를 **새 경로**로 되살린다. 원본을 덮어쓰지 않는다 */
  restoreCheckpoint(
    checkpointId: string,
    destinationPath: string,
    options: { confirmed: boolean },
  ): { ok: true; path: string } | Failure
  /**
   * 사용자가 남긴 체크포인트를 지운다. 보관 사본도 함께 지운다.
   * **최초본은 지우지 않는다** — PRD 4.5 가 복구용으로 보관하라고 한 시점이다.
   */
  deleteCheckpoint(checkpointId: string, options: { confirmed: boolean }): { ok: true } | Failure
  /**
   * 보고서를 이 앱에서 지운다. 버전·피드백·판단·체크포인트 사본까지 모두 지운다.
   * **한글 원본 HWPX 에는 닿지 않는다.** 감시는 부르는 쪽이 먼저 멈춘다.
   */
  deleteDocument(documentId: string, options: { confirmed: boolean }): { ok: true } | Failure
}

function displayNameOf(path: string): string {
  const parts = toNfc(path).split('/')
  return parts[parts.length - 1] ?? path
}

/** 이름을 비워 둔 체크포인트에 붙는 이름. 시계가 아니라 버전 번호로 정해 결정론을 지킨다 */
export function defaultCheckpointLabel(versionOrdinal: number): string {
  return `버전 ${versionOrdinal} 시점`
}

/**
 * 과목을 정규화하고 검사한다. 과목은 개인화 지침의 적용 범위("특정 과목")가 되므로
 * 같은 과목이 공백이나 자모 조합 차이로 둘로 갈라지지 않게 문단 텍스트와 같은 규칙으로 정규화한다.
 */
/** 과목은 선택이다 ([Q-52]). 비우면 null — 과목 없는 보고서로 둔다. */
export function normalizeSubject(subject: string): { ok: true; subject: string | null } | Failure {
  const normalized = normalizeText(subject)
  if (normalized === '') return { ok: true, subject: null }
  if (normalized.length > SUBJECT_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'invalid-subject',
      message: `과목은 ${SUBJECT_MAX_LENGTH}자까지 쓸 수 있습니다.`,
    }
  }
  return { ok: true, subject: normalized }
}

function readFailure(cause: unknown): Failure {
  return {
    ok: false,
    reason: 'read-failed',
    message:
      cause instanceof Error
        ? `문서를 읽지 못했습니다: ${cause.message}`
        : '문서를 읽지 못했습니다.',
  }
}

export function createDocumentSession(deps: DocumentSessionDeps): DocumentSession {
  const { repo, reader, watcher, checkpoints, hashFile, fileSize, now, newId } = deps

  function requireDocument(documentId: string): DocumentRow | Failure {
    const document = repo.getDocument(documentId)
    if (document === null) {
      return {
        ok: false,
        reason: 'unknown-document',
        message: '등록되지 않은 문서입니다.',
      }
    }
    return document
  }

  function initialVersionAndCheckpoint(
    document: DocumentRow,
  ): { version: DocumentVersionRow; checkpoint: CheckpointRow } | Failure {
    let paragraphs
    let contentHash: string
    try {
      contentHash = hashFile(document.path)
      paragraphs = reader.read(document.path).paragraphs
      if (hashFile(document.path) !== contentHash) throw new Error('문서가 저장 중입니다. 저장 후 다시 시도해 주세요.')
    } catch (cause) {
      return readFailure(cause)
    }

    const versionId = newId()
    const checkpointId = newId()
    const file = checkpoints.save({
      checkpointId, documentId: document.id, versionId, kind: 'initial', sourcePath: document.path,
      expectedContentHash: contentHash,
    })
    // 읽기와 최초본 복사에 성공하기 전에는 빈 문서 항목을 남기지 않는다.
    if (repo.getDocument(document.id) === null) repo.createDocument(document)
    // 최초본에는 비교할 이전 버전이 없다. 그래서 DiffEntry 를 만들지 않고,
    // 문단 uuid 는 읽기가 내용·위치에서 유도한 값을 그대로 쓴다.
    const version = repo.appendVersion({
      id: versionId,
      documentId: document.id,
      detectedAt: now(),
      sourcePath: document.path,
      byteSize: file.byteSize,
      contentHash,
      paragraphs: paragraphs.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
      lineage: [],
      diffEntries: [],
      previousVersionId: null,
    })

    const checkpoint = repo.addCheckpoint({
      id: checkpointId,
      documentId: document.id,
      versionId: version.id,
      kind: 'initial',
      filePath: file.filePath,
      byteSize: file.byteSize,
      contentHash: file.contentHash,
      label: '최초본',
      createdAt: now(),
    })

    return { version, checkpoint }
  }

  function handleSaved(documentId: string): SaveSuccess | Failure {
    const document = requireDocument(documentId)
    if ('ok' in document) return document

    const status = classifyPath(document.path)
    if (status.kind !== 'ok') {
      repo.setPathLost(document.id, true)
      return { ok: false, reason: status.kind, message: status.message }
    }

    let paragraphs
    let contentHash: string
    try {
      contentHash = hashFile(document.path)
      paragraphs = reader.read(document.path).paragraphs
      if (hashFile(document.path) !== contentHash) throw new Error('문서가 저장 중입니다. 저장 후 다시 시도해 주세요.')
    } catch (cause) {
      return readFailure(cause)
    }

    const previousVersion = repo.latestVersion(document.id)
    if (previousVersion === null) {
      return {
        ok: false,
        reason: 'unknown-document',
        message: '이 문서의 최초본이 없습니다. 문서를 다시 등록해 주세요.',
      }
    }

    if (contentHash === previousVersion.contentHash) {
      // 바이트가 같다. 저장 이벤트가 왔어도 기록할 변경이 없다.
      return {
        ok: true,
        document,
        version: previousVersion,
        changed: [],
        removed: [],
        unchangedCount: previousVersion.paragraphCount,
        alreadyKnown: true,
      }
    }

    const versionId = newId()
    const tracked = trackParagraphs({
      previous: repo.listPreviousParagraphs(previousVersion.id),
      current: paragraphs,
      versionKey: versionId,
    })

    const diffEntries: DiffEntryRow[] = [
      ...tracked.changed.map((entry) => ({
        change: entry.change,
        paragraphUuid: entry.uuid,
        previousParagraphUuid: entry.previousUuid,
        paraIndex: entry.paragraph.index,
      })),
      ...tracked.removed.map((entry) => ({
        change: 'deleted' as const,
        paragraphUuid: entry.uuid,
        previousParagraphUuid: entry.uuid,
        paraIndex: null,
      })),
    ]

    const version = repo.appendVersion({
      id: versionId,
      documentId: document.id,
      detectedAt: now(),
      sourcePath: document.path,
      byteSize: fileSize(document.path),
      contentHash,
      paragraphs: tracked.paragraphs.map((entry) => ({
        uuid: entry.uuid,
        paragraph: entry.paragraph,
      })),
      lineage: tracked.lineage,
      diffEntries,
      previousVersionId: previousVersion.id,
    })

    return {
      ok: true,
      document,
      version,
      changed: tracked.changed,
      removed: tracked.removed,
      unchangedCount: tracked.unchangedCount,
      alreadyKnown: false,
    }
  }

  return {
    handleSaved,

    registerDocument({ path, subject: rawSubject }): RegisterSuccess | Failure {
      const normalized = toNfc(path)

      let subject: string | null | undefined
      if (rawSubject === null) subject = null
      else if (rawSubject !== undefined) {
        const checked = normalizeSubject(rawSubject)
        if (!checked.ok) return checked
        subject = checked.subject
      }

      const status = classifyPath(normalized)
      if (status.kind !== 'ok') {
        return { ok: false, reason: status.kind, message: status.message }
      }

      const existing = repo.findDocumentByPath(normalized)
      if (existing !== null) {
        // 같은 파일을 다시 고른 경우다. 새 문서를 만들지 않고 그대로 이어 쓴다.
        const version = repo.latestVersion(existing.id)
        const checkpoint = repo.listCheckpoints(existing.id).find((c) => c.kind === 'initial')
        if (version !== null && checkpoint !== undefined) {
          if (existing.pathLost) repo.setPathLost(existing.id, false)
          // 다시 고르며 과목을 비워 두었으면 적어 둔 과목을 지우지 않는다.
          if (subject !== undefined && subject !== null) repo.setSubject(existing.id, subject)
          const document = repo.getDocument(existing.id) ?? existing
          const saved = handleSaved(document.id)
          if (!saved.ok) return saved
          return { ok: true, document, version: saved.version, checkpoint, reused: true }
        }
      }

      const document =
        existing ??
        {
          id: newId(),
          path: normalized,
          displayName: displayNameOf(normalized),
          subject: subject ?? null,
          createdAt: now(),
          pathLost: false,
        }

      const created = initialVersionAndCheckpoint(document)
      if ('ok' in created) return created

      return {
        ok: true,
        document,
        version: created.version,
        checkpoint: created.checkpoint,
        reused: false,
      }
    },

    startWatching(documentId, listener): Promise<() => void> {
      const document = repo.getDocument(documentId)
      if (document === null) throw new Error('등록되지 않은 문서입니다.')

      const handle = (event: WatchEvent): void => {
        if (event.kind === 'path-lost') {
          repo.setPathLost(documentId, true)
          listener({ kind: 'path-lost', documentId, message: event.message })
          return
        }
        if (event.kind === 'unreadable') {
          listener({ kind: 'unreadable', documentId, message: event.message })
          return
        }

        const result = handleSaved(documentId)
        if (!result.ok) {
          listener({
            kind: 'failed',
            documentId,
            reason: result.reason,
            message: result.message,
          })
          return
        }
        listener({ kind: 'saved', ...withoutOk(result) })
      }

      /**
       * 감시 콜백 안에서 터진 예외는 삼키지 않되, 감시까지 죽이지는 않는다.
       * 조용히 사라지면 사용자는 저장이 기록된 줄 알게 된다 (`CLAUDE.md` §7).
       */
      const onEvent = (event: WatchEvent): void => {
        try {
          handle(event)
        } catch (cause) {
          listener({
            kind: 'failed',
            documentId,
            reason: 'read-failed',
            message: `저장을 기록하지 못했습니다: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          })
        }
      }

      return watcher.watch(document.path, onEvent)
    },

    markCheckpoint(documentId, label): CheckpointRow | Failure {
      // 이름은 비워도 된다. 비우면 가리키는 버전으로 이름을 붙인다 ([Q-39]).
      const trimmed = label.trim()
      if (trimmed.length > CHECKPOINT_LABEL_MAX_LENGTH) {
        return {
          ok: false,
          reason: 'invalid-label',
          message: `체크포인트 이름은 ${CHECKPOINT_LABEL_MAX_LENGTH}자까지 쓸 수 있습니다.`,
        }
      }

      // 경로 확인·읽기·버전 기록은 저장 처리와 같다. 바이트가 같으면 새 버전을 만들지 않는다.
      const current = handleSaved(documentId)
      if (!current.ok) return current
      const { document, version } = current

      const checkpointId = newId()
      const file = checkpoints.save({
        checkpointId,
        documentId: document.id,
        versionId: version.id,
        kind: 'user',
        sourcePath: document.path,
        expectedContentHash: version.contentHash,
      })

      return repo.addCheckpoint({
        id: checkpointId,
        documentId: document.id,
        versionId: version.id,
        kind: 'user',
        filePath: file.filePath,
        byteSize: file.byteSize,
        contentHash: file.contentHash,
        label: trimmed === '' ? defaultCheckpointLabel(version.ordinal) : trimmed,
        createdAt: now(),
      })
    },

    setSubject(documentId, subject): DocumentRow | Failure {
      const document = requireDocument(documentId)
      if ('ok' in document) return document

      const checked = normalizeSubject(subject)
      if (!checked.ok) return checked

      repo.setSubject(document.id, checked.subject)
      return repo.getDocument(document.id) ?? { ...document, subject: checked.subject }
    },

    reconnect(documentId, newPath): RegisterSuccess | Failure {
      const document = requireDocument(documentId)
      if ('ok' in document) return document

      const normalized = toNfc(newPath)
      const status = classifyPath(normalized)
      if (status.kind !== 'ok') {
        return { ok: false, reason: status.kind, message: status.message }
      }

      const owner = repo.findDocumentByPath(normalized)
      if (owner !== null && owner.id !== document.id) {
        return {
          ok: false,
          reason: 'already-linked',
          message: `이 파일은 이미 다른 문서(${owner.displayName})로 등록돼 있습니다.`,
        }
      }

      // 새 경로가 실제로 읽히는지 먼저 확인한다. 잘못된 파일 선택이 기존 연결을 파괴하지 않는다.
      try {
        reader.read(normalized)
      } catch (cause) {
        return readFailure(cause)
      }
      const version = repo.latestVersion(document.id)
      const checkpoint = repo.listCheckpoints(document.id).find((c) => c.kind === 'initial')
      if (version === null || checkpoint === undefined) {
        return {
          ok: false,
          reason: 'unknown-document',
          message: '이 문서의 최초본이 없습니다. 문서를 다시 등록해 주세요.',
        }
      }

      const restorePath = (): void => {
        repo.updateDocumentPath(document.id, document.path, document.displayName)
        repo.setPathLost(document.id, document.pathLost)
      }
      repo.updateDocumentPath(document.id, normalized, displayNameOf(normalized))
      try {
        const saved = handleSaved(document.id)
        if (!saved.ok) {
          restorePath()
          return saved
        }
        return { ok: true, document: saved.document, version: saved.version, checkpoint, reused: true }
      } catch (cause) {
        restorePath()
        return readFailure(cause)
      }
    },

    restoreCheckpoint(checkpointId, destinationPath, options): { ok: true; path: string } | Failure {
      const row = repo.getCheckpoint(checkpointId)
      if (row === null) {
        return { ok: false, reason: 'missing', message: '체크포인트를 찾을 수 없습니다.' }
      }

      checkpoints.restoreTo(
        { filePath: row.filePath, byteSize: row.byteSize, contentHash: row.contentHash },
        toNfc(destinationPath),
        options,
      )

      return { ok: true, path: toNfc(destinationPath) }
    },

    deleteCheckpoint(checkpointId, options): { ok: true } | Failure {
      if (!options.confirmed) throw new Error('삭제는 사용자 확인 뒤에만 실행합니다.')
      const row = repo.getCheckpoint(checkpointId)
      if (row === null) return { ok: false, reason: 'missing', message: '체크포인트를 찾을 수 없습니다.' }
      if (row.kind === 'initial') {
        return { ok: false, reason: 'protected-checkpoint', message: '최초본 체크포인트는 지울 수 없습니다.' }
      }
      // 기록을 먼저 지운다. 사본 삭제가 실패해도 목록에 남아 되살리려다 실패하는 일은 없다.
      repo.deleteCheckpoint(row.id)
      checkpoints.remove(row.filePath, options)
      return { ok: true }
    },

    deleteDocument(documentId, options): { ok: true } | Failure {
      if (!options.confirmed) throw new Error('삭제는 사용자 확인 뒤에만 실행합니다.')
      const document = requireDocument(documentId)
      if ('ok' in document) return document
      repo.deleteDocument(document.id)
      checkpoints.removeDocument(document.id, options)
      return { ok: true }
    },
  }
}

function withoutOk(result: SaveSuccess): Omit<SaveSuccess, 'ok'> {
  return {
    document: result.document,
    version: result.version,
    changed: result.changed,
    removed: result.removed,
    unchangedCount: result.unchangedCount,
    alreadyKnown: result.alreadyKnown,
  }
}
