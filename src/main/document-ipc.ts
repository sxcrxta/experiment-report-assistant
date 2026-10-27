/**
 * 문서 선택·재선택·감시의 메인 프로세스 쪽 처리.
 *
 * PRD 5절: "사용자가 직접 선택한 문서 경로만 사용하며 **전체 디스크 접근 권한을 요청하지 않는다.**"
 * 그래서 이 파일에는 권한을 요청하는 코드가 없다. 사용자가 파일 선택 창에서 고른 경로 하나를
 * 저장해 재사용하고, 접근에 실패하면 재선택을 요청한다.
 *
 * 등록한 문서는 여기서 감시를 시작한다. 감시를 시작하지 않으면 저장이 감지되지 않는다.
 * - 새로 고르거나 다시 고른 문서 → 바로 감시
 * - 앱을 켤 때 → 경로를 잃지 않은 문서를 다시 감시
 * - 경로를 잃으면 → 감시를 멈추고 알린다. 사용자가 **그 문서에 대해** 다시 고르면 같은 문서로 이어진다.
 *   비슷한 다른 파일을 임의로 이어 붙이지 않는다 (`CLAUDE.md` §3).
 *
 * 체크포인트(PRD 4.5)도 여기서 노출한다. 사용자가 지금 시점을 남기고, 남긴 시점을 **새 파일로** 되살린다.
 * 되살리기는 저장 위치 선택 → 확인 창 순서를 거친 뒤에만 실행하고, 원본이나 이미 있는 파일은 덮어쓰지 않는다.
 *
 * electron 을 import 하지 않는다. 다이얼로그와 알림 통로는 인자로 받는다. 그래야 Electron 없이 테스트할 수 있다.
 */
import { dirname, join } from 'node:path'

import {
  normalizeSubject,
  type DocumentSession,
  type FailureReason,
  type SessionEvent,
} from '../app/document-session.js'
import type { SummaryInput } from '../app/document-summary.js'
import type { Paragraph } from '../core/document/model.js'
import type { CheckpointRow, DocumentRepository, DocumentRow } from '../adapters/repo/documents.js'
import { WatchTargetError } from '../adapters/watcher/index.js'
import type {
  CheckpointSummary,
  ChooseDocumentResult,
  DeleteResult,
  DocumentEvent,
  DocumentSummary,
  DocumentWorkspaceResult,
  MarkCheckpointResult,
  ReconnectDocumentResult,
  RestoreCheckpointResult,
  SetSubjectResult,
} from '../shared/ipc.js'

export interface HwpxOpenDialogOptions {
  title: string
  buttonLabel: string
  /** 파일 하나만 고른다. 폴더 접근이나 여러 파일 선택을 요구하지 않는다 */
  properties: ['openFile']
  filters: { name: string; extensions: string[] }[]
}

const HWPX_FILTERS = [{ name: '한글 문서 (HWPX)', extensions: ['hwpx'] }]

/** 파일 선택 창 옵션. HWPX 만 고를 수 있다 (PRD 5절). */
export const HWPX_OPEN_DIALOG_OPTIONS: HwpxOpenDialogOptions = {
  title: '실험보고서 HWPX 선택',
  buttonLabel: '이 문서 감시하기',
  properties: ['openFile'],
  filters: HWPX_FILTERS,
}

/** 경로를 잃은 문서를 다시 고르는 창. 고른 파일은 새 문서가 아니라 기존 문서에 이어진다. */
export function reconnectDialogOptions(displayName: string): HwpxOpenDialogOptions {
  return {
    title: `${displayName} 의 새 위치 선택`,
    buttonLabel: '이 파일로 이어 가기',
    properties: ['openFile'],
    filters: HWPX_FILTERS,
  }
}

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface HwpxSaveDialogOptions {
  title: string
  buttonLabel: string
  /** 처음 제안할 파일 경로. 원본 옆에 다른 이름으로 둔다 */
  defaultPath: string
  filters: { name: string; extensions: string[] }[]
}

export interface SaveDialogResult {
  canceled: boolean
  /** 취소하면 빈 문자열 */
  filePath: string
}

/** 되돌리기처럼 되돌릴 수 없는 일을 하기 전에 묻는 확인 창 (`CLAUDE.md` §3). */
export interface ConfirmRequest {
  message: string
  detail: string
  confirmLabel: string
}

export interface DocumentIpcDeps {
  session: DocumentSession
  repo: DocumentRepository
  showOpenDialog: (options: HwpxOpenDialogOptions) => Promise<OpenDialogResult>
  showSaveDialog: (options: HwpxSaveDialogOptions) => Promise<SaveDialogResult>
  /** @returns 사용자가 확인을 눌렀으면 true */
  confirm: (request: ConfirmRequest) => Promise<boolean>
  /** 감시 중 일어난 일을 렌더러로 보낸다 */
  notify: (event: DocumentEvent) => void
  /**
   * 저장을 기록한 뒤 보고서 목록용 한 문단 요약을 새로 만든다 ([Q-36]).
   * 실패해도 저장 흐름을 막지 않으므로 결과를 기다리지 않는다.
   */
  refreshSummary?: (input: SummaryInput) => void
  /**
   * 등록·저장 뒤 평가 지침 **초안을 미리 채운다** ([Q-37]).
   * 이미 확정했거나 사용자가 쓴 초안이 있으면 서비스가 스스로 그만둔다.
   */
  prepareRubricDraft?: (documentId: string, paragraphs: readonly Paragraph[]) => void
}

export interface DocumentHandlers {
  /** 과목을 확인한 뒤 파일 선택 창을 연다. 과목이 비었으면 창을 열지 않는다 (PRD 4.4) */
  chooseDocument(subject: string): Promise<ChooseDocumentResult>
  setSubject(documentId: string, subject: string): SetSubjectResult
  reconnectDocument(documentId: string): Promise<ReconnectDocumentResult>
  listDocuments(): DocumentSummary[]
  getDocumentWorkspace(documentId: unknown): DocumentWorkspaceResult
  refreshDocument(documentId: unknown): DocumentWorkspaceResult
  /** 지금 시점을 사용자 지정 체크포인트로 남긴다 */
  markCheckpoint(documentId: string, label: string): MarkCheckpointResult
  /** 저장 위치를 고르게 하고, 확인을 받은 뒤 체크포인트를 새 파일로 되살린다 */
  restoreCheckpoint(checkpointId: string): Promise<RestoreCheckpointResult>
  /** 확인을 받은 뒤 사용자가 남긴 체크포인트를 지운다 */
  deleteCheckpoint(checkpointId: string): Promise<DeleteResult>
  /** 확인을 받은 뒤 감시를 멈추고 보고서의 기록을 모두 지운다. 한글 원본은 그대로 둔다 */
  deleteDocument(documentId: string): Promise<DeleteResult>
  /** 앱을 켤 때 경로를 잃지 않은 문서의 감시를 다시 시작한다 */
  resumeWatching(): Promise<void>
  /** 모든 감시를 멈춘다. 앱을 끌 때 부른다 */
  stopWatching(): void
}

/** 저장 처리 중 이 이유로 실패했다면 경로를 잃은 것이다 (`handleSaved` 가 이미 표시해 둔다). */
const PATH_LOST_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>([
  'missing',
  'icloud-not-downloaded',
  'permission-denied',
  'unsupported-format',
  'not-a-file',
])

function labelOf(checkpoint: CheckpointRow): string {
  if (checkpoint.label !== null && checkpoint.label !== '') return checkpoint.label
  return checkpoint.kind === 'initial' ? '최초본' : '이름 없는 체크포인트'
}

function summarizeCheckpoint(repo: DocumentRepository, checkpoint: CheckpointRow): CheckpointSummary {
  return {
    checkpointId: checkpoint.id,
    kind: checkpoint.kind,
    label: labelOf(checkpoint),
    versionOrdinal: repo.getVersion(checkpoint.versionId)?.ordinal ?? 0,
    createdAt: checkpoint.createdAt,
  }
}

function summarize(repo: DocumentRepository, documentId: string): DocumentSummary | null {
  const document = repo.getDocument(documentId)
  if (document === null) return null
  const versions = repo.listVersions(document.id)
  const latest = versions[versions.length - 1]
  return {
    documentId: document.id,
    displayName: document.displayName,
    path: document.path,
    subject: document.subject,
    versionCount: versions.length,
    paragraphCount: latest?.paragraphCount ?? 0,
    pathLost: document.pathLost,
    checkpoints: repo
      .listCheckpoints(document.id)
      .map((checkpoint) => summarizeCheckpoint(repo, checkpoint)),
    summary: summaryOf(repo, documentId, latest?.id ?? null),
  }
}

/**
 * 보고서 목록에 보여 줄 한 문단 요약 ([Q-36]).
 *
 * 어느 모델이 썼는지 함께 준다 — 사용자에게 보여 주기 위한 것이고, 화면이 그 값으로 갈라지지 않는다.
 * 최신 저장보다 오래된 요약은 지우지 않고 **오래되었다고 알린다** (막지 않는다).
 */
function summaryOf(
  repo: DocumentRepository, documentId: string, latestVersionId: string | null,
): DocumentSummary['summary'] {
  const row = repo.getSummary(documentId)
  if (row === null) return null
  return {
    text: row.text,
    modelId: row.modelId,
    createdAt: row.createdAt,
    stale: latestVersionId !== null && row.versionId !== latestVersionId,
  }
}

const HWPX_EXTENSION = /\.hwpx$/i

/** 파일 이름에 쓸 수 없는 문자(`/`, `:`)를 바꾼다. */
function safeFileNamePart(text: string): string {
  return text.replace(/[/:]/g, '-')
}

/**
 * 되살릴 파일의 저장 창. 원본과 같은 폴더에 **다른 이름**을 제안한다.
 * 원본 이름을 제안하지 않는 것은 실수로 원본 자리를 고르지 않게 하기 위해서다.
 */
export function restoreDialogOptions(
  document: DocumentRow,
  checkpoint: CheckpointRow,
): HwpxSaveDialogOptions {
  const stem = document.displayName.replace(HWPX_EXTENSION, '')
  const name = `${stem}-${safeFileNamePart(labelOf(checkpoint))}-복구본.hwpx`
  return {
    title: `${labelOf(checkpoint)} 을(를) 새 파일로 되살리기`,
    buttonLabel: '여기에 되살리기',
    defaultPath: join(dirname(document.path), name),
    filters: HWPX_FILTERS,
  }
}

/** 확장자 없이 이름만 적은 경우에도 HWPX 로 되살린다. */
export function withHwpxExtension(path: string): string {
  return HWPX_EXTENSION.test(path) ? path : `${path}.hwpx`
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createDocumentHandlers(deps: DocumentIpcDeps): DocumentHandlers {
  const { session, repo, notify, refreshSummary, prepareRubricDraft } = deps

  /** 문서 id → 감시를 멈추는 함수 */
  const watching = new Map<string, () => void>()
  let closed = false

  function unwatch(documentId: string): void {
    const stop = watching.get(documentId)
    if (stop === undefined) return
    watching.delete(documentId)
    stop()
  }

  function onSessionEvent(event: SessionEvent): void {
    switch (event.kind) {
      case 'saved':
        notify({
          kind: 'saved',
          documentId: event.document.id,
          versionOrdinal: event.version.ordinal,
          changedCount: event.changed.length,
          removedCount: event.removed.length,
          alreadyKnown: event.alreadyKnown,
        })
        {
          const paragraphs = repo.listParagraphs(event.version.id).map(row => row.paragraph)
          // 요약·초안은 보조 기능이다. 기다리지 않고, 실패해도 저장 기록은 그대로다.
          refreshSummary?.({
            documentId: event.document.id,
            versionId: event.version.id,
            subject: event.document.subject,
            paragraphs,
          })
          prepareRubricDraft?.(event.document.id, paragraphs)
        }
        return
      case 'path-lost':
        // 감시자는 이미 스스로 멈췄다. 목록에서만 뺀다.
        watching.delete(event.documentId)
        notify({ kind: 'path-lost', documentId: event.documentId, message: event.message })
        return
      case 'unreadable':
        notify({ kind: 'failed', documentId: event.documentId, message: event.message })
        return
      case 'failed':
        if (PATH_LOST_REASONS.has(event.reason)) {
          unwatch(event.documentId)
          notify({ kind: 'path-lost', documentId: event.documentId, message: event.message })
          return
        }
        notify({ kind: 'failed', documentId: event.documentId, message: event.message })
        return
    }
  }

  /**
   * 감시를 (다시) 시작한다. 이미 감시 중이면 그 감시를 멈추고 새로 건다.
   * 시작하지 못하면 조용히 넘어가지 않고 알린다 (`CLAUDE.md` §7).
   */
  async function watch(documentId: string): Promise<void> {
    unwatch(documentId)

    let stop: () => void
    try {
      stop = await session.startWatching(documentId, onSessionEvent)
    } catch (cause) {
      if (cause instanceof WatchTargetError) {
        repo.setPathLost(documentId, true)
        notify({ kind: 'path-lost', documentId, message: cause.message })
        return
      }
      notify({
        kind: 'failed',
        documentId,
        message: `문서 감시를 시작하지 못했습니다: ${messageOf(cause)}`,
      })
      return
    }

    // 기다리는 사이 앱이 닫혔거나 같은 문서의 감시가 새로 걸렸을 수 있다.
    if (closed) {
      stop()
      return
    }
    unwatch(documentId)
    watching.set(documentId, stop)
  }

  function getDocumentWorkspace(documentId: unknown): DocumentWorkspaceResult {
    if (typeof documentId !== 'string') return { status: 'failed', message: '문서를 선택해 주세요.' }
    const document = summarize(repo, documentId)
    if (document === null) return { status: 'failed', message: '등록되지 않은 문서입니다.' }
    const versions = repo.listVersions(documentId)
    const latest = versions.at(-1)
    const changes = new Set(latest === undefined ? [] : repo.listDiffEntries(latest.id)
      .filter((entry) => entry.change !== 'deleted').map((entry) => entry.paragraphUuid))
    return { status: 'ok', workspace: {
      document,
      paragraphs: latest === undefined ? [] : repo.listParagraphs(latest.id).map(({ uuid, paragraph }, index) => ({
        paragraphId: uuid, number: index + 1, text: paragraph.text, equations: paragraph.equations,
        tableNumber: paragraph.table === null ? null : paragraph.table.tableIndex + 1,
        changed: changes.has(uuid),
      })),
      versions: versions.map((version) => {
        const entries = repo.listDiffEntries(version.id)
        return { versionId: version.id, ordinal: version.ordinal, detectedAt: version.detectedAt,
          paragraphCount: version.paragraphCount,
          changedCount: entries.filter((entry) => entry.change !== 'deleted').length,
          removedCount: entries.filter((entry) => entry.change === 'deleted').length }
      }).reverse(),
    } }
  }

  return {
    getDocumentWorkspace,
    refreshDocument(documentId): DocumentWorkspaceResult {
      if (typeof documentId !== 'string') return { status: 'failed', message: '문서를 선택해 주세요.' }
      const document = repo.getDocument(documentId)
      if (document === null) return { status: 'failed', message: '등록되지 않은 문서입니다.' }
      if (document.pathLost) return { status: 'failed', message: '파일의 새 위치를 먼저 선택해 주세요.' }
      const saved = session.handleSaved(documentId)
      if (!saved.ok) {
        onSessionEvent({ kind: 'failed', documentId, reason: saved.reason, message: saved.message })
        return { status: 'failed', message: saved.message }
      }
      onSessionEvent({ kind: 'saved', ...saved })
      return getDocumentWorkspace(documentId)
    },
    async chooseDocument(subject: string): Promise<ChooseDocumentResult> {
      // 과목은 등록할 때 묻되 비워도 된다 ([Q-52]). 파일을 고른 뒤에 과목 때문에 실패하지 않도록 먼저 본다.
      const checked = normalizeSubject(subject)
      if (!checked.ok) return { status: 'failed', message: checked.message }

      const picked = await deps.showOpenDialog(HWPX_OPEN_DIALOG_OPTIONS)
      const path = picked.filePaths[0]
      if (picked.canceled || path === undefined) return { status: 'canceled' }

      const result = session.registerDocument({ path, subject: checked.subject })
      if (!result.ok) return { status: 'failed', message: result.message }

      await watch(result.document.id)

      const summary = summarize(repo, result.document.id)
      if (summary === null) {
        return { status: 'failed', message: '문서를 저장한 뒤 다시 읽지 못했습니다.' }
      }
      return { status: 'registered', document: summary }
    },

    async reconnectDocument(documentId: string): Promise<ReconnectDocumentResult> {
      const document = repo.getDocument(documentId)
      if (document === null) return { status: 'failed', message: '등록되지 않은 문서입니다.' }

      const picked = await deps.showOpenDialog(reconnectDialogOptions(document.displayName))
      const path = picked.filePaths[0]
      if (picked.canceled || path === undefined) return { status: 'canceled' }

      const result = session.reconnect(document.id, path)
      if (!result.ok) return { status: 'failed', message: result.message }

      await watch(document.id)

      const summary = summarize(repo, document.id)
      if (summary === null) return { status: 'failed', message: '등록되지 않은 문서입니다.' }
      return { status: 'reconnected', document: summary }
    },

    setSubject(documentId: string, subject: string): SetSubjectResult {
      const result = session.setSubject(documentId, subject)
      if ('ok' in result) return { status: 'failed', message: result.message }

      const summary = summarize(repo, documentId)
      if (summary === null) return { status: 'failed', message: '등록되지 않은 문서입니다.' }
      return { status: 'saved', document: summary }
    },

    listDocuments(): DocumentSummary[] {
      return repo
        .listDocuments()
        .map((document) => summarize(repo, document.id))
        .filter((summary): summary is DocumentSummary => summary !== null)
    },

    markCheckpoint(documentId: string, label: string): MarkCheckpointResult {
      let marked
      try {
        marked = session.markCheckpoint(documentId, label)
      } catch (cause) {
        // 복사 실패, 복사 중 다시 저장됨 등. 체크포인트는 기록되지 않았다.
        return { status: 'failed', message: `체크포인트를 남기지 못했습니다: ${messageOf(cause)}` }
      }
      if ('ok' in marked) {
        if (PATH_LOST_REASONS.has(marked.reason)) {
          // 저장 처리와 같은 이유로 실패했다. 경로를 잃은 것이므로 감시도 멈춘다.
          unwatch(documentId)
          notify({ kind: 'path-lost', documentId, message: marked.message })
        }
        return { status: 'failed', message: marked.message }
      }

      const summary = summarize(repo, documentId)
      if (summary === null) return { status: 'failed', message: '등록되지 않은 문서입니다.' }
      return { status: 'marked', checkpoint: summarizeCheckpoint(repo, marked), document: summary }
    },

    async restoreCheckpoint(checkpointId: string): Promise<RestoreCheckpointResult> {
      const checkpoint = repo.getCheckpoint(checkpointId)
      if (checkpoint === null) return { status: 'failed', message: '체크포인트를 찾을 수 없습니다.' }
      const document = repo.getDocument(checkpoint.documentId)
      if (document === null) return { status: 'failed', message: '등록되지 않은 문서입니다.' }

      const picked = await deps.showSaveDialog(restoreDialogOptions(document, checkpoint))
      if (picked.canceled || picked.filePath === '') return { status: 'canceled' }
      const destination = withHwpxExtension(picked.filePath)

      const confirmed = await deps.confirm({
        message: `${labelOf(checkpoint)} 시점의 문서를 새 파일로 되살릴까요?`,
        detail:
          `저장 위치: ${destination}\n` +
          '지금 쓰고 있는 문서는 바뀌지 않습니다. 이미 있는 파일은 덮어쓰지 않습니다.',
        confirmLabel: '되살리기',
      })
      if (!confirmed) return { status: 'canceled' }

      try {
        const restored = session.restoreCheckpoint(checkpoint.id, destination, { confirmed })
        if (!restored.ok) return { status: 'failed', message: restored.message }
        return { status: 'restored', path: restored.path }
      } catch (cause) {
        return { status: 'failed', message: `되살리지 못했습니다: ${messageOf(cause)}` }
      }
    },

    async deleteCheckpoint(checkpointId: string): Promise<DeleteResult> {
      const checkpoint = repo.getCheckpoint(checkpointId)
      if (checkpoint === null) return { status: 'failed', message: '체크포인트를 찾을 수 없습니다.' }
      if (checkpoint.kind === 'initial') return { status: 'failed', message: '최초본 체크포인트는 지울 수 없습니다.' }
      const confirmed = await deps.confirm({
        message: `'${labelOf(checkpoint)}' 체크포인트를 지울까요?`,
        detail: '보관한 사본도 함께 지워지며 되돌릴 수 없습니다. 한글 원본은 바뀌지 않습니다.',
        confirmLabel: '삭제',
      })
      if (!confirmed) return { status: 'canceled' }
      try {
        const result = session.deleteCheckpoint(checkpoint.id, { confirmed })
        return result.ok ? { status: 'deleted' } : { status: 'failed', message: result.message }
      } catch (cause) {
        return { status: 'failed', message: `체크포인트를 지우지 못했습니다: ${messageOf(cause)}` }
      }
    },

    async deleteDocument(documentId: string): Promise<DeleteResult> {
      const document = repo.getDocument(documentId)
      if (document === null) return { status: 'failed', message: '등록되지 않은 문서입니다.' }
      const confirmed = await deps.confirm({
        message: `'${document.displayName.replace(HWPX_EXTENSION, '')}' 을(를) 삭제할까요?`,
        detail: '이 앱에 쌓인 버전·피드백·내 판단·자기평가·체크포인트가 모두 지워지며 되돌릴 수 없습니다.\n'
          + '한글 원본 파일은 그대로 남습니다.',
        confirmLabel: '삭제',
      })
      if (!confirmed) return { status: 'canceled' }
      // 감시를 먼저 멈춘다. 지우는 사이 저장 이벤트가 와서 기록을 다시 만들지 않게 한다.
      unwatch(document.id)
      try {
        const result = session.deleteDocument(document.id, { confirmed })
        return result.ok ? { status: 'deleted' } : { status: 'failed', message: result.message }
      } catch (cause) {
        return { status: 'failed', message: `보고서를 삭제하지 못했습니다: ${messageOf(cause)}` }
      }
    },

    async resumeWatching(): Promise<void> {
      // 경로를 잃은 문서는 사용자가 다시 고를 때까지 감시하지 않는다.
      const targets = repo.listDocuments().filter((document) => !document.pathLost)
      for (const document of targets) {
        await watch(document.id)
        // 앱이 꺼진 동안 저장한 변경은 새 파일 이벤트가 오지 않는다. 시작 시 최신본을 동기화한다.
        if (!watching.has(document.id)) continue
        try {
          const saved = session.handleSaved(document.id)
          if (saved.ok) onSessionEvent({ kind: 'saved', ...saved })
          else onSessionEvent({ kind: 'failed', documentId: document.id, reason: saved.reason, message: saved.message })
        } catch (cause) {
          notify({ kind: 'failed', documentId: document.id, message: `문서를 동기화하지 못했습니다: ${messageOf(cause)}` })
        }
      }
    },

    stopWatching(): void {
      closed = true
      for (const documentId of [...watching.keys()]) unwatch(documentId)
    },
  }
}
