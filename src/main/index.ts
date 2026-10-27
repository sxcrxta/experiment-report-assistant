/**
 * Electron 메인 프로세스.
 *
 * PRD 5절: macOS 에서 동작하는 개인 사용 데스크톱 프로그램.
 * CLAUDE.md §7: 렌더러에 파일·네트워크 접근을 주지 않는다. 외부 세계는 여기서만 다룬다.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { BrowserWindow, app, dialog, ipcMain, net, screen, type Rectangle } from 'electron'

import { createCheckpointStore, sha256File } from '../adapters/checkpoint/index.js'
import { hwpxReader } from '../adapters/hwpx/index.js'
import { createClaudeCode } from '../adapters/model/claude-code.js'
import { createClaudeCliLocator } from '../adapters/model/claude-path.js'
import type { ReviewModelSet } from '../adapters/model/index.js'
import { createOpenRouterGemma, fetchTransport } from '../adapters/model/openrouter-gemma.js'
import { createOnlineStatus } from '../adapters/net/online.js'
import { openDatabase } from '../adapters/repo/index.js'
import { createSettingsRepository, SETTING_KEYS } from '../adapters/repo/settings.js'
import { createAnchorRepository } from '../adapters/repo/anchors.js'
import { createReviewCacheRepository } from '../adapters/repo/cache.js'
import { createDocumentRepository } from '../adapters/repo/documents.js'
import { createReviewRepository } from '../adapters/repo/reviews.js'
import { createOutlineRepository } from '../adapters/repo/outline.js'
import { createOutlineService } from '../app/document-outline.js'
import { createReviewContextRepository } from '../adapters/repo/review-context.js'
import { createReviewContextService } from '../app/review-context.js'
import { createDocumentCheckRepository } from '../adapters/repo/document-check.js'
import { createDocumentCheckService, type CheckView } from '../app/document-check.js'

/** 렌더러로 보낼 점검 결과. 내부 식별자(버전·지침 id)는 보내지 않는다 */
function toCheckView(view: CheckView): DocumentCheckView {
  return {
    overall: view.overall, createdAt: view.createdAt, modelId: view.modelId, documentChanged: view.documentChanged,
    checklistChanged: view.checklistChanged,
    results: view.results.map(({ title, score, status, evidence, paragraphNumbers }) =>
      ({ title, score: score ?? 0, status, evidence, paragraphNumbers })),
  }
}
import { createRubricRepository } from '../adapters/repo/rubric.js'
import { createRubricLibraryRepository } from '../adapters/repo/rubric-library.js'
import { createPersonalizationRepository } from '../adapters/repo/personalization.js'
import { createPersonalizationService } from '../app/personalization.js'
import { createPersonalizationHandlers, type PersonalizationHandlers } from './personalization-ipc.js'
import { createKeychainSecretStore } from '../adapters/secret/keychain.js'
import { createFileWatcher } from '../adapters/watcher/index.js'
import { createDocumentSummaryService } from '../app/document-summary.js'
import { createDocumentSession } from '../app/document-session.js'
import { createReviewService } from '../app/review-request.js'
import { createStagedReviewService } from '../app/review-stage.js'
import { createRubricService } from '../app/rubric.js'
import { createRubricLibraryService } from '../app/rubric-library.js'
import { createModelRubricSuggester } from '../app/rubric-suggest.js'
import { firstRunGuide } from '../app/first-run.js'
import type { FirstRunGuide } from '../shared/first-run.js'
import type { DocumentPreviewResult } from '../shared/document-preview.js'
import {
  CHANNELS,
  type AiSettingsResult,
  type CancelDeepReviewResult,
  type ClaudeModeResult,
  type ReReviewResultView,
  type AiSettingsView,
  type AppInfo,
  type ConfirmRubricResult,
  type DecideSentenceAnchorResult,
  type DeleteResult,
  type PolishResult,
  type AnalyzeOutlineResult,
  type SetDocumentKindResult,
  type RunCheckResult,
  type GetCheckResult,
  type DocumentCheckView,
  type DeleteOpenRouterKeyResult,
  type DiscardRubricDraftResult,
  type DocumentEvent,
  type MarkCheckpointResult,
  type RestoreCheckpointResult,
  type ReviewPanelResult,
  type RubricEditorResult,
  type SaveOpenRouterKeyResult,
  type SaveSectionBoundariesResult,
  type SetSubjectResult,
  type StagedReviewResultView,
  type SuggestRubricDraftResult,
} from '../shared/ipc.js'

import {
  createDocumentHandlers,
  type ConfirmRequest,
  type DocumentHandlers,
} from './document-ipc.js'
import { createDocumentImageReader, createPreviewHandler } from './preview-ipc.js'
import { createReviewHandlers, type ReviewHandlers } from './review-ipc.js'
import { createPolishHandler } from './polish-ipc.js'
import { COMPACT_MIN, NORMAL_MIN, compactBounds } from './window-mode.js'
import { createPolishService } from '../app/polish.js'
import { createRubricHandlers, type RubricHandlers } from './rubric-ipc.js'
import { createRubricLibraryHandlers, type RubricLibraryHandlers } from './rubric-library-ipc.js'
import { createSettingsHandlers, type SettingsHandlers } from './settings-ipc.js'

/**
 * 로컬 데이터 폴더의 이름. `~/Library/Application Support/<이것>/` 이 된다.
 *
 * **.app 으로 묶어도 이 이름이 바뀌면 안 된다.** Electron 은 기본적으로 앱 이름으로 이 경로를 정하는데,
 * 배포용 이름을 한국어로 붙이면 폴더가 따라 바뀌어 **기존 기록을 못 찾는다.**
 * 그래서 이름과 무관하게 여기서 못박는다. `docs/사용법.md` 2절이 약속한 경로이기도 하다.
 * 키체인 항목 이름(`KEYCHAIN_SERVICE`)도 같은 값이다.
 */
const DATA_DIR_NAME = 'experiment-agent'

/** 데이터·로그 경로를 앱 이름과 무관하게 고정한다. 무엇이든 쓰기 전에 한 번만 부른다. */
function pinUserPaths(): void {
  app.setPath('userData', join(app.getPath('appData'), DATA_DIR_NAME))
  app.setPath('logs', join(app.getPath('home'), 'Library', 'Logs', DATA_DIR_NAME))
}

function assertMacOS(): boolean {
  if (process.platform === 'darwin') return true
  dialog.showErrorBox(
    '지원하지 않는 운영체제',
    '이 프로그램은 macOS 전용입니다. 한글 for Mac 이 저장한 HWPX 만 다룹니다.',
  )
  return false
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: NORMAL_MIN.width,
    minHeight: NORMAL_MIN.height,
    show: false,
    title: '실험보고서 학습 보조',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/**
 * 마이그레이션 .sql 이 있는 폴더를 찾는다.
 * 개인 사용이라 소스에서 실행하는 것을 전제로 하되, 위치를 하드코딩하지 않고 후보를 확인한다.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    join(app.getAppPath(), 'src', 'adapters', 'repo', 'migrations'),
    join(app.getAppPath(), 'out', 'main', 'migrations'),
    join(__dirname, 'migrations'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (found === undefined) {
    throw new Error(
      `마이그레이션 폴더를 찾지 못했습니다. 확인한 위치:\n${candidates.join('\n')}`,
    )
  }
  return found
}

/**
 * SQLite 를 **처음 쓸 때** 한 번만 연다. 저장소와 설정(지정한 Claude Code 경로)이 같은 연결을 쓴다.
 * 여는 데 실패하면 그 기능에서 실패로 드러난다. 앱 시작을 막지 않는다.
 */
function createDatabaseLazily(): () => Database.Database {
  let db: Database.Database | null = null
  return () => {
    if (db === null) {
      db = openDatabase({
        file: join(app.getPath('userData'), 'data.sqlite'),
        migrationsDir: resolveMigrationsDir(),
      }).db
    }
    return db
  }
}

/** 감시 중 일어난 일을 열린 창 모두에 알린다. */
function broadcast(event: DocumentEvent): void {
  if (event.kind !== 'saved' && event.kind !== 'summary') {
    console.warn(`[document:event] ${event.kind}`, event.message)
  }
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(CHANNELS.documentEvent, event)
  }
}

/** 되돌릴 수 없는 일을 하기 전에 묻는다. 기본 선택은 '취소'다. */
async function confirmWithDialog({ message, detail, confirmLabel }: ConfirmRequest): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message,
    detail,
    buttons: [confirmLabel, '취소'],
    defaultId: 1,
    cancelId: 1,
  })
  return response === 0
}

interface Handlers {
  /** 제출 점검 ([Q-48]) */
  check: ReturnType<typeof createDocumentCheckService>
  personalization: PersonalizationHandlers
  documents: DocumentHandlers
  rubric: RubricHandlers
  rubricLibrary: RubricLibraryHandlers
  review: ReviewHandlers
}

/** 외부 세계(키체인·네트워크·모델)는 한 번만 만들어 설정 화면과 검토 요청이 함께 쓴다. */
interface ModelSide {
  secrets: ReturnType<typeof createKeychainSecretStore>
  online: ReturnType<typeof createOnlineStatus>
  /**
   * **어댑터를 고르는 지점은 이 한 곳뿐이다** ([Q-30], `STAGE_TASKS.md` 7단계).
   * 사용자가 고른 깊이에 어느 어댑터가 붙는지는 여기서만 정해지고, 코어·앱·화면은 모른다.
   */
  models: ReviewModelSet
  deep: ReturnType<typeof createClaudeCode>
  locator: ReturnType<typeof createClaudeCliLocator>
  /** 사용자가 직접 지정한 Claude Code 경로를 읽고 쓴다. DB 를 열지 못하면 조용히 없는 셈이 된다 */
  claudePath: { read(): string | null; write(path: string): void; clear(): void }
}

function createModelSideLazily(db: () => Database.Database): () => ModelSide {
  let side: ModelSide | null = null

  /** 경로 설정은 DB 에 있다. DB 를 열지 못해도 감지와 빠른 검토는 그대로 돌아야 한다. */
  let settings: ReturnType<typeof createSettingsRepository> | null = null
  const settingsRepo = (): ReturnType<typeof createSettingsRepository> => {
    // 문장을 매번 새로 준비하지 않는다. 경로는 검토를 부를 때마다 읽힌다.
    settings ??= createSettingsRepository(db())
    return settings
  }
  const claudePath = {
    read(): string | null {
      try {
        return settingsRepo().get(SETTING_KEYS.claudeCliPath)
      } catch (cause) {
        console.warn('[settings] 지정한 Claude Code 경로를 읽지 못했습니다', cause)
        return null
      }
    },
    write(path: string): void {
      settingsRepo().set(SETTING_KEYS.claudeCliPath, path, new Date().toISOString())
    },
    clear(): void {
      settingsRepo().clear(SETTING_KEYS.claudeCliPath)
    },
  }

  return () => {
    if (side !== null) return side
    const secrets = createKeychainSecretStore()
    const locator = createClaudeCliLocator({ overridePath: () => claudePath.read() })
    const quick = createOpenRouterGemma({ secrets, transport: fetchTransport })
    const deep = createClaudeCode({ locator })
    side = {
      secrets,
      online: createOnlineStatus(() => net.isOnline()),
      models: { quick, deep },
      deep,
      locator,
      claudePath,
    }
    return side
  }
}

/**
 * 저장소와 유스케이스는 **처음 쓸 때** 만든다.
 * 창을 띄우는 것과 무관하게 실패할 수 있으므로, 실패를 앱 시작이 아니라 그 기능에서 알린다.
 */
function createSessionLazily(modelSide: () => ModelSide, openDb: () => Database.Database): () => Handlers {
  let handlers: Handlers | null = null

  return () => {
    if (handlers !== null) return handlers

    const userData = app.getPath('userData')
    const db = openDb()
    const repo = createDocumentRepository(db)
    const now = (): string => new Date().toISOString()
    const newId = (): string => randomUUID()
    const session = createDocumentSession({
      repo,
      reader: hwpxReader,
      watcher: createFileWatcher(),
      checkpoints: createCheckpointStore(join(userData, 'checkpoints')),
      hashFile: sha256File,
      fileSize: (path) => statSync(path).size,
      now,
      newId,
    })
    const { online, models } = modelSide()
    // 지침 초안 제안은 보조 기능이라 빠른 검토 쪽 어댑터를 쓴다 (PRD 4.1·4.3).
    const model = models.quick
    const rubric = createRubricService({
      documents: repo,
      rubrics: createRubricRepository(db),
      // 문서 뼈대(제목·표 설명·안내 문구)만 모델에 보내 초안을 받는다. 본문은 보내지 않는다.
      suggester: createModelRubricSuggester({ documents: repo, model, online }),
      now,
      newId,
    })

    // 지침 모음 ([Q-40]). 보고서 쪽 확정도 이것을 지나 "따라가는지" 가 함께 갱신된다.
    const rubricLibrary = createRubricLibraryService({
      library: createRubricLibraryRepository(db), rubric, documents: repo, now, newId,
    })

    const reviews = createReviewRepository(db)
    const cache = createReviewCacheRepository(db)
    const anchors = createAnchorRepository(db)
    const personalRepo = createPersonalizationRepository(db)
    const personalization = createPersonalizationService({documents:repo,reviews,repo:personalRepo,models,online,now,newId})
    // 검토와 함께 보낼 보고서의 그림 ([Q-38]). 파일을 읽는 일은 메인 프로세스만 한다.
    const documentImages = createDocumentImageReader(repo)
    // 보고서 목록에 보여 줄 한 문단 요약 ([Q-36]). 저장을 기록한 뒤에 만든다.
    const summaries = createDocumentSummaryService({ repo, models, isOnline: () => online.isOnline(), now })
    // 검토 맥락 ([Q-48]): 검토·다듬기는 평가 지침 대신 문서 종류를 참고한다.
    const reviewContext = createReviewContextService({ repo: createReviewContextRepository(db), now })
    // 보고서 목차 ([Q-47]). AI 가 제목을 제안하고 범위는 프로그램이 정한다. 문서 종류도 함께 짐작한다.
    const outline = createOutlineService({ documents: repo, outlines: createOutlineRepository(db), models, online, now,
      onKind: (documentId, kind, modelId) => reviewContext.saveGuess(documentId, kind, modelId) })
    const review = createReviewService({
      approvedGuidelines: personalization.approvedGuidelines,
      documents: repo,
      context: reviewContext,
      reviews,
      cache,
      models,
      online,
      documentImages,
      now,
      newId,
    })

    // 제출 점검 ([Q-48]). 평가 지침(점검표)과 문서를 AI 가 대조한다. 누를 때만 부른다.
    const check = createDocumentCheckService({ documents: repo, rubric, checks: createDocumentCheckRepository(db),
      models, online, kindOf: (documentId) => reviewContext.kindOf(documentId), now,
      outlineOf: (documentId, paragraphs) => outline.view(documentId, paragraphs).nodes })

    handlers = {
      check,
      personalization: createPersonalizationHandlers({service:personalization,documents:repo,repo:personalRepo,
        confirm:(message,detail)=>confirmWithDialog({message,detail,confirmLabel:message==='개인화 지침 승인'?'승인하고 적용':'삭제'})}),
      documents: createDocumentHandlers({
        session,
        repo,
        showOpenDialog: (options) => dialog.showOpenDialog(options),
        showSaveDialog: (options) => dialog.showSaveDialog(options),
        confirm: confirmWithDialog,
        notify: broadcast,
        refreshSummary: (input) => {
          void summaries.refresh(input).then(() => {
            // 요약이 늦게 도착하므로 목록을 다시 읽으라고 알린다.
            broadcast({ kind: 'summary', documentId: input.documentId })
          })
        },
        // 지침을 빈칸부터 쓰게 하지 않는다 ([Q-37]). 확정은 여전히 사용자가 한다.
        prepareRubricDraft: (documentId, paragraphs) => {
          void rubric.prepareDraft(documentId, paragraphs).then(() => {
            broadcast({ kind: 'summary', documentId })
          })
        },
      }),
      rubric: createRubricHandlers({ rubric, library: rubricLibrary, confirm: confirmWithDialog }),
      rubricLibrary: createRubricLibraryHandlers({ library: rubricLibrary, confirm: confirmWithDialog }),
      review: createReviewHandlers({
        confirm: confirmWithDialog,
        outline,
        setDocumentKind: (documentId, kind) => reviewContext.setKind(documentId, kind),
        staged: createStagedReviewService({
          repeatedObservation: card => personalization.repeatedObservation(card),
          outline: (documentId, paragraphs) => outline.view(documentId, paragraphs),
          profile: (documentId) => {
            const saved = reviewContext.profile(documentId)
            return saved === null ? null : { kind: saved.kind, source: saved.source }
          },
          preserveFeedback: id => personalRepo.reactions().some(r=>r.feedbackId===id),
          // 심층 재검토에 사용자의 판단을 함께 싣는다 (PRD 4.4).
          userReaction: id => {
            const saved = personalRepo.reactions().find(r=>r.feedbackId===id)
            return saved === undefined ? null : { kind: saved.kind, reason: saved.reason }
          },
          documents: repo,
          reviews,
          anchors,
          rubric,
          review,
          now,
          newId,
        }),
      }),
    }
    return handlers
  }
}

/**
 * AI 검토 설정은 저장소와 따로 만든다. DB 를 열지 못해도 키 등록과 상태 안내는 된다.
 * 키는 키체인에만 두고, 온라인 여부는 Electron 의 `net.isOnline()` 으로 본다.
 */
function createSettingsLazily(modelSide: () => ModelSide): () => SettingsHandlers {
  let handlers: SettingsHandlers | null = null

  return () => {
    if (handlers !== null) return handlers
    const { secrets, online, models, locator, claudePath } = modelSide()
    handlers = createSettingsHandlers({
      secrets,
      online,
      models,
      claude: {
        status: () => locator.status(),
        recheck: () => {
          locator.forget()
          return locator.status()
        },
        setPath: (path) => claudePath.write(path),
        clearPath: () => claudePath.clear(),
      },
      confirm: confirmWithDialog,
    })
    return handlers
  }
}

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

/** AI 검토 설정 (4단계). 키 값은 어떤 로그에도 남기지 않는다. */
function registerSettingsIpc(handlers: () => SettingsHandlers): void {
  ipcMain.handle(CHANNELS.getAiSettings, async (): Promise<AiSettingsResult> => {
    try {
      return await handlers().getAiSettings()
    } catch (cause) {
      console.error('[settings:get-ai] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, 'AI 검토 설정을 읽지 못했습니다.') }
    }
  })

  ipcMain.handle(
    CHANNELS.saveOpenRouterKey,
    async (_event, key: unknown): Promise<SaveOpenRouterKeyResult> => {
      try {
        const result = await handlers().saveOpenRouterKey(key)
        if (result.status === 'failed') console.warn('[settings:save-openrouter-key] 실패', result.message)
        return result
      } catch (cause) {
        console.error('[settings:save-openrouter-key] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '키를 등록하지 못했습니다.') }
      }
    },
  )

  ipcMain.handle(CHANNELS.recheckClaudeMode, async (): Promise<ClaudeModeResult> => {
    try {
      return await handlers().recheckClaudeMode()
    } catch (cause) {
      console.error('[settings:recheck-claude] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, 'Claude Code 를 확인하지 못했습니다.') }
    }
  })

  ipcMain.handle(CHANNELS.saveClaudeCliPath, async (_event, path: unknown): Promise<ClaudeModeResult> => {
    try {
      const result = await handlers().saveClaudeCliPath(path)
      if (result.status === 'failed') console.warn('[settings:save-claude-path] 실패', result.message)
      return result
    } catch (cause) {
      console.error('[settings:save-claude-path] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '경로를 저장하지 못했습니다.') }
    }
  })

  ipcMain.handle(CHANNELS.clearClaudeCliPath, async (): Promise<ClaudeModeResult> => {
    try {
      return await handlers().clearClaudeCliPath()
    } catch (cause) {
      console.error('[settings:clear-claude-path] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '지정한 경로를 지우지 못했습니다.') }
    }
  })

  ipcMain.handle(CHANNELS.deleteOpenRouterKey, async (): Promise<DeleteOpenRouterKeyResult> => {
    try {
      const result = await handlers().deleteOpenRouterKey()
      if (result.status === 'failed') console.warn('[settings:delete-openrouter-key] 실패', result.message)
      return result
    } catch (cause) {
      console.error('[settings:delete-openrouter-key] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '키를 지우지 못했습니다.') }
    }
  })
}

/** 평가 지침 편집 (3단계). 렌더러가 보낸 값의 형태 확인은 핸들러가 한다. */
function registerRubricIpc(handlers: () => Handlers): void {
  ipcMain.handle(
    CHANNELS.setSubject,
    (_event, documentId: unknown, subject: unknown): SetSubjectResult => {
      if (typeof documentId !== 'string' || typeof subject !== 'string') {
        return { status: 'failed', message: '과목을 저장할 문서를 알 수 없습니다.' }
      }
      try {
        return handlers().documents.setSubject(documentId, subject)
      } catch (cause) {
        console.error('[document:set-subject] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '과목을 저장하지 못했습니다.') }
      }
    },
  )

  ipcMain.handle(CHANNELS.getRubric, (_event, documentId: unknown): RubricEditorResult => {
    try {
      return handlers().rubric.getRubric(documentId)
    } catch (cause) {
      console.error('[rubric:get] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '평가 지침을 읽지 못했습니다.') }
    }
  })

  ipcMain.handle(
    CHANNELS.saveRubricDraft,
    (_event, documentId: unknown, items: unknown): RubricEditorResult => {
      try {
        return handlers().rubric.saveRubricDraft(documentId, items)
      } catch (cause) {
        console.error('[rubric:save-draft] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '초안을 저장하지 못했습니다.') }
      }
    },
  )

  ipcMain.handle(
    CHANNELS.confirmRubric,
    (_event, documentId: unknown, items: unknown): ConfirmRubricResult => {
      try {
        return handlers().rubric.confirmRubric(documentId, items)
      } catch (cause) {
        console.error('[rubric:confirm] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '지침을 확정하지 못했습니다.') }
      }
    },
  )

  ipcMain.handle(
    CHANNELS.discardRubricDraft,
    async (_event, documentId: unknown): Promise<DiscardRubricDraftResult> => {
      try {
        return await handlers().rubric.discardRubricDraft(documentId)
      } catch (cause) {
        console.error('[rubric:discard-draft] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '초안을 버리지 못했습니다.') }
      }
    },
  )

  // 지침 모음 ([Q-40]). 실패는 삼키지 않고 로그와 사용자 문구로 드러낸다 (CLAUDE.md §7).
  const library = <A extends unknown[], R>(channel: string, fallback: string,
    run: (h: RubricLibraryHandlers, ...args: A) => R | Promise<R>) => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await run(handlers().rubricLibrary, ...(args as A))
      } catch (cause) {
        console.error(`[${channel}] 실패`, cause)
        return { status: 'failed', message: failureMessage(cause, fallback) }
      }
    })
  }
  library(CHANNELS.listRubricTemplates, '평가 지침 모음을 읽지 못했습니다.',
    (h, query: unknown) => h.listRubricTemplates(query))
  library(CHANNELS.createRubricTemplate, '지침을 모음에 만들지 못했습니다.',
    (h, name: unknown, items: unknown) => h.createRubricTemplate(name, items))
  library(CHANNELS.updateRubricTemplate, '지침을 저장하지 못했습니다.',
    (h, id: unknown, name: unknown, items: unknown) => h.updateRubricTemplate(id, name, items))
  library(CHANNELS.deleteRubricTemplate, '지침을 지우지 못했습니다.',
    (h, id: unknown) => h.deleteRubricTemplate(id))
  library(CHANNELS.applyRubricTemplate, '지침을 적용하지 못했습니다.',
    (h, documentId: unknown, templateId: unknown) => h.applyRubricTemplate(documentId, templateId))
  library(CHANNELS.saveDocumentRubricToLibrary, '지침을 모음에 저장하지 못했습니다.',
    (h, documentId: unknown, name: unknown) => h.saveDocumentRubricToLibrary(documentId, name))

  ipcMain.handle(
    CHANNELS.suggestRubricDraft,
    async (_event, documentId: unknown): Promise<SuggestRubricDraftResult> => {
      try {
        return await handlers().rubric.suggestRubricDraft(documentId)
      } catch (cause) {
        console.error('[rubric:suggest] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '초안을 제안받지 못했습니다.') }
      }
    },
  )
}

/** 선택적 피드백 (5단계). 범위·관점·단계 판정과 단계 순서 강제는 유스케이스가 한다. */
function registerReviewIpc(handlers: () => Handlers): void {
  ipcMain.handle(
    CHANNELS.getReviewPanel,
    async (_event, documentId: unknown, includeAll: unknown): Promise<ReviewPanelResult> => {
      try {
        return await handlers().review.getReviewPanel(documentId, includeAll)
      } catch (cause) {
        console.error('[review:panel] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '검토 화면을 열지 못했습니다.') }
      }
    },
  )

  ipcMain.handle(
    CHANNELS.requestStagedReview,
    async (_event, input: unknown): Promise<StagedReviewResultView> => {
      try {
        const result = await handlers().review.requestStagedReview(input)
        if (result.status === 'failed') console.warn('[review:request] 실패', result.message)
        return result
      } catch (cause) {
        console.error('[review:request] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '검토를 요청하지 못했습니다.') }
      }
    },
  )

  ipcMain.handle(
    CHANNELS.requestReReview,
    async (_event, documentId: unknown, feedbackId: unknown): Promise<ReReviewResultView> => {
      try {
        const result = await handlers().review.requestReReview(documentId, feedbackId)
        if (result.status === 'failed') console.warn('[review:re-review] 실패', result.message)
        return result
      } catch (cause) {
        console.error('[review:re-review] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '심층 재검토를 요청하지 못했습니다.') }
      }
    },
  )

  ipcMain.handle(
    CHANNELS.saveSectionBoundaries,
    async (_event, documentId: unknown, overrides: unknown): Promise<SaveSectionBoundariesResult> => {
      try {
        return await handlers().review.saveSectionBoundaries(documentId, overrides)
      } catch (cause) {
        console.error('[review:save-sections] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '항목 경계를 저장하지 못했습니다.') }
      }
    },
  )

  ipcMain.handle(
    CHANNELS.decideSentenceAnchor,
    async (_event, anchorId: unknown, decision: unknown): Promise<DecideSentenceAnchorResult> => {
      try {
        return await handlers().review.decideSentenceAnchor(anchorId, decision)
      } catch (cause) {
        console.error('[review:decide-anchor] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '문장 확인을 저장하지 못했습니다.') }
      }
    },
  )
  ipcMain.handle(CHANNELS.runCheck, async (_event, documentId: unknown): Promise<RunCheckResult> => {
    if (typeof documentId !== 'string') return { status: 'failed', message: '점검할 보고서를 알 수 없습니다.' }
    try {
      const result = await handlers().check.run(documentId)
      return result.ok ? { status: 'checked', check: toCheckView(result.view) } : { status: 'failed', message: result.message }
    } catch (cause) {
      console.error('[rubric:check] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '점검하지 못했습니다.') }
    }
  })

  ipcMain.handle(CHANNELS.getCheck, (_event, documentId: unknown): GetCheckResult => {
    if (typeof documentId !== 'string') return { status: 'failed', message: '보고서를 알 수 없습니다.' }
    try {
      const view = handlers().check.get(documentId)
      return { status: 'ok', check: view === null ? null : toCheckView(view) }
    } catch (cause) {
      console.error('[rubric:get-check] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '점검 결과를 읽지 못했습니다.') }
    }
  })

  ipcMain.handle(CHANNELS.setDocumentKind, (_event, documentId: unknown, kind: unknown): SetDocumentKindResult => {
    try {
      return handlers().review.setDocumentKind(documentId, kind)
    } catch (cause) {
      console.error('[review:set-kind] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '문서 종류를 저장하지 못했습니다.') }
    }
  })

  ipcMain.handle(CHANNELS.analyzeOutline, async (_event, documentId: unknown): Promise<AnalyzeOutlineResult> => {
    try {
      return await handlers().review.analyzeOutline(documentId)
    } catch (cause) {
      console.error('[review:analyze-outline] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '목차를 나누지 못했습니다.') }
    }
  })

  ipcMain.handle(
    CHANNELS.deleteFeedback,
    async (_event, documentId: unknown, feedbackId: unknown): Promise<DeleteResult> => {
      try {
        return await handlers().review.deleteFeedback(documentId, feedbackId)
      } catch (cause) {
        console.error('[review:delete-feedback] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '피드백을 지우지 못했습니다.') }
      }
    },
  )
}

/**
 * 첫 실행 안내 (9단계). 키체인을 읽지 못해도 안내는 나와야 하므로 실패를 삼키지 않고
 * '확인하지 못함'으로 넘긴다. 남은 단계 계산 자체는 부작용 없는 순수 함수다.
 */
function registerFirstRunIpc(documents: () => DocumentHandlers, settings: () => SettingsHandlers): void {
  ipcMain.handle(CHANNELS.getFirstRun, async (): Promise<FirstRunGuide> => {
    let keyStatus: AiSettingsView['keyStatus'] = 'unreadable'
    // Claude 모드는 선택이다. 확인하지 못하면 '확인 실패'로 두고 안내는 그대로 낸다.
    let claudeState: AiSettingsView['claude']['state'] = 'error'
    try {
      const view = await settings().getAiSettings()
      if (view.status === 'ok') {
        keyStatus = view.settings.keyStatus
        claudeState = view.settings.claude.state
      }
    } catch (cause) {
      console.error('[app:first-run] 설정 확인 실패', cause)
    }
    return firstRunGuide({
      documents: documents().listDocuments(),
      keyStatus,
      claudeState,
      dataPath: app.getPath('userData'),
      logPath: app.getPath('logs'),
    })
  })
}

function registerIpc(handlers: () => DocumentHandlers): void {
  for (const channel of [CHANNELS.getDocumentWorkspace, CHANNELS.refreshDocument]) {
    ipcMain.handle(channel, (_event, documentId: unknown) => {
      try {
        return channel === CHANNELS.getDocumentWorkspace
          ? handlers().getDocumentWorkspace(documentId)
          : handlers().refreshDocument(documentId)
      } catch (cause) {
        console.error('[document:workspace] 실패', cause)
        return { status: 'failed', message: failureMessage(cause, '문서 작업 공간을 읽지 못했습니다.') }
      }
    })
  }
  ipcMain.handle(CHANNELS.appInfo, (): AppInfo => {
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      userDataPath: app.getPath('userData'),
      logPath: app.getPath('logs'),
    }
  })

  ipcMain.handle(CHANNELS.chooseDocument, async (_event, subject: unknown) => {
    try {
      // 과목은 선택이다 ([Q-52]). 문자열이 아니면 비운 것으로 본다.
      return await handlers().chooseDocument(typeof subject === 'string' ? subject : '')
    } catch (cause) {
      // 오류를 조용히 삼키지 않는다 (CLAUDE.md §7).
      console.error('[document:choose] 실패', cause)
      return {
        status: 'failed',
        message: cause instanceof Error ? cause.message : '문서를 등록하지 못했습니다.',
      }
    }
  })

  ipcMain.handle(CHANNELS.listDocuments, () => {
    try {
      return handlers().listDocuments()
    } catch (cause) {
      console.error('[document:list] 실패', cause)
      return []
    }
  })

  ipcMain.handle(CHANNELS.reconnectDocument, async (_event, documentId: unknown) => {
    if (typeof documentId !== 'string') {
      return { status: 'failed', message: '다시 연결할 문서를 알 수 없습니다.' }
    }
    try {
      return await handlers().reconnectDocument(documentId)
    } catch (cause) {
      console.error('[document:reconnect] 실패', cause)
      return {
        status: 'failed',
        message: cause instanceof Error ? cause.message : '문서를 다시 연결하지 못했습니다.',
      }
    }
  })

  ipcMain.handle(
    CHANNELS.markCheckpoint,
    (_event, documentId: unknown, label: unknown): MarkCheckpointResult => {
      if (typeof documentId !== 'string' || typeof label !== 'string') {
        return { status: 'failed', message: '체크포인트를 남길 문서를 알 수 없습니다.' }
      }
      try {
        const result = handlers().markCheckpoint(documentId, label)
        if (result.status === 'failed') console.warn('[checkpoint:mark] 실패', result.message)
        return result
      } catch (cause) {
        console.error('[checkpoint:mark] 실패', cause)
        return {
          status: 'failed',
          message: cause instanceof Error ? cause.message : '체크포인트를 남기지 못했습니다.',
        }
      }
    },
  )

  ipcMain.handle(
    CHANNELS.restoreCheckpoint,
    async (_event, checkpointId: unknown): Promise<RestoreCheckpointResult> => {
      if (typeof checkpointId !== 'string') {
        return { status: 'failed', message: '되살릴 체크포인트를 알 수 없습니다.' }
      }
      try {
        const result = await handlers().restoreCheckpoint(checkpointId)
        if (result.status === 'failed') console.warn('[checkpoint:restore] 실패', result.message)
        return result
      } catch (cause) {
        console.error('[checkpoint:restore] 실패', cause)
        return {
          status: 'failed',
          message: cause instanceof Error ? cause.message : '체크포인트를 되살리지 못했습니다.',
        }
      }
    },
  )

  ipcMain.handle(CHANNELS.deleteCheckpoint, async (_event, checkpointId: unknown): Promise<DeleteResult> => {
    if (typeof checkpointId !== 'string') return { status: 'failed', message: '지울 체크포인트를 알 수 없습니다.' }
    try {
      return await handlers().deleteCheckpoint(checkpointId)
    } catch (cause) {
      console.error('[checkpoint:delete] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '체크포인트를 지우지 못했습니다.') }
    }
  })

  ipcMain.handle(CHANNELS.deleteDocument, async (_event, documentId: unknown): Promise<DeleteResult> => {
    if (typeof documentId !== 'string') return { status: 'failed', message: '지울 보고서를 알 수 없습니다.' }
    try {
      return await handlers().deleteDocument(documentId)
    } catch (cause) {
      console.error('[document:delete] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '보고서를 삭제하지 못했습니다.') }
    }
  })
}

/**
 * 등록된 문서의 감시를 다시 건다. 창이 다 뜬 뒤에 해야 시작 중 생긴 알림(경로 유실 등)이 화면에 닿는다.
 * 알림을 놓치더라도 경로 유실은 저장소에 표시되므로 목록에서 다시 보인다.
 */
function resumeWatchingWhenLoaded(window: BrowserWindow, handlers: () => DocumentHandlers): void {
  window.webContents.once('did-finish-load', () => {
    Promise.resolve()
      .then(() => handlers().resumeWatching())
      .catch((cause: unknown) => {
        console.error('[document:watch] 감시를 다시 시작하지 못했습니다', cause)
      })
  })
}

/**
 * 시작 중에 터진 예외를 **드러낸다** (`CLAUDE.md` §7).
 *
 * 묶은 .app 은 터미널이 없어서, 여기서 잡지 않으면 창도 안 뜨고 아무 말 없이 사라진다.
 * 무엇이 잘못됐는지 파일로 남기고 사용자에게도 보여 준다.
 */
function reportFatal(stage: string, cause: unknown): void {
  const detail = cause instanceof Error ? `${cause.message}\n\n${cause.stack ?? ''}` : String(cause)
  console.error(`[app:${stage}] 시작하지 못했습니다`, cause)
  try {
    dialog.showErrorBox(
      '실험보고서 학습 보조를 시작하지 못했습니다',
      `${stage} 단계에서 문제가 생겼습니다.\n\n${detail}`,
    )
  } catch {
    // 창을 띄울 수 없는 시점이면 로그만 남긴다.
  }
}

process.on('uncaughtException', (cause) => reportFatal('실행 중', cause))
process.on('unhandledRejection', (cause) => reportFatal('실행 중', cause))

// 경로 고정은 whenReady 보다 먼저 한다. 무엇도 아직 데이터를 읽지 않았을 때여야 한다.
try {
  pinUserPaths()
} catch (cause) {
  reportFatal('데이터 위치 확인', cause)
}

void app.whenReady().then(() => {
  try {
    start()
  } catch (cause) {
    reportFatal('시작', cause)
  }
})

function start(): void {
  if (!assertMacOS()) {
    app.quit()
    return
  }

  const database = createDatabaseLazily()
  const modelSide = createModelSideLazily(database)
  const handlers = createSessionLazily(modelSide, database)
  const documents = (): DocumentHandlers => handlers().documents
  registerIpc(documents)
  // 다른 핸들러처럼 한 번만 만든다. 요청마다 만들면 SQL 준비를 매번 다시 한다.
  let preview: ((documentId: unknown) => Promise<DocumentPreviewResult>) | null = null
  ipcMain.handle(CHANNELS.getDocumentPreview, async (_event, documentId: unknown) => {
    try {
      preview ??= createPreviewHandler(createDocumentRepository(database()))
      return await preview(documentId)
    } catch (cause) {
      console.error('미리보기 초기화 실패', cause)
      return { status: 'failed', message: '미리보기를 불러오지 못했습니다.' }
    }
  })
  registerRubricIpc(handlers)
  registerReviewIpc(handlers)
  for (const method of ['getGrowth','getPersonalRecords','savePersonalRecord','deletePersonalRecord','summarizeGrowth'] as const) {
    ipcMain.handle(CHANNELS[method], async (_event, input: unknown) => {
      try { return await handlers().personalization[method](input) }
      catch (cause) {
        console.error(`[${CHANNELS[method]}] 실패`,cause)
        return {status:'failed',message:'개인화 기록을 처리하지 못했습니다. 입력을 확인하고 다시 시도해 주세요.'}
      }
    })
  }
  const settings = createSettingsLazily(modelSide)
  registerFirstRunIpc(documents, settings)
  registerSettingsIpc(settings)
  // 실행 중인 심층 검토 취소. 자식 프로세스를 정리한다 (T-28).
  // 보조 창 모드 ([Q-44]). 켜면 화면 오른쪽 끝에 좁게, 늘 위에. 끄면 원래 자리로 돌아간다.
  const normalBounds = new Map<number, Rectangle>()
  ipcMain.handle(CHANNELS.setCompactWindow, (event, on: unknown): { compact: boolean } => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null) return { compact: false }
    if (on === true) {
      if (!normalBounds.has(window.id)) normalBounds.set(window.id, window.getBounds())
      window.setMinimumSize(COMPACT_MIN.width, COMPACT_MIN.height)
      window.setBounds(compactBounds(screen.getDisplayMatching(window.getBounds()).workArea))
      window.setAlwaysOnTop(true, 'floating')
      return { compact: true }
    }
    window.setAlwaysOnTop(false)
    window.setMinimumSize(NORMAL_MIN.width, NORMAL_MIN.height)
    const saved = normalBounds.get(window.id)
    if (saved !== undefined) window.setBounds(saved)
    normalBounds.delete(window.id)
    return { compact: false }
  })

  // 글 다듬기 ([Q-43]). 저장소를 쓰지 않으므로 DB 를 열지 못해도 쓸 수 있다.
  let polish: ((request: unknown) => Promise<PolishResult>) | null = null
  ipcMain.handle(CHANNELS.polishText, async (_event, request: unknown): Promise<PolishResult> => {
    try {
      if (polish === null) {
        const { models, online } = modelSide()
        polish = createPolishHandler(createPolishService({ models, online }))
      }
      return await polish(request)
    } catch (cause) {
      console.error('[polish:request] 실패', cause)
      return { status: 'failed', message: failureMessage(cause, '글을 다듬지 못했습니다.') }
    }
  })

  ipcMain.handle(CHANNELS.cancelDeepReview, (): CancelDeepReviewResult => {
    const { deep } = modelSide()
    if (!deep.busy()) return { status: 'idle' }
    deep.cancel()
    return { status: 'canceled' }
  })
  resumeWatchingWhenLoaded(createWindow(), documents)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('will-quit', () => {
    try {
      // 앱이 닫힐 때 검토 자식 프로세스를 남기지 않는다 (T-28).
      modelSide().deep.cancel()
    } catch (cause) {
      console.error('[review:deep] 실행 중인 심층 검토를 정리하지 못했습니다', cause)
    }
    try {
      documents().stopWatching()
    } catch (cause) {
      console.error('[document:watch] 감시를 멈추지 못했습니다', cause)
    }
  })
}

app.on('window-all-closed', () => {
  // macOS 관례상 창을 모두 닫아도 앱은 남지만, 개인용 단일 창 앱이라 그대로 종료한다.
  app.quit()
})
