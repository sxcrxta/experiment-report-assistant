/**
 * 글 다듬기 ([Q-43], 사용자 결정 2026-09-28 — PRD 밖의 기능).
 *
 * 사용자가 전하고 싶은 내용을 적으면 AI 가 보고서 문체로 매끄럽게 고쳐 쓴다.
 * PRD 의 대필 금지에서 **이 기능만** 뺐다. 다른 기능(검토·요약·지침 초안)에는 그대로 적용된다.
 *
 * 지키는 것
 * - **사용자가 먼저 적어야 한다.** 빈 글에는 모델을 부르지 않는다.
 * - **HWPX 에 쓰지 않는다.** 결과는 화면에 보여 줄 뿐이고, 옮기는 것은 사용자다 (`CLAUDE.md` §3).
 * - 나가는 것은 적은 글·요청 한 줄·과목·문서 종류뿐이다. 보고서 본문은 보내지 않는다 (`CLAUDE.md` §4).
 * - 깊이를 고르는 곳은 `modelFor` 하나뿐이다 (`CLAUDE.md` §5).
 * - 형식을 어긴 응답은 정해진 횟수만 다시 묻고, 실패하면 정직하게 알린다. 원문을 결과인 척 보여 주지 않는다.
 * - 저장하지 않는다. 다듬은 글은 결과로만 돌려준다.
 */
import { modelFor, type ReviewModelSet } from '../adapters/model/index.js'
import type { OnlineStatus } from '../adapters/net/online.js'
import {
  POLISH_DRAFT_MAX_LENGTH, POLISH_NOTE_MAX_LENGTH, parsePolish, type PolishPayload,
} from '../adapters/model/prompts/index.js'
import type { ReviewDepth } from '../shared/review.js'

/** 형식을 어긴 응답을 다시 묻는 횟수. 검토와 같은 규칙으로 정해 둔다. */
const ATTEMPTS = 2

export interface PolishInput {
  draft: string
  note: string
  subject: string | null
  depth: ReviewDepth
  /** 문서 종류 ([Q-48]). 모르면 빈 문자열이거나 없다 */
  kind?: string
}

export type PolishOutcome =
  | { ok: true; text: string; modelId: string }
  | { ok: false; message: string }

export interface PolishDeps {
  models: ReviewModelSet
  online: OnlineStatus
}

/** 모델에 보낼 내용. **무엇이 나가는지 이 함수 하나만 보면 된다** (`CLAUDE.md` §4). */
export function toPolishPayload(input: PolishInput): PolishPayload {
  return { subject: input.subject, note: input.note.trim(), draft: input.draft.trim(), kind: (input.kind ?? '').trim() }
}

export function createPolishService(deps: PolishDeps): { polish(input: PolishInput): Promise<PolishOutcome> } {
  return {
    async polish(input): Promise<PolishOutcome> {
      const payload = toPolishPayload(input)
      if (payload.draft === '') return { ok: false, message: '다듬을 내용을 먼저 적어 주세요.' }
      if (payload.draft.length > POLISH_DRAFT_MAX_LENGTH) {
        return { ok: false, message: `한 번에 ${POLISH_DRAFT_MAX_LENGTH}자까지 다듬을 수 있습니다.` }
      }
      if (payload.note.length > POLISH_NOTE_MAX_LENGTH) {
        return { ok: false, message: `요청은 ${POLISH_NOTE_MAX_LENGTH}자까지 적을 수 있습니다.` }
      }
      if (!deps.online.isOnline()) return { ok: false, message: '오프라인입니다. 인터넷에 연결되면 다시 시도해 주세요.' }

      const model = modelFor(deps.models, input.depth)
      if (model.polishText === undefined) return { ok: false, message: '이 깊이에서는 다듬기를 쓸 수 없습니다.' }
      const availability = await model.checkAvailability()
      if (!availability.available) return { ok: false, message: availability.message }

      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const call = await model.polishText(payload)
        if (!call.ok) {
          // 형식 문제만 다시 묻는다. 키·네트워크 문제는 다시 물어도 같다.
          if (call.reason === 'malformed') continue
          return { ok: false, message: call.message }
        }
        const text = parsePolish(call.text, payload.draft)
        if (text !== null) return { ok: true, text, modelId: model.modelId }
      }
      return { ok: false, message: 'AI 응답의 형식이 맞지 않아 결과를 보여 드리지 못했습니다. 다시 시도해 주세요.' }
    },
  }
}
