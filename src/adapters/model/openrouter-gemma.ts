/**
 * 빠른 검토 — OpenRouter 의 Gemma (PRD 4.3).
 *
 * **이 프로그램에서 데이터가 외부로 나가는 곳은 이 파일의 `fetchTransport` 한 곳뿐이다** (`CLAUDE.md` §4).
 * `tests/gemma.test.ts` 가 src 전체에 다른 전송 지점이 없는지 검사한다.
 *
 * 보내는 것: 프롬프트 판의 안내문 + `toModelPayload` 가 뽑은 것
 * (검토 대상 문단, 앞뒤 문맥, 확정한 평가 지침, 관점, 단계, 승인한 개인 지침).
 * 문서 파일·문서 전체·경로·과목·요청과 버전 식별자는 보내지 않는다. `renderOutboundPrompt` 가 보낼 글 전부다.
 *
 * 키는 부를 때마다 키체인에서 읽어 요청 머리글에만 싣는다. 로그·오류 문구·반환값에 넣지 않는다.
 *
 * 이 어댑터는 모델의 글만 돌려준다. 검증과 저장은 앱 계층이 `schema.ts` 로 한다.
 *
 * OpenRouter 의 chat completions 요청·응답 모양은 이 개발 환경에서 실제 호출로 확인하지 못했고
 * 고정 응답(tests/gemma.test.ts)으로만 검증했다. 실제 응답이 다르면 `malformed` 로 드러나며 결과로 보여 주지 않는다.
 */
import { SECRET_KEYS, type SecretStore } from '../secret/index.js'

import type {
  ModelAvailability,
  ModelCallResult,
  ModelFailureReason,
  ModelUnavailableReason,
  ReviewModel,
} from './index.js'
import { QUICK_REVIEW_PROMPT, type PromptTemplate } from './prompts/index.js'
import { toModelImages, toModelPayload, type ReviewImage, type ReviewRequest } from './schema.js'
import { renderGrowthPrompt } from './prompts/growth-summary.v1.js'
import { renderDocumentSummaryPrompt } from './prompts/document-summary.v1.js'
import { renderRubricDraftPrompt } from './prompts/rubric-draft.v1.js'
import { renderPolishPrompt } from './prompts/polish.v2.js'
import { renderOutlinePrompt } from './prompts/outline.v2.js'
import { renderCheckPrompt } from './prompts/check.v3.js'

export const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * 빠른 검토에 쓰는 OpenRouter 모델 이름. 이 이름이 응답 기록과 캐시 키의 modelId 가 된다.
 * OpenRouter 모델 목록에서 확인해 확정한다. 바꿀 때는 여기 한 곳만 고친다.
 *
 * `:free` 변형을 쓴다. 토큰 요금이 없는 대신 분당·일당 요청 수 제한이 있다
 * (`OPEN_QUESTIONS.md` [Q-28]). 이 앱은 사용자가 필요할 때만 검토를 요청하므로
 * 그 제한에 걸릴 일이 드물고, 걸리면 rate-limited 로 분류되어 사용자에게 안내된다.
 *
 * gemma-4-31b-it:free 는 실제 호출에서 두 번 다 HTTP 502(Provider returned error)를 냈고,
 * gemma-4-26b-a4b-it:free 는 성공했다. 그래서 후자를 쓴다.
 */
export const GEMMA_MODEL_ID = 'google/gemma-4-26b-a4b-it:free'

/** 한 번 부를 때 기다리는 시간 */
export const OPENROUTER_TIMEOUT_MS = 60_000

/** 오류 문구에 옮겨 적을 서비스 안내의 최대 길이 */
const DETAIL_MAX_LENGTH = 200

export interface OutboundRequest {
  url: string
  headers: Readonly<Record<string, string>>
  body: string
  timeoutMs: number
}

export interface OutboundResponse {
  status: number
  body: string
}

/** 외부로 요청을 보내는 함수. 테스트에서는 고정 응답을 돌려주는 가짜로 바꾼다. */
export type HttpTransport = (request: OutboundRequest) => Promise<OutboundResponse>

/** 이 프로그램의 유일한 외부 전송 지점. */
export const fetchTransport: HttpTransport = async ({ url, headers, body, timeoutMs }) => {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: response.status, body: await response.text() }
}

export interface OpenRouterGemmaDeps {
  secrets: SecretStore
  transport: HttpTransport
  template?: PromptTemplate
  modelId?: string
  timeoutMs?: number
}

/** 모델에 보낼 글 전부. 외부로 나가는 문서 내용은 이것뿐이다. */
export function renderOutboundPrompt(request: ReviewRequest, template: PromptTemplate = QUICK_REVIEW_PROMPT): string {
  return template.render(toModelPayload(request))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** choices[0].message.content */
function contentOf(body: Record<string, unknown>): string | null {
  const choices = body['choices']
  if (!Array.isArray(choices)) return null
  const first: unknown = choices[0]
  if (!isRecord(first)) return null
  const message = first['message']
  if (!isRecord(message)) return null
  const content = message['content']
  return typeof content === 'string' ? content : null
}

/** 서비스가 보낸 오류 안내 (error.message). 모델의 글이 아니다. */
function serviceDetail(body: Record<string, unknown> | null): string | null {
  const error = body?.['error']
  if (!isRecord(error) || typeof error['message'] !== 'string') return null
  const message = error['message'].trim()
  if (message === '') return null
  return message.length > DETAIL_MAX_LENGTH ? `${message.slice(0, DETAIL_MAX_LENGTH)}…` : message
}

function failure(reason: ModelFailureReason, message: string): ModelCallResult {
  return { ok: false, reason, message }
}

function httpFailure(status: number, detail: string | null): ModelCallResult {
  const suffix = detail === null ? '' : ` (OpenRouter 안내: ${detail})`
  if (status === 401 || status === 403) {
    return failure(
      'unauthorized',
      `등록한 OpenRouter 키가 거절되었습니다. 설정에서 키를 확인하거나 다시 등록해 주세요.${suffix}`,
    )
  }
  if (status === 402) {
    return failure('payment-required', `OpenRouter 크레딧이 부족해 요청이 거절되었습니다.${suffix}`)
  }
  if (status === 408) {
    return failure('timeout', `OpenRouter 가 제때 응답하지 않았습니다. 잠시 뒤 다시 요청해 주세요.${suffix}`)
  }
  if (status === 429) {
    return failure(
      'rate-limited',
      `요청이 너무 잦아 OpenRouter 가 잠시 받지 않습니다. 잠시 뒤 다시 요청해 주세요.${suffix}`,
    )
  }
  if (status >= 500) {
    return failure(
      'server-error',
      `OpenRouter 또는 모델 제공자 쪽 문제로 응답을 받지 못했습니다 (HTTP ${status}). 잠시 뒤 다시 요청해 주세요.${suffix}`,
    )
  }
  return failure('rejected', `OpenRouter 가 요청을 받지 않았습니다 (HTTP ${status}).${suffix}`)
}

type KeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: ModelUnavailableReason; message: string }

/**
 * 바이트를 base64 로. 렌더러가 아니라 메인 프로세스에서 도는 코드이므로 `Buffer` 를 쓸 수 있지만,
 * 어댑터가 Node 에 덜 매이도록 직접 옮긴다.
 */
function base64(bytes: Uint8Array): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at]!
    const b = bytes[at + 1]
    const c = bytes[at + 2]
    out += CHARS[a >> 2]! + CHARS[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    out += b === undefined ? '==' : CHARS[((b & 15) << 2) | ((c ?? 0) >> 6)]! + (c === undefined ? '=' : CHARS[c & 63]!)
  }
  return out
}

export function createOpenRouterGemma(deps: OpenRouterGemmaDeps): ReviewModel {
  const {
    secrets,
    transport,
    template = QUICK_REVIEW_PROMPT,
    modelId = GEMMA_MODEL_ID,
    timeoutMs = OPENROUTER_TIMEOUT_MS,
  } = deps

  async function readKey(): Promise<KeyResult> {
    try {
      const key = await secrets.get(SECRET_KEYS.openRouter)
      if (key === null || key === '') {
        return {
          ok: false,
          reason: 'no-key',
          message: 'OpenRouter 키가 등록되지 않았습니다. 설정에서 키를 등록하면 AI 검토를 요청할 수 있습니다.',
        }
      }
      return { ok: true, key }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return {
        ok: false,
        reason: 'keychain-error',
        message: `키체인에서 OpenRouter 키를 읽지 못했습니다: ${detail}`,
      }
    }
  }

  /**
   * OpenRouter 가 받는 메시지 내용. 글만이면 문자열 하나, 그림이 있으면 조각 배열이다 ([Q-38]).
   * 그림은 프롬프트 글이 아니라 **요청의 그림 부분**으로 간다.
   */
  type MessageContent = string | ({ type: 'text'; text: string } | {
    type: 'image_url'; image_url: { url: string }
  })[]

  function contentWithImages(prompt: string, images: readonly ReviewImage[]): MessageContent {
    if (images.length === 0) return prompt
    return [
      { type: 'text', text: prompt },
      ...images.map((image) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${image.mimeType};base64,${base64(image.bytes)}` },
      })),
    ]
  }

  async function sendPrompt(prompt: string, images: readonly ReviewImage[] = []): Promise<ModelCallResult> {
      const key = await readKey()
      if (!key.ok) return failure(key.reason, key.message)

      // Gemma 의 대화 형식에는 system 역할이 따로 없다. 안내문과 입력을 사용자 메시지 하나로 보낸다.
      const outbound: OutboundRequest = {
        url: OPENROUTER_CHAT_COMPLETIONS_URL,
        headers: {
          Authorization: `Bearer ${key.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: contentWithImages(prompt, images) }],
          temperature: 0.2,
        }),
        timeoutMs,
      }

      let response: OutboundResponse
      try {
        response = await transport(outbound)
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') {
          return failure('timeout', 'OpenRouter 가 제때 응답하지 않았습니다. 잠시 뒤 다시 요청해 주세요.')
        }
        return failure('network', 'OpenRouter 에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.')
      }

      const body = parseBody(response.body)
      if (response.status < 200 || response.status >= 300) {
        return httpFailure(response.status, serviceDetail(body))
      }

      const detail = serviceDetail(body)
      if (detail !== null) {
        // 성공 코드로 오류를 알리는 경우. 모델의 글이 아니므로 결과로 쓰지 않는다.
        return failure('server-error', `OpenRouter 가 오류를 알렸습니다: ${detail}`)
      }

      const content = body === null ? null : contentOf(body)
      if (content === null) {
        return failure('malformed', 'OpenRouter 응답에서 모델의 답을 찾지 못했습니다.')
      }
      return { ok: true, text: content }
  }
  return {
    modelId,
    promptVersion: template.version,
    async checkAvailability(): Promise<ModelAvailability> {
      const key = await readKey()
      return key.ok ? { available: true } : { available: false, reason: key.reason, message: key.message }
    },
    // 그림은 문서 전체를 보낸다 (사용자 결정, [Q-38]). 총량은 `toModelImages` 가 묶는다.
    review: request => sendPrompt(renderOutboundPrompt(request, template), toModelImages(request)),
    summarizeGrowth: payload => sendPrompt(renderGrowthPrompt(payload)),
    summarizeDocument: payload => sendPrompt(renderDocumentSummaryPrompt(payload)),
    suggestRubricDraft: (outline, subject) => sendPrompt(renderRubricDraftPrompt(outline, subject)),
    polishText: payload => sendPrompt(renderPolishPrompt(payload)),
    analyzeOutline: payload => sendPrompt(renderOutlinePrompt(payload)),
    checkSubmission: payload => sendPrompt(renderCheckPrompt(payload)),
  }
}
