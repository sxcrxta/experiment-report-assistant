/**
 * 제출 점검 ([Q-48], 사용자 결정 2026-09-28).
 *
 * 평가 지침은 이제 **제출 양식·필수 내용 점검표**다. 사용자가 `점검하기` 를 누르면 AI 가 문서 전체를 읽고
 * 점검표의 항목마다 있음/부족/없음과 근거를 준다. 검토·다듬기와는 서로 참고하지 않는다.
 *
 * 지키는 것
 * - **누를 때만** 부른다. 저장할 때마다 부르지 않는다 (사용자 결정).
 * - 점검표는 **사용자가 확정한 것**만 쓴다. 확정 전 초안으로 AI 를 부르지 않는다 (`CLAUDE.md` §1).
 * - 나가는 것은 `toCheckPayload` 가 뽑은 것뿐이다: 점검표, 과목, 문서 종류, **글이 있는 문단 전부**,
 *   프로그램이 센 항목별 글자 수 ([Q-50]).
 * - 깊이는 `modelFor` 로 고른다. 심층(Claude Code)을 먼저, 없으면 빠른 모델.
 * - 형식을 어긴 응답은 정해진 횟수만 다시 묻고, 원문을 결과인 척 보여 주지 않는다.
 * - 문서·점검표가 바뀌면 지난 결과를 지우지 않고 **낡았다고** 알린다.
 */
import { modelFor, type ReviewModel, type ReviewModelSet } from '../adapters/model/index.js'
import type { OnlineStatus } from '../adapters/net/online.js'
import { CHECK_PROMPT_VERSION, parseCheck, type CheckPayload } from '../adapters/model/prompts/index.js'
import type { DocumentCheckRepository, StoredCheck } from '../adapters/repo/document-check.js'
import type { DocumentRepository } from '../adapters/repo/documents.js'
import { hasContent } from '../core/document/model.js'
import { levelOf, overallScore, scoreFromLegacyStatus, sectionStats, type SectionStat } from '../shared/check.js'
import type { OutlineNode } from '../shared/outline.js'

type ParagraphChoiceLike = { paragraphId: string; text: string; hasContent: boolean }
import type { RubricService } from './rubric.js'

const ATTEMPTS = 2

export interface DocumentCheckDeps {
  documents: DocumentRepository
  rubric: RubricService
  checks: DocumentCheckRepository
  models: ReviewModelSet
  online: OnlineStatus
  /** 문서 종류 ([Q-48]). 모르면 빈 문자열 */
  kindOf: (documentId: string) => string
  /** 목차 ([Q-47]). 항목별 글자 수를 세는 데 쓴다 ([Q-50]). 없으면 글자 수 없이 점검한다 */
  outlineOf?: (documentId: string, paragraphs: readonly ParagraphChoiceLike[]) => readonly OutlineNode[]
  now: () => string
}

export interface CheckView extends StoredCheck {
  /** 조건별 충족도의 평균 (0~100). 프로그램이 계산한다 */
  overall: number | null
  /** 점검한 뒤 문서가 새로 저장되었다 */
  documentChanged: boolean
  /** 점검한 뒤 점검표를 다시 확정했다 */
  checklistChanged: boolean
}

export type CheckOutcome = { ok: true; view: CheckView } | { ok: false; message: string }

/** 모델에 보낼 내용. **무엇이 나가는지 이 함수 하나만 보면 된다** (`CLAUDE.md` §4). */
export function toCheckPayload(input: {
  subject: string | null; kind: string
  items: readonly { title: string; description: string }[]
  paragraphs: readonly { text: string; written: boolean }[]
  /** 프로그램이 센 항목별 글자 수 ([Q-50]) */
  sections?: readonly SectionStat[]
}): CheckPayload {
  return {
    subject: input.subject,
    kind: input.kind,
    sections: [...(input.sections ?? [])],
    items: input.items.map((item, i) => ({ id: `C${i + 1}`, title: item.title, description: item.description })),
    paragraphs: input.paragraphs.flatMap((p, index) => p.written && p.text.trim() !== ''
      ? [{ n: index + 1, text: p.text.trim() }] : []),
  }
}

export function createDocumentCheckService(deps: DocumentCheckDeps): {
  get(documentId: string): CheckView | null
  run(documentId: string): Promise<CheckOutcome>
} {
  const { documents, rubric, checks, models, online, now } = deps
  const running = new Map<string, Promise<CheckOutcome>>()

  function viewOf(stored: StoredCheck): CheckView {
    const latest = documents.latestVersion(stored.documentId)
    const editor = rubric.getEditor(stored.documentId)
    const current = editor.ok ? editor.state.current?.rubricVersion ?? null : null
    // 예전(1판) 결과는 퍼센트가 없다. 구분에서 옮겨 보여 준다.
    const results = stored.results.map((result) => ({ ...result, score: result.score ?? scoreFromLegacyStatus(result.status) }))
    return { ...stored, results, overall: overallScore(results.map((result) => result.score)),
      documentChanged: latest !== null && latest.id !== stored.versionId,
      checklistChanged: current !== stored.rubricVersion }
  }

  async function pickModel(): Promise<ReviewModel | { message: string }> {
    let message = '점검할 AI 연결이 없습니다. 설정에서 키를 등록하거나 Claude Code 를 확인해 주세요.'
    for (const depth of ['deep', 'quick'] as const) {
      const model = modelFor(models, depth)
      if (model.checkSubmission === undefined) continue
      const availability = await model.checkAvailability()
      if (availability.available) return model
      message = availability.message
    }
    return { message }
  }

  async function runOnce(documentId: string): Promise<CheckOutcome> {
    const document = documents.getDocument(documentId)
    if (document === null) return { ok: false, message: '등록되지 않은 문서입니다.' }
    const version = documents.latestVersion(documentId)
    if (version === null) return { ok: false, message: '아직 저장 기록이 없습니다.' }
    const editor = rubric.getEditor(documentId)
    const checklist = editor.ok ? editor.state.current : null
    if (checklist === null) return { ok: false, message: '점검표를 먼저 확정해 주세요. 모음에서 골라 적용하면 됩니다.' }

    const rows = documents.listParagraphs(version.id)
    const paragraphs = rows.map(({ paragraph }) => ({ text: paragraph.text, written: hasContent(paragraph) }))
    // 글자 수는 프로그램이 센다 ([Q-50]). "고찰 부분은 200자 이상" 같은 조건을 AI 가 세다 틀리지 않게.
    const choices = rows.map(({ uuid, paragraph }) => ({ paragraphId: uuid, text: paragraph.text, hasContent: hasContent(paragraph) }))
    const sections = sectionStats(deps.outlineOf?.(documentId, choices) ?? [], choices)
    const payload = toCheckPayload({ subject: document.subject, kind: deps.kindOf(documentId),
      items: checklist.items, paragraphs, sections })
    if (payload.paragraphs.length === 0) return { ok: false, message: '아직 쓴 내용이 없습니다.' }
    if (!online.isOnline()) return { ok: false, message: '오프라인이라 점검할 수 없습니다.' }

    const model = await pickModel()
    if (!('modelId' in model)) return { ok: false, message: model.message }
    const ids = payload.items.map((item) => item.id)
    const numbers = new Set(payload.paragraphs.map((p) => p.n))
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const call = await model.checkSubmission!(payload)
      if (!call.ok) {
        if (call.reason === 'malformed') continue
        return { ok: false, message: call.message }
      }
      const results = parseCheck(call.text, ids, numbers)
      if (results === null) continue
      const stored: StoredCheck = {
        documentId, versionId: version.id, rubricVersion: checklist.rubricVersion, modelId: model.modelId,
        promptVersion: CHECK_PROMPT_VERSION, createdAt: now(),
        results: results.map((result, i) => ({
          itemId: checklist.items[i]!.itemId, title: checklist.items[i]!.title,
          score: result.score, status: levelOf(result.score),
          evidence: result.evidence, paragraphNumbers: result.paragraphs,
        })),
      }
      checks.save(stored)
      return { ok: true, view: viewOf(stored) }
    }
    return { ok: false, message: 'AI 가 준 점검 결과의 형식이 맞지 않았습니다. 다시 눌러 주세요.' }
  }

  return {
    get(documentId): CheckView | null {
      const stored = checks.get(documentId)
      return stored === null ? null : viewOf(stored)
    },
    run(documentId): Promise<CheckOutcome> {
      const known = running.get(documentId)
      if (known !== undefined) return known
      const task = runOnce(documentId).catch((cause: unknown): CheckOutcome => {
        console.error('제출 점검 실패', cause)
        return { ok: false, message: '점검하지 못했습니다. 다시 시도해 주세요.' }
      }).finally(() => running.delete(documentId))
      running.set(documentId, task)
      return task
    },
  }
}
