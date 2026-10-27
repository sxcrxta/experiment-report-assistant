/**
 * AI 검토 설정의 메인 프로세스 쪽 처리 — OpenRouter 키 등록과 상태 안내 (PRD 5절).
 *
 * - 키는 렌더러에서 한 번 넘어와 키체인에 들어갈 뿐이다. 설정 파일·DB·로그에 쓰지 않고,
 *   렌더러로 되돌려 보내지 않는다. 화면이 아는 것은 "등록됨/등록 안 됨"뿐이다 (`CLAUDE.md` §4).
 * - 키를 지우는 일은 되돌릴 수 없으므로 확인 창을 거친다 (`CLAUDE.md` §3).
 * - 오프라인이거나 키가 없으면 그 사실과 할 일을 알린다. 막히는 것은 AI 검토 요청뿐이다.
 * - 검토를 요청하면 무엇이 외부로 나가는지 함께 보여 준다.
 *
 * Claude 모드(심층 검토)는 **선택적**이다. 찾지 못했거나 로그인되어 있지 않아도 이 화면은 그 사실만
 * 알려 주고, 빠른 검토와 나머지 기능은 그대로 쓴다 (PRD 4.3, [Q-30]).
 * 사용자가 직접 지정한 실행 파일 경로는 비밀이 아니므로 로컬 설정에 둔다. 키는 여전히 키체인에만 있다.
 *
 * electron 을 import 하지 않는다. 확인 창은 인자로 받는다. 그래야 Electron 없이 테스트할 수 있다.
 */
import { modelFor, type ReviewModelSet } from '../adapters/model/index.js'
import { isUsableCliPath, type ClaudeCliStatus } from '../adapters/model/claude-path.js'
import type { OnlineStatus } from '../adapters/net/online.js'
import { SECRET_KEYS, type SecretStore } from '../adapters/secret/index.js'
import { isSafeKeychainValue } from '../adapters/secret/keychain.js'
import { checkReviewAvailability } from '../app/review-request.js'
import { CONTEXT_RADIUS } from '../core/diff/context.js'
import {
  CLAUDE_CLI_PATH_MAX_LENGTH,
  OPENROUTER_KEY_MAX_LENGTH,
  type AiSettingsResult,
  type AiSettingsView,
  type ClaudeModeResult,
  type ClaudeModeView,
  type DeleteOpenRouterKeyResult,
  type SaveOpenRouterKeyResult,
} from '../shared/ipc.js'

import type { ConfirmRequest } from './document-ipc.js'

/** Claude 모드를 보고 고치는 길. 메인 프로세스가 어댑터·저장소에 연결해 넘긴다. */
export interface ClaudeModeControls {
  /** 지금 상태. 캐시된 값을 쓸 수 있다 */
  status(): Promise<ClaudeCliStatus>
  /** 캐시를 버리고 다시 찾는다 */
  recheck(): Promise<ClaudeCliStatus>
  /** 사용자가 지정한 경로를 저장한다. 저장만 하고 확인은 status 가 한다 */
  setPath(path: string): void
  /** 지정한 경로를 지운다 */
  clearPath(): void
}

export interface SettingsIpcDeps {
  secrets: SecretStore
  online: OnlineStatus
  /** 깊이별 어댑터. 설정 화면도 검토 요청과 같은 판정을 쓴다 */
  models: ReviewModelSet
  claude: ClaudeModeControls
  /** @returns 사용자가 확인을 눌렀으면 true */
  confirm: (request: ConfirmRequest) => Promise<boolean>
}

/** 렌더러에서 온 값을 그대로 받는다. 형태 확인은 여기서 한다. */
export interface SettingsHandlers {
  getAiSettings(): Promise<AiSettingsResult>
  saveOpenRouterKey(key: unknown): Promise<SaveOpenRouterKeyResult>
  deleteOpenRouterKey(): Promise<DeleteOpenRouterKeyResult>
  recheckClaudeMode(): Promise<ClaudeModeResult>
  saveClaudeCliPath(path: unknown): Promise<ClaudeModeResult>
  clearClaudeCliPath(): Promise<ClaudeModeResult>
}

/** 사용자가 입력한 Claude Code 경로를 확인한다. 절대 경로만 받는다. */
export function parseClaudeCliPathInput(
  value: unknown,
): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof value !== 'string') return { ok: false, message: '경로를 읽지 못했습니다.' }
  const path = value.trim()
  if (path === '') return { ok: false, message: 'Claude Code 실행 파일의 경로를 입력해 주세요.' }
  if (path.length > CLAUDE_CLI_PATH_MAX_LENGTH) {
    return { ok: false, message: `경로는 ${CLAUDE_CLI_PATH_MAX_LENGTH}자까지 넣을 수 있습니다.` }
  }
  if (!isUsableCliPath(path)) {
    return {
      ok: false,
      message:
        '절대 경로를 입력해 주세요. 터미널에서 `which claude` 를 실행하면 나오는 경로입니다 (예: /Users/이름/.local/bin/claude).',
    }
  }
  return { ok: true, path }
}

/** 입력한 키를 확인한다. 문구에 입력값을 옮겨 적지 않는다. */
export function parseOpenRouterKeyInput(value: unknown): { ok: true; key: string } | { ok: false; message: string } {
  if (typeof value !== 'string') return { ok: false, message: '키를 읽지 못했습니다.' }
  const key = value.trim()
  if (key === '') return { ok: false, message: 'OpenRouter 키를 입력해 주세요.' }
  if (key.length > OPENROUTER_KEY_MAX_LENGTH) {
    return { ok: false, message: `키는 ${OPENROUTER_KEY_MAX_LENGTH}자까지 넣을 수 있습니다.` }
  }
  if (!isSafeKeychainValue(key)) {
    return {
      ok: false,
      message:
        'OpenRouter 키에 쓸 수 없는 문자가 있습니다. 영문·숫자·-·_ 만 쓸 수 있습니다. ' +
        '복사할 때 공백이나 따옴표가 섞이지 않았는지 확인해 주세요.',
    }
  }
  return { ok: true, key }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createSettingsHandlers(deps: SettingsIpcDeps): SettingsHandlers {
  const { secrets, online, models, claude } = deps
  const model = modelFor(models, 'quick')
  const deepModel = modelFor(models, 'deep')

  /** Claude 모드 상태를 화면이 읽는 모양으로 옮긴다. */
  async function claudeView(status: ClaudeCliStatus): Promise<ClaudeModeView> {
    const availability = await checkReviewAvailability({ online, model: deepModel })
    return {
      state: status.state,
      path: status.path,
      version: status.version,
      message: status.message,
      fromOverride: status.fromOverride,
      deepAvailable: availability.available,
      deepUnavailableMessage: availability.available ? '' : availability.message,
      modelId: deepModel.modelId,
    }
  }

  async function view(status?: ClaudeCliStatus): Promise<AiSettingsView> {
    let keyStatus: AiSettingsView['keyStatus']
    try {
      keyStatus = (await secrets.get(SECRET_KEYS.openRouter)) === null ? 'missing' : 'registered'
    } catch (cause) {
      console.warn('[settings] 키체인을 확인하지 못했습니다', messageOf(cause))
      keyStatus = 'unreadable'
    }

    const availability = await checkReviewAvailability({ online, model })
    return {
      keyStatus,
      online: online.isOnline(),
      reviewAvailable: availability.available,
      unavailableMessage: availability.available ? '' : availability.message,
      modelId: model.modelId,
      outboundNotice:
        `빠른 검토를 요청하면 고른 문단과 그 앞뒤 문단 ${CONTEXT_RADIUS}개씩, 확정한 평가 지침만 ` +
        `OpenRouter(${model.modelId})로 보냅니다. 심층 검토는 같은 내용을 이 맥에 설치된 ` +
        `Claude Code(${deepModel.modelId})에 넘깁니다. 두 경우 모두 문서 파일이나 문서 전체는 보내지 않습니다.`,
      claude: await claudeView(status ?? (await claude.status())),
    }
  }

  return {
    async getAiSettings(): Promise<AiSettingsResult> {
      return { status: 'ok', settings: await view() }
    },

    async saveOpenRouterKey(value): Promise<SaveOpenRouterKeyResult> {
      const parsed = parseOpenRouterKeyInput(value)
      if (!parsed.ok) return { status: 'failed', message: parsed.message }

      try {
        await secrets.set(SECRET_KEYS.openRouter, parsed.key)
      } catch (cause) {
        return { status: 'failed', message: `키를 키체인에 넣지 못했습니다: ${messageOf(cause)}` }
      }
      return { status: 'saved', settings: await view() }
    },

    async deleteOpenRouterKey(): Promise<DeleteOpenRouterKeyResult> {
      const confirmed = await deps.confirm({
        message: 'OpenRouter 키를 키체인에서 지울까요?',
        detail:
          '지우면 다시 등록할 때까지 AI 검토를 요청할 수 없습니다. ' +
          '문서 기록·지침 편집 등 나머지 기능은 그대로입니다.',
        confirmLabel: '키 지우기',
      })
      if (!confirmed) return { status: 'canceled' }

      try {
        await secrets.delete(SECRET_KEYS.openRouter)
      } catch (cause) {
        return { status: 'failed', message: `키를 지우지 못했습니다: ${messageOf(cause)}` }
      }
      return { status: 'deleted', settings: await view() }
    },

    async recheckClaudeMode(): Promise<ClaudeModeResult> {
      return { status: 'ok', settings: await view(await claude.recheck()) }
    },

    async saveClaudeCliPath(value): Promise<ClaudeModeResult> {
      const parsed = parseClaudeCliPathInput(value)
      if (!parsed.ok) return { status: 'failed', message: parsed.message }
      try {
        claude.setPath(parsed.path)
      } catch (cause) {
        return { status: 'failed', message: `경로를 저장하지 못했습니다: ${messageOf(cause)}` }
      }
      // 저장한 경로가 실제로 도는지는 다시 찾아보며 확인한다. 실패해도 그 사실만 알린다.
      return { status: 'ok', settings: await view(await claude.recheck()) }
    },

    async clearClaudeCliPath(): Promise<ClaudeModeResult> {
      try {
        claude.clearPath()
      } catch (cause) {
        return { status: 'failed', message: `지정한 경로를 지우지 못했습니다: ${messageOf(cause)}` }
      }
      return { status: 'ok', settings: await view(await claude.recheck()) }
    },
  }
}
