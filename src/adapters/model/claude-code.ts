/**
 * 심층 검토 — 로컬 Claude Code (PRD 4.3, [Q-6], [Q-30]).
 *
 * **이 프로그램에서 문서 내용이 밖으로 나가는 두 번째이자 마지막 지점이다** (`CLAUDE.md` §4).
 * 첫 번째는 빠른 검토의 `fetchTransport`(openrouter-gemma.ts) 이고, 여기는 자식 프로세스의 stdin 이다.
 * `tests/claude-code.test.ts` 가 src 전체에 다른 전송 지점이 없는지 검사한다.
 *
 * 보내는 것: 프롬프트 판의 안내문 + `toModelPayload` 가 뽑은 것
 * (검토 대상 문단, 앞뒤 문맥, 확정한 평가 지침, 관점, 단계, 승인한 개인 지침,
 *  재심이면 기존 피드백과 사용자 판단). 문서 파일·문서 전체·경로·과목·내부 식별자는 보내지 않는다.
 *
 * **Claude API 를 부르지 않는다** (PRD 4.3). 사용자의 맥에 설치·로그인된 Claude Code 를
 * 비대화형으로 부른다. 인증은 그 프로그램이 알아서 하고, 이 앱은 키를 만지지 않는다.
 *
 * 인자와 출력은 설치된 2.1.269 에서 실제로 확인한 것만 쓴다 (`docs/V2-claude-code-확인.md`).
 * - `-p --output-format json --json-schema <스키마>` → `result`(문자열) 와 `structured_output`(객체)
 * - 성공 판정은 **종료 코드 0 이고 `is_error` 가 true 가 아니고 읽을 수 있는 출력이 있을 때**뿐이다.
 *   `subtype` 이 `"success"` 인데 `is_error` 가 true 인 응답이 실제로 있었다.
 *
 * 한 번에 하나만 실행한다(단일 실행 큐). 타임아웃·취소는 자식 프로세스를 죽인다 (T-28).
 * 이 어댑터도 모델의 글만 돌려준다. 검증과 저장은 앱 계층이 `schema.ts` 로 한다.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

import type { GrowthPayload } from '../../shared/personalization.js'

import type { ClaudeCliLocator, ClaudeCliStatus } from './claude-path.js'
import type {
  ModelAvailability,
  ModelCallResult,
  ModelFailureReason,
  ReviewModel,
} from './index.js'
import {
  CHECK_OUTPUT_SCHEMA, CHECK_SYSTEM, DEEP_REVIEW_PROMPT, OUTLINE_OUTPUT_SCHEMA, OUTLINE_SYSTEM,
  POLISH_OUTPUT_SCHEMA, POLISH_SYSTEM, renderCheckPrompt, renderGrowthPrompt, renderOutlinePrompt, renderPolishPrompt,
  type CheckPayload, type CliPromptTemplate, type OutlinePayload, type PolishPayload,
} from './prompts/index.js'
import {
  BODY_MAX_LENGTH,
  EXAMPLE_MAX_LENGTH,
  MAX_ITEMS_PER_RESPONSE,
  SUMMARY_MAX_LENGTH,
  toModelPayload,
  type ReviewRequest,
} from './schema.js'
import { REVIEW_PERSPECTIVES } from '../../shared/review.js'

/**
 * 심층 검토에 쓰는 모델. 이 이름이 응답 기록과 캐시 키의 modelId 가 된다.
 * 바꿀 때는 여기 한 곳만 고친다 ([Q-30]). 과학적 정확성과 복잡한 논리 판단이 심층 검토의 몫이라
 * 가장 강한 모델을 쓴다.
 */
export const CLAUDE_MODEL_ID = 'opus'

/** 한 번 부를 때 기다리는 시간. 심층 검토는 빠른 검토보다 오래 걸린다 */
export const CLAUDE_TIMEOUT_MS = 300_000

/** 자식 프로세스에 보내는 것 전부. */
export interface CliInvocation {
  command: string
  args: readonly string[]
  /** 프롬프트 본문. 인자가 아니라 stdin 으로 보낸다 */
  stdin: string
  timeoutMs: number
}

export interface CliResult {
  /** 종료 코드. 신호로 끝났거나 실행하지 못했으면 null */
  code: number | null
  stdout: string
  stderr: string
  /** 프로그램을 찾지 못했다 (ENOENT) */
  notFound?: boolean
  /** 정해진 시간을 넘겨 프로세스를 죽였다 */
  timedOut?: boolean
  /** 사용자가 취소해 프로세스를 죽였다 */
  canceled?: boolean
}

/** 자식 프로세스를 한 번 실행한다. 테스트에서는 고정 결과를 돌려주는 가짜로 바꾼다. */
export type CliTransport = (invocation: CliInvocation, signal: AbortSignal) => Promise<CliResult>

/**
 * 이 프로그램의 두 번째 외부 전송 지점.
 *
 * `cwd` 를 임시 폴더로 둔다. Claude Code 는 실행 위치의 파일을 볼 수 있는 프로그램이므로,
 * 도구를 모두 껐더라도(`--tools ""`) 사용자의 작업 폴더에서 띄우지 않는다.
 */
export const spawnTransport: CliTransport = ({ command, args, stdin, timeoutMs }, signal) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let canceled = false

    const finish = (result: CliResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    // 타임아웃·취소는 프로세스를 죽인다. 먼저 SIGTERM 을 보내고, 남아 있으면 SIGKILL 한다 (T-28).
    const kill = (): void => {
      child.kill('SIGTERM')
      const hard = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2_000)
      hard.unref()
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)

    function onAbort(): void {
      canceled = true
      kill()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (cause: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr: cause.message, notFound: cause.code === 'ENOENT' })
    })
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut, canceled }))

    child.stdin.on('error', () => {
      // 자식이 stdin 을 먼저 닫으면 EPIPE 가 난다. close 이벤트에서 결과를 만든다.
    })
    child.stdin.end(stdin)
  })

// ---------------------------------------------------------------------------
// 구조화 출력 스키마 — CLI 의 --json-schema 로 넘긴다
// ---------------------------------------------------------------------------

/**
 * 검토 응답의 모양. `schema.ts` 의 한도와 같은 값을 쓴다.
 * 이 스키마는 모델이 형식을 덜 틀리게 하는 **보조**일 뿐이고, 저장·표시 여부는
 * 언제나 `validateModelOutput` 이 정한다 (`CLAUDE.md` §5).
 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: SUMMARY_MAX_LENGTH },
    items: {
      type: 'array',
      maxItems: MAX_ITEMS_PER_RESPONSE,
      items: {
        type: 'object',
        properties: {
          paragraph: { type: 'string' },
          perspective: { type: 'string', enum: [...REVIEW_PERSPECTIVES] },
          severity: { type: 'integer', minimum: 1, maximum: 5 },
          body: { type: 'string', maxLength: BODY_MAX_LENGTH },
          rationale: { type: 'string', maxLength: BODY_MAX_LENGTH },
          rubricItems: { type: 'array', items: { type: 'string' } },
          example: { type: 'string', maxLength: EXAMPLE_MAX_LENGTH },
        },
        required: ['paragraph', 'perspective', 'severity', 'body', 'rationale', 'rubricItems'],
      },
    },
  },
  required: ['summary', 'items'],
} as const

/** 성장 요약 응답의 모양 (`core/personalization/growth.ts` 의 검증과 같은 값). */
export const GROWTH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 300 },
          evidence: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
        },
        required: ['text', 'evidence'],
      },
    },
  },
  required: ['sentences'],
} as const

const GROWTH_SYSTEM =
  '당신은 학습 기록의 집계를 그대로 옮겨 적는 도구입니다. 집계에 없는 사실·원인·능력 평가를 추론하지 않고, ' +
  '요청한 JSON 형식으로만 답합니다. 파일을 읽거나 명령을 실행하지 않습니다.'

// ---------------------------------------------------------------------------
// 응답 봉투 읽기
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface CliEnvelope {
  isError: boolean
  apiErrorStatus: number | null
  /** 모델의 글. 구조화 출력이 있으면 그것을 직렬화한 것 */
  text: string | null
  /** 오류일 때 CLI 가 설명으로 넣은 글. 모델의 답이 아니다 */
  detail: string | null
}

/** stdout 의 JSON 봉투를 읽는다. 읽지 못하면 null. */
export function parseEnvelope(stdout: string): CliEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const isError = parsed['is_error'] === true
  const status = parsed['api_error_status']
  const result = typeof parsed['result'] === 'string' ? parsed['result'] : null
  const structured = parsed['structured_output']

  return {
    isError,
    apiErrorStatus: typeof status === 'number' ? status : null,
    // 오류 응답의 result 는 모델의 답이 아니라 오류 설명이다. 결과로 쓰지 않는다.
    text: isError ? null : isRecord(structured) ? JSON.stringify(structured) : result,
    detail: isError ? result : null,
  }
}

/** 오류 문구에 옮겨 적을 안내의 최대 길이 */
const DETAIL_MAX_LENGTH = 200

function trimDetail(detail: string | null): string {
  if (detail === null) return ''
  const text = detail.trim().replace(/\s+/g, ' ')
  if (text === '') return ''
  return ` (Claude Code 안내: ${text.length > DETAIL_MAX_LENGTH ? `${text.slice(0, DETAIL_MAX_LENGTH)}…` : text})`
}

function failure(reason: ModelFailureReason, message: string): ModelCallResult {
  return { ok: false, reason, message }
}

/** 감지 결과를 부르기 전 판정으로 옮긴다. */
function unavailableOf(status: ClaudeCliStatus): ModelAvailability {
  if (status.state === 'ready') return { available: true }
  if (status.state === 'not-logged-in') {
    return { available: false, reason: 'not-logged-in', message: status.message }
  }
  return { available: false, reason: 'not-installed', message: status.message }
}

export interface ClaudeCodeDeps {
  locator: ClaudeCliLocator
  transport?: CliTransport
  template?: CliPromptTemplate
  modelId?: string
  timeoutMs?: number
}

/** 심층 검토 어댑터. `ReviewModel` 에 더해 실행 중인 호출을 취소할 수 있다. */
export interface CancellableReviewModel extends ReviewModel {
  /**
   * **지금 실행 중인** 호출을 취소한다. 자식 프로세스를 죽인다.
   * 큐에서 기다리는 호출은 취소하지 않는다. 차례가 되면 정상으로 실행된다.
   */
  cancel(): void
  /** 지금 실행 중인가. 화면이 취소 버튼을 보일지 정하는 데 쓴다 */
  busy(): boolean
}

export function createClaudeCode(deps: ClaudeCodeDeps): CancellableReviewModel {
  const {
    locator,
    transport = spawnTransport,
    template = DEEP_REVIEW_PROMPT,
    modelId = CLAUDE_MODEL_ID,
    timeoutMs = CLAUDE_TIMEOUT_MS,
  } = deps

  /** 단일 실행 큐. 앞 호출이 끝나야 다음 호출이 프로세스를 띄운다 (T-28). */
  let queue: Promise<unknown> = Promise.resolve()
  let running = 0
  let controller: AbortController | null = null

  function buildArgs(system: string, schema: unknown): string[] {
    return [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--system-prompt',
      system,
      '--model',
      modelId,
      // 도구를 전부 끈다. 파일을 읽거나 명령을 실행할 길이 없다.
      '--tools',
      '',
      // 물어봐야 하는 일은 자동으로 거부된다. 무인 실행이 멈추지 않는다.
      '--permission-prompts',
      'none',
      // 검토 내용을 ~/.claude/projects 에 남기지 않는다.
      '--no-session-persistence',
      // 이 저장소의 CLAUDE.md·스킬·훅·MCP 가 검토 프롬프트에 섞이지 않게 한다.
      '--safe-mode',
    ]
  }

  async function runOnce(prompt: string, system: string, schema: unknown): Promise<ModelCallResult> {
    const status = await locator.status()
    const availability = unavailableOf(status)
    if (!availability.available) return failure(availability.reason, availability.message)
    if (status.path === null) return failure('not-installed', status.message)

    const abort = new AbortController()
    controller = abort
    running += 1
    let result: CliResult
    try {
      result = await transport(
        { command: status.path, args: buildArgs(system, schema), stdin: prompt, timeoutMs },
        abort.signal,
      )
    } catch (cause) {
      return failure(
        'rejected',
        `Claude Code 를 실행하지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    } finally {
      running -= 1
      if (controller === abort) controller = null
    }

    if (result.notFound === true) {
      locator.forget()
      return failure('not-installed', 'Claude Code 실행 파일을 찾지 못했습니다. 설정에서 경로를 다시 확인해 주세요.')
    }
    if (result.canceled === true) {
      return failure('rejected', '심층 검토를 취소했습니다.')
    }
    if (result.timedOut === true) {
      return failure(
        'timeout',
        `심층 검토가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 중단했습니다. 범위를 좁혀 다시 요청해 주세요.`,
      )
    }

    const envelope = parseEnvelope(result.stdout)
    if (envelope === null) {
      const stderr = result.stderr.trim()
      return failure(
        result.code === 0 ? 'malformed' : 'rejected',
        `Claude Code 의 응답을 읽지 못했습니다${stderr === '' ? '' : ` (${stderr.slice(0, DETAIL_MAX_LENGTH)})`}.`,
      )
    }

    if (envelope.isError || result.code !== 0) {
      const detail = trimDetail(envelope.detail)
      const status = envelope.apiErrorStatus
      if (status === 401 || status === 403) {
        return failure(
          'unauthorized',
          `Claude Code 의 로그인이 거절되었습니다. 터미널에서 \`claude auth login\` 으로 다시 로그인해 주세요.${detail}`,
        )
      }
      if (status === 429) {
        return failure('rate-limited', `Claude 사용량 제한에 걸렸습니다. 잠시 뒤 다시 요청해 주세요.${detail}`)
      }
      if (status !== null && status >= 500) {
        return failure('server-error', `Claude 쪽 문제로 응답을 받지 못했습니다 (HTTP ${status}).${detail}`)
      }
      return failure('rejected', `Claude Code 가 요청을 끝내지 못했습니다.${detail}`)
    }

    if (envelope.text === null || envelope.text.trim() === '') {
      return failure('malformed', 'Claude Code 응답에서 모델의 답을 찾지 못했습니다.')
    }
    return { ok: true, text: envelope.text }
  }

  /** 큐에 넣는다. 앞 호출이 실패해도 뒤 호출이 사라지지 않는다. */
  function enqueue(run: () => Promise<ModelCallResult>): Promise<ModelCallResult> {
    const next = queue.catch(() => undefined).then(run)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    modelId,
    promptVersion: template.version,

    async checkAvailability(): Promise<ModelAvailability> {
      return unavailableOf(await locator.status())
    },

    review(request: ReviewRequest): Promise<ModelCallResult> {
      const prompt = renderOutboundPrompt(request, template)
      return enqueue(() => runOnce(prompt, template.system, REVIEW_OUTPUT_SCHEMA))
    },

    summarizeGrowth(payload: GrowthPayload): Promise<ModelCallResult> {
      return enqueue(() => runOnce(renderGrowthPrompt(payload), GROWTH_SYSTEM, GROWTH_OUTPUT_SCHEMA))
    },

    polishText(payload: PolishPayload): Promise<ModelCallResult> {
      return enqueue(() => runOnce(renderPolishPrompt(payload), POLISH_SYSTEM, POLISH_OUTPUT_SCHEMA))
    },

    analyzeOutline(payload: OutlinePayload): Promise<ModelCallResult> {
      return enqueue(() => runOnce(renderOutlinePrompt(payload), OUTLINE_SYSTEM, OUTLINE_OUTPUT_SCHEMA))
    },

    checkSubmission(payload: CheckPayload): Promise<ModelCallResult> {
      return enqueue(() => runOnce(renderCheckPrompt(payload), CHECK_SYSTEM, CHECK_OUTPUT_SCHEMA))
    },

    cancel(): void {
      controller?.abort()
    },

    busy(): boolean {
      return running > 0
    },
  }
}

/** 모델에 보낼 글 전부. 밖으로 나가는 문서 내용은 이것뿐이다. */
export function renderOutboundPrompt(
  request: ReviewRequest,
  template: CliPromptTemplate = DEEP_REVIEW_PROMPT,
): string {
  return template.render(toModelPayload(request))
}
