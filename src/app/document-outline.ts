/**
 * 보고서 목차 ([Q-47], 사용자 결정 2026-09-28).
 *
 * 보고서 형식이 제각각이라 번호 규칙만으로는 목차를 못 찾는 경우가 많다. 그래서 **어느 문단이 제목이고
 * 몇 급인지는 AI 가 제안**하고, 프로그램이 검사해 저장한다. 항목의 **범위는 언제나 프로그램이** 정한다
 * (`shared/outline.ts` 의 `buildOutline`, `CLAUDE.md` §2).
 *
 * 지키는 것
 * - 깊이는 `modelFor` 로 고른다. 사용자가 Claude 분석을 원했으므로 심층(Claude Code)을 먼저 쓰고,
 *   쓸 수 없으면 빠른 모델, 그것도 없으면 번호 규칙으로 나눈다. 목차가 없어도 검토는 막히지 않는다.
 * - 나가는 것은 `toOutlinePayload` 가 뽑은 것뿐이다: 글이 있는 문단의 번호와 **앞 60자**, 과목.
 * - 형식을 어긴 응답은 정해진 횟수만 다시 묻는다. 검사를 통과하지 못한 제목은 버린다.
 * - 문단은 uuid 로 저장한다. 본문을 고쳐도 제목 문단이 남아 있으면 목차가 이어진다.
 */
import { modelFor, type ReviewModel, type ReviewModelSet } from '../adapters/model/index.js'
import type { OnlineStatus } from '../adapters/net/online.js'
import {
  OUTLINE_LINE_MAX, OUTLINE_PROMPT_VERSION, parseDocumentKind, parseOutline, type OutlinePayload,
} from '../adapters/model/prompts/index.js'
import type { DocumentRepository } from '../adapters/repo/documents.js'
import type { OutlineRepository } from '../adapters/repo/outline.js'
import { hasContent } from '../core/document/model.js'
import { sha256Hex } from '../core/document/sha256.js'
import type { ParagraphChoice } from '../shared/feedback.js'
import { buildOutline, headingLevel, ruleHeadings, type HeadingMark, type OutlineView } from '../shared/outline.js'

const ATTEMPTS = 2
/** 이보다 긴 문단은 제목 후보로 보지 않는다 (서명에만 쓴다) */
const HEADING_CANDIDATE_MAX = 24

export interface OutlineDeps {
  documents: DocumentRepository
  outlines: OutlineRepository
  models: ReviewModelSet
  online: OnlineStatus
  now: () => string
  /** 목차와 함께 짐작한 문서 종류 ([Q-48]). 사용자가 고친 값은 받는 쪽이 지킨다 */
  onKind?: (documentId: string, kind: string, modelId: string) => void
}

type Line = Pick<ParagraphChoice, 'paragraphId' | 'text' | 'hasContent'>

/** 모델에 보낼 내용. **무엇이 나가는지 이 함수 하나만 보면 된다** (`CLAUDE.md` §4). */
export function toOutlinePayload(subject: string | null, paragraphs: readonly Line[]): OutlinePayload {
  return {
    subject,
    lines: paragraphs.flatMap((paragraph, index) => {
      const text = paragraph.text.trim().replace(/\s+/g, ' ')
      if (!paragraph.hasContent || text === '') return []
      return [{ n: index + 1, text: text.length > OUTLINE_LINE_MAX ? `${text.slice(0, OUTLINE_LINE_MAX)}…` : text }]
    }),
  }
}

/**
 * 제목 후보들의 서명. 제목을 더하거나 바꾸면 달라지고, 본문·측정값만 고치면 그대로다.
 * 후보: 번호 제목("2. 이론적 배경") 과, 숫자 없고 문장으로 끝나지 않는 짧은 줄("고찰").
 * "176.70 g" 같은 값과 "…구했다." 같은 문장은 빼서
 * 값을 고칠 때마다 AI 를 다시 부르지 않게 한다.
 */
export function outlineSignature(paragraphs: readonly Line[]): string {
  return sha256Hex(JSON.stringify(paragraphs
    .map((paragraph) => paragraph.text.trim())
    .filter((text) => text !== '' && (headingLevel(text) !== null
      || (text.length <= HEADING_CANDIDATE_MAX && !/\d/.test(text) && !/[.다]$/.test(text))))))
}

function squeeze(text: string): string {
  return text.replace(/[\s.,·:;()[\]\-–—'"“”‘’?!]/g, '')
}

export type AnalyzeOutcome = { ok: true; count: number; modelId: string } | { ok: false; message: string }

export interface OutlineService {
  /** 검토 화면이 그릴 목차. 모델을 부르지 않는다 */
  view(documentId: string, paragraphs: readonly Line[]): OutlineView
  /** AI 로 목차를 나눠 저장한다. 사용자가 누르거나, 화면이 목차가 없거나 낡았을 때 부른다 */
  analyze(documentId: string): Promise<AnalyzeOutcome>
}

export function createOutlineService(deps: OutlineDeps): OutlineService {
  const { documents, outlines, models, online, now } = deps
  /** 문서마다 한 번에 하나만 */
  const running = new Map<string, Promise<AnalyzeOutcome>>()

  function ruleView(paragraphs: readonly Line[], status: OutlineView['status']): OutlineView {
    return { source: 'rule', status, modelId: null, nodes: buildOutline(ruleHeadings(paragraphs), paragraphs) }
  }

  /** 심층을 먼저, 없으면 빠른 모델. 어느 깊이에 무엇이 붙었는지는 `modelFor` 만 안다 */
  async function pickModel(): Promise<ReviewModel | { message: string }> {
    let message = '목차를 나눌 AI 연결이 없습니다.'
    for (const depth of ['deep', 'quick'] as const) {
      const model = modelFor(models, depth)
      if (model.analyzeOutline === undefined) continue
      const availability = await model.checkAvailability()
      if (availability.available) return model
      message = availability.message
    }
    return { message }
  }

  async function analyzeOnce(documentId: string): Promise<AnalyzeOutcome> {
    const document = documents.getDocument(documentId)
    if (document === null) return { ok: false, message: '등록되지 않은 문서입니다.' }
    const version = documents.latestVersion(documentId)
    if (version === null) return { ok: false, message: '아직 저장 기록이 없습니다.' }
    const rows = documents.listParagraphs(version.id)
    const paragraphs: Line[] = rows.map(({ uuid, paragraph }) => ({
      paragraphId: uuid, text: paragraph.text,
      hasContent: hasContent(paragraph),
    }))
    const payload = toOutlinePayload(document.subject, paragraphs)
    if (payload.lines.length === 0) return { ok: false, message: '아직 쓴 내용이 없습니다.' }
    if (!online.isOnline()) return { ok: false, message: '오프라인이라 번호 규칙으로 나눴습니다.' }

    const model = await pickModel()
    if (!('modelId' in model)) return { ok: false, message: model.message }
    const texts = paragraphs.map((paragraph) => paragraph.text)
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const call = await model.analyzeOutline!(payload)
      if (!call.ok) {
        if (call.reason === 'malformed') continue
        return { ok: false, message: call.message }
      }
      const marks: HeadingMark[] | null = parseOutline(call.text, texts)
      if (marks === null) continue
      outlines.save({
        documentId, signature: outlineSignature(paragraphs), modelId: model.modelId,
        promptVersion: OUTLINE_PROMPT_VERSION, createdAt: now(),
        items: marks.map((mark) => ({ paragraphUuid: paragraphs[mark.index]!.paragraphId, level: mark.level, title: mark.title })),
      })
      const kind = parseDocumentKind(call.text)
      if (kind !== '') deps.onKind?.(documentId, kind, model.modelId)
      return { ok: true, count: marks.length, modelId: model.modelId }
    }
    return { ok: false, message: 'AI 가 준 목차의 형식이 맞지 않아 번호 규칙으로 나눴습니다.' }
  }

  return {
    view(documentId, paragraphs): OutlineView {
      const stored = outlines.get(documentId)
      if (stored === null) return ruleView(paragraphs, 'missing')
      const position = new Map(paragraphs.map((paragraph, index) => [paragraph.paragraphId, index]))
      // 제목 문단이 지워졌으면 그 제목만 뺀다.
      // 제목 글이 바뀐 문단도 뺀다 (지금 글에 저장한 제목이 없다).
      const marks = stored.items.flatMap((item) => {
        const index = position.get(item.paragraphUuid)
        if (index === undefined || !squeeze(paragraphs[index]!.text).includes(squeeze(item.title))) return []
        return [{ index, level: item.level, title: item.title }]
      })
      if (marks.length === 0) return ruleView(paragraphs, 'stale')
      const fresh = stored.signature === outlineSignature(paragraphs) && marks.length === stored.items.length
      return { source: 'ai', status: fresh ? 'ready' : 'stale', modelId: stored.modelId,
        nodes: buildOutline(marks, paragraphs) }
    },

    analyze(documentId): Promise<AnalyzeOutcome> {
      const known = running.get(documentId)
      if (known !== undefined) return known
      const task = analyzeOnce(documentId).catch((cause: unknown): AnalyzeOutcome => {
        console.error('목차 분석 실패', cause)
        return { ok: false, message: '목차를 나누지 못해 번호 규칙으로 나눴습니다.' }
      }).finally(() => running.delete(documentId))
      running.set(documentId, task)
      return task
    },
  }
}
