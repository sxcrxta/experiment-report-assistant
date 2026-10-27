/**
 * 문서 뼈대로 평가 지침 **초안**을 제안하는 보조 기능 (PRD 4.1, 4.3 표의 "평가 지침 초안").
 *
 * 지키는 것
 * - **제안일 뿐이다.** 저장하지 않고 편집기로만 돌려보낸다. 사용자가 확인·수정해 확정하기
 *   전에는 어떤 AI 요청에도 지침으로 실리지 않는다 (`CLAUDE.md` §1).
 * - **뼈대만 나간다.** 제목·표 설명·양식 안내 문구와 개수뿐이고 본문은 보내지 않는다
 *   (`core/rubric/outline.ts`, `CLAUDE.md` §4).
 * - 오프라인이거나 키가 없으면 **이 기능만** 쓸 수 없다고 알린다. 직접 입력은 그대로 된다.
 * - 스키마를 어긴 응답은 정해진 횟수만 다시 묻고, 실패를 정직하게 알린다.
 *   파싱하지 못한 원문을 제안인 척 보여 주지 않는다 (`CLAUDE.md` §5).
 * - 모델이 무엇이든 이 코드는 같다. `modelId` 로 갈라지지 않는다 (T-26).
 */
import type { ReviewModel } from '../adapters/model/index.js'
import type { OnlineStatus } from '../adapters/net/online.js'
import type { DocumentRepository } from '../adapters/repo/documents.js'
import { documentOutline, hasOutlineEvidence } from '../core/rubric/outline.js'
import type { RubricItemContent } from '../core/rubric/model.js'
import {
  RUBRIC_IMPORTANCE_DEFAULT,
  RUBRIC_IMPORTANCE_LEVELS,
  RUBRIC_ITEM_DESCRIPTION_MAX_LENGTH,
  RUBRIC_ITEM_TITLE_MAX_LENGTH,
} from '../shared/rubric.js'

import type { RubricDraftSuggester, RubricSuggestion } from './rubric.js'

/** 형식을 어긴 응답에 다시 묻는 횟수 (첫 요청 포함). */
export const RUBRIC_DRAFT_ATTEMPTS = 3

/** 초안으로 받을 최대 항목 수. 사람이 훑고 고칠 수 있는 양으로 묶는다. */
export const RUBRIC_DRAFT_MAX_ITEMS = 8

const OFFLINE =
  '오프라인입니다. 지침 초안 제안만 쓸 수 없고, 항목을 직접 입력·확정하는 것은 그대로 됩니다.'
const UNSUPPORTED =
  '이 모델의 지침 초안 제안 연결이 준비되지 않았습니다. 항목을 직접 입력해 주세요.'
const NO_EVIDENCE =
  '문서에서 제목이나 표 설명, 안내 문구를 찾지 못해 초안을 제안할 근거가 없습니다. ' +
  '한글에서 제목을 넣어 저장하거나, 항목을 직접 입력해 주세요.'
const MALFORMED =
  '제안된 초안이 형식을 지키지 않아 보여 드리지 않습니다. 다시 요청하거나 직접 입력해 주세요.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 모델이 돌려준 글에서 초안 항목을 꺼낸다.
 *
 * 하나라도 어긋나면 **통째로 버린다.** 반쯤 맞는 초안을 보여 주면 사용자가 그것을 고르게 되고,
 * 어디까지가 모델의 말인지 흐려진다. 길이·중요도의 최종 검증은 `prepareRubricItems` 가 한 번 더 한다.
 */
export function parseRubricDraft(text: string): RubricItemContent[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['items'])) return null

  const raw = parsed['items']
  if (raw.length < 1 || raw.length > RUBRIC_DRAFT_MAX_ITEMS) return null

  const items: RubricItemContent[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return null
    const title = entry['title']
    const description = entry['description'] ?? ''
    const importance = entry['importance'] ?? RUBRIC_IMPORTANCE_DEFAULT

    if (typeof title !== 'string' || title.trim() === '' || title.length > RUBRIC_ITEM_TITLE_MAX_LENGTH) return null
    if (typeof description !== 'string' || description.length > RUBRIC_ITEM_DESCRIPTION_MAX_LENGTH) return null
    if (!(RUBRIC_IMPORTANCE_LEVELS as readonly unknown[]).includes(importance)) return null

    items.push({ title: title.trim(), description: description.trim(), importance: importance as 1 })
  }
  return items
}

export interface RubricSuggesterDeps {
  documents: Pick<DocumentRepository, 'getDocument'>
  model: ReviewModel
  online: OnlineStatus
}

/** 모델로 초안을 제안하는 제안기. 실패는 예외가 아니라 결과로 알린다. */
export function createModelRubricSuggester(deps: RubricSuggesterDeps): RubricDraftSuggester {
  const { documents, model, online } = deps

  return {
    async suggest({ documentId, paragraphs }): Promise<RubricSuggestion> {
      // 뼈대부터 프로그램이 뽑는다. 근거가 없으면 모델을 부르지 않는다.
      const outline = documentOutline(paragraphs)
      if (!hasOutlineEvidence(outline)) return { ok: false, message: NO_EVIDENCE }

      if (model.suggestRubricDraft === undefined) return { ok: false, message: UNSUPPORTED }
      if (!online.isOnline()) return { ok: false, message: OFFLINE }

      const availability = await model.checkAvailability()
      if (!availability.available) return { ok: false, message: availability.message }

      const subject = documents.getDocument(documentId)?.subject ?? null

      for (let attempt = 0; attempt < RUBRIC_DRAFT_ATTEMPTS; attempt += 1) {
        const call = await model.suggestRubricDraft(outline, subject)
        if (!call.ok) {
          // 형식 문제만 다시 묻는다. 키·한도·연결 문제는 다시 물어도 같다.
          if (call.reason === 'malformed') continue
          return { ok: false, message: call.message }
        }
        const items = parseRubricDraft(call.text)
        if (items === null) continue
        return { ok: true, items }
      }
      return { ok: false, message: MALFORMED }
    },
  }
}
