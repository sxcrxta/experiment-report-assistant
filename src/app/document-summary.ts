/**
 * 보고서 목록에 보여 줄 **한 문단 요약** ([Q-36]).
 *
 * PRD 4.3 이 요약을 빠른 검토 모델(Gemma)에 맡기므로 깊이는 `quick` 하나만 쓴다.
 * 어느 어댑터가 붙는지는 `modelFor` 만 안다 — 여기에 모델 이름을 적지 않는다 (`CLAUDE.md` §5).
 *
 * 지키는 것
 * - **피드백이 아니다.** 단계·관점·지침과 무관하고, 검토 기록에도 남지 않는다.
 * - **저장을 감지했을 때만 만든다** (사용자 결정). 같은 버전을 두 번 만들지 않는다.
 * - 글이 없는 문서에는 모델을 부르지 않는다.
 * - 오프라인·키 미등록·모델 오류면 **조용히 지나간다.** 요약이 없다고 저장 기록이 흔들리지 않는다.
 * - 형식을 어긴 응답은 정해진 횟수만 다시 묻고, 실패하면 저장하지 않는다 (`CLAUDE.md` §5).
 */
import { modelFor, type ReviewModelSet } from '../adapters/model/index.js'
import {
  DOCUMENT_SUMMARY_PROMPT_VERSION, parseDocumentSummary, type DocumentSummaryPayload,
} from '../adapters/model/prompts/index.js'
import type { DocumentRepository, DocumentSummaryRow } from '../adapters/repo/documents.js'
import type { Paragraph } from '../core/document/model.js'
import { hasContent } from '../core/document/model.js'

/** 형식을 어긴 응답을 다시 묻는 횟수. 검토와 같은 규칙으로 정해 둔다. */
const ATTEMPTS = 2

export interface DocumentSummaryDeps {
  repo: DocumentRepository
  models: ReviewModelSet
  /** 오프라인이면 모델을 부르지 않는다 (PRD 5절) */
  isOnline: () => boolean
  now: () => string
}

export interface SummaryInput {
  documentId: string
  versionId: string
  subject: string | null
  paragraphs: readonly Paragraph[]
}

/**
 * 모델에 보낼 내용을 뽑는다. **무엇이 나가는지 이 함수 하나만 보면 된다** (`CLAUDE.md` §4).
 *
 * 사용자 결정([Q-36])으로 본문 전체를 보낸다. 수식은 글이 비어도 내용이므로 함께 싣는다.
 */
export function toSummaryPayload(input: SummaryInput): DocumentSummaryPayload {
  const written = input.paragraphs.filter(hasContent)
  return {
    subject: input.subject,
    headings: written.filter(paragraph => paragraph.role === 'heading').map(paragraph => paragraph.text),
    body: written
      .map(paragraph => paragraph.text || paragraph.equations.join(' '))
      .join('\n'),
  }
}

export interface DocumentSummaryService {
  /** 저장을 감지해 버전을 남긴 뒤 부른다. 실패해도 예외를 던지지 않는다. */
  refresh(input: SummaryInput): Promise<void>
  get(documentId: string): DocumentSummaryRow | null
}

export function createDocumentSummaryService(deps: DocumentSummaryDeps): DocumentSummaryService {
  const { repo, models, isOnline, now } = deps
  /** 문서마다 한 번에 하나만. 저장이 몰아쳐도 같은 문서를 겹쳐 부르지 않는다. */
  const running = new Set<string>()

  return {
    get(documentId) { return repo.getSummary(documentId) },

    async refresh(input): Promise<void> {
      if (running.has(input.documentId)) return
      // 이미 이 버전으로 만들어 두었으면 다시 부르지 않는다.
      if (repo.getSummary(input.documentId)?.versionId === input.versionId) return
      const payload = toSummaryPayload(input)
      if (payload.body.trim().length === 0) return
      if (!isOnline()) return

      // 깊이를 고르는 곳은 `modelFor` 하나뿐이다. 여기서 어댑터를 직접 집지 않는다 (`CLAUDE.md` §5).
      const model = modelFor(models, 'quick')
      if (model.summarizeDocument === undefined) return
      running.add(input.documentId)
      try {
        const availability = await model.checkAvailability()
        if (!availability.available) return
        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
          const call = await model.summarizeDocument(payload)
          if (!call.ok) {
            // 형식 문제만 다시 묻는다. 키·네트워크 문제는 다시 물어도 같다.
            if (call.reason === 'malformed') continue
            return
          }
          const text = parseDocumentSummary(call.text)
          if (text === null) continue
          if (text.length === 0) return
          repo.saveSummary({
            documentId: input.documentId,
            versionId: input.versionId,
            text,
            modelId: model.modelId,
            promptVersion: DOCUMENT_SUMMARY_PROMPT_VERSION,
            createdAt: now(),
          })
          return
        }
      } catch (cause) {
        // 요약은 보조 표시다. 실패를 기록하되 저장 감지 흐름을 막지 않는다.
        console.error('보고서 요약 실패', cause)
      } finally {
        running.delete(input.documentId)
      }
    },
  }
}
