/**
 * 평가 지침 초안 제안 (PRD 4.1의 보조 기능).
 *
 * 여기서 지키는 것
 * - **뼈대만 나간다.** 보고서 본문·파일 이름·문단 식별자는 외부로 보내지 않는다 (T-29, `CLAUDE.md` §4)
 * - **제안은 저장되지 않는다.** 확정 전 지침으로는 검토 AI 를 부르지 않는다 (T-5, `CLAUDE.md` §1)
 * - 오프라인·키 없음이면 **이 기능만** 막히고 직접 입력·확정은 그대로 된다 (T-33)
 * - 스키마를 어긴 응답은 정해진 횟수만 다시 묻고 실패로 알린다. 원문을 제안인 척 보여 주지 않는다 (T-27)
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReviewModel } from '../src/adapters/model/index.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createRubricRepository } from '../src/adapters/repo/rubric.js'
import { createRubricService } from '../src/app/rubric.js'
import { createModelRubricSuggester, parseRubricDraft, RUBRIC_DRAFT_ATTEMPTS } from '../src/app/rubric-suggest.js'
import { documentOutline } from '../src/core/rubric/outline.js'
import type { Paragraph } from '../src/core/document/model.js'
import { paragraphHash, paragraphUuid } from '../src/core/document/hash.js'
import { normalizeText } from '../src/core/document/normalize.js'

const MIGRATIONS = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')
const DOCUMENT = 'doc-1'
const BODY = '주사기에 공기를 넣고 온도를 20도에서 40도까지 바꾸며 압력을 읽었다.'

type Kind = 'heading' | 'body' | 'caption' | 'other'

function para(rawText: string, index: number,
  extra: { role?: Kind; headingLevel?: number | null; table?: Paragraph['table']; equations?: string[] } = {}): Paragraph {
  const text = normalizeText(rawText)
  const equations = extra.equations ?? []
  return {
    uuid: paragraphUuid({ sectionIndex: 0, index, text, equations }),
    index, sectionIndex: 0,
    role: extra.role ?? 'body',
    headingLevel: extra.headingLevel ?? null,
    styleName: extra.role === 'heading' ? '개요 1' : '바탕글',
    table: extra.table ?? null,
    rawText, text, equations,
    hash: paragraphHash({ text, equations }),
  }
}

/** 제목 · 본문 · 캡션 · 안내 문구 · 표가 섞인 보고서. */
function report(): Paragraph[] {
  return [
    para('1. 실험 목적', 0, { role: 'heading', headingLevel: 1 }),
    para('보일 법칙을 확인한다.', 1),
    para('2. 실험 방법', 2, { role: 'heading', headingLevel: 1 }),
    para(BODY, 3),
    para('측정 조건을 자세히 쓰시오.', 4),
    para('3. 결과', 5, { role: 'heading', headingLevel: 1 }),
    para('표 1. 온도에 따른 압력', 6, { role: 'caption' }),
    para('20', 7, { table: { tableIndex: 0, row: 0, col: 0 } }),
    para('101.3', 8, { table: { tableIndex: 0, row: 0, col: 1 } }),
    para('PV = nRT 로 정리된다.', 9, { equations: ['PV=nRT'] }),
  ]
}

const GOOD = JSON.stringify({
  items: [
    { title: '측정 조건 명시', description: '온도와 압력을 어떤 조건에서 읽었는지 밝혔는가', importance: 4 },
    { title: '표와 본문의 연결', description: '표의 값을 본문에서 해석했는가', importance: 3 },
  ],
})

describe('문서 뼈대 추출', () => {
  it('제목·캡션·안내 문구만 뽑고 본문과 표 값은 넣지 않는다', () => {
    const outline = documentOutline(report())
    expect(outline.entries.map((entry) => entry.kind))
      .toEqual(['heading', 'heading', 'guide', 'heading', 'caption'])
    expect(outline.entries[0]).toMatchObject({ text: '1. 실험 목적', level: 1 })
    const serialized = JSON.stringify(outline)
    expect(serialized).not.toContain('보일 법칙')
    expect(serialized).not.toContain(BODY)
    expect(serialized).not.toContain('101.3')
    expect(outline).toMatchObject({ tableCount: 1, equationCount: 1 })
  })

  it('표 안의 글과 긴 본문은 안내 문구로 오인하지 않는다', () => {
    const outline = documentOutline([
      para('빈칸을 채우시오.', 0, { table: { tableIndex: 0, row: 0, col: 0 } }),
      para(`${'가'.repeat(200)} 작성하시오.`, 1),
      para('결론을 서술하시오.', 2),
    ])
    expect(outline.entries).toEqual([{ kind: 'guide', level: null, text: '결론을 서술하시오.' }])
  })

  it('같은 입력에 같은 결과를 내고 입력을 바꾸지 않는다 (T-10)', () => {
    const paragraphs = report()
    const before = JSON.stringify(paragraphs)
    expect(documentOutline(paragraphs)).toEqual(documentOutline(paragraphs))
    expect(JSON.stringify(paragraphs)).toBe(before)
  })
})

describe('모델 응답 해석', () => {
  it('형식을 지킨 응답만 항목이 된다', () => {
    expect(parseRubricDraft(GOOD)).toHaveLength(2)
    expect(parseRubricDraft(GOOD)![0]).toMatchObject({ title: '측정 조건 명시', importance: 4 })
    // 설명과 중요도는 없으면 기본값으로 채운다.
    expect(parseRubricDraft(JSON.stringify({ items: [{ title: '항목' }] }))![0])
      .toMatchObject({ description: '', importance: 3 })
  })

  it('하나라도 어긋나면 통째로 버린다', () => {
    for (const text of [
      '초안을 만들어 드릴게요',
      '{}',
      JSON.stringify({ items: [] }),
      JSON.stringify({ items: [{ title: '' }] }),
      JSON.stringify({ items: [{ title: '항목', importance: 9 }] }),
      JSON.stringify({ items: [{ title: '항목', description: 7 }] }),
      JSON.stringify({ items: [{ title: 'x'.repeat(101) }] }),
      JSON.stringify({ items: Array.from({ length: 9 }, () => ({ title: '항목' })) }),
      // 하나만 어긋나도 나머지를 살리지 않는다.
      JSON.stringify({ items: [{ title: '좋은 항목' }, { title: '', importance: 3 }] }),
    ]) {
      expect(parseRubricDraft(text)).toBeNull()
    }
  })
})

describe('초안 제안 흐름', () => {
  let db: ReturnType<typeof openDatabase>['db']
  let documents: ReturnType<typeof createDocumentRepository>
  let rubric: ReturnType<typeof createRubricService>
  let online: boolean
  let suggest: ReturnType<typeof vi.fn<NonNullable<ReviewModel['suggestRubricDraft']>>>
  let model: ReviewModel

  beforeEach(() => {
    ;({ db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS }))
    documents = createDocumentRepository(db)
    online = true
    const now = (): string => new Date().toISOString()
    documents.createDocument({ id: DOCUMENT, path: `/tmp/${DOCUMENT}.hwpx`,
      displayName: `${DOCUMENT}.hwpx`, subject: '일반화학실험', createdAt: now() })
    const paragraphs = report()
    documents.appendVersion({ id: `${DOCUMENT}-v1`, documentId: DOCUMENT, detectedAt: now(),
      sourcePath: `/tmp/${DOCUMENT}.hwpx`, byteSize: 1, contentHash: 'bytes-1',
      paragraphs: paragraphs.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
      lineage: [], diffEntries: [], previousVersionId: null })

    suggest = vi.fn(() => Promise.resolve({ ok: true as const, text: GOOD }))
    model = {
      modelId: 'test/fake-model', promptVersion: 'quick-review.test',
      checkAvailability: () => Promise.resolve({ available: true }),
      review: () => Promise.resolve({ ok: false, reason: 'rejected', message: '이 테스트는 검토를 부르지 않는다' }),
      suggestRubricDraft: suggest,
    }
    rubric = createRubricService({ documents, rubrics: createRubricRepository(db),
      suggester: createModelRubricSuggester({ documents, model, online: { isOnline: () => online } }),
      now, newId: randomUUID })
  })
  afterEach(() => db.close())

  it('뼈대와 과목만 보내고 본문은 보내지 않는다 (T-29)', async () => {
    const result = await rubric.suggestDraft(DOCUMENT)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.items).toHaveLength(2)

    expect(suggest).toHaveBeenCalledTimes(1)
    const [outline, subject] = suggest.mock.calls[0]!
    expect(subject).toBe('일반화학실험')
    const sent = JSON.stringify([outline, subject])
    expect(sent).not.toContain(BODY)
    expect(sent).not.toContain('.hwpx')
    expect(sent).not.toContain(DOCUMENT)
  })

  it('제안은 저장되지 않는다. 확정 전에는 검토 AI 가 지침을 얻지 못한다 (T-5)', async () => {
    await rubric.suggestDraft(DOCUMENT)
    const editor = rubric.getEditor(DOCUMENT)
    if (!editor.ok) throw new Error(editor.message)
    expect(editor.state.draft).toBeNull()
    expect(editor.state.current).toBeNull()

    const gate = vi.fn(() => Promise.resolve('불렸다'))
    const gated = await rubric.withConfirmedRubric(DOCUMENT, gate)
    expect(gated.ok).toBe(false)
    expect(gate).not.toHaveBeenCalled()
  })

  it('오프라인이면 제안만 막히고 직접 확정은 그대로 된다 (T-33)', async () => {
    online = false
    const result = await rubric.suggestDraft(DOCUMENT)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('막았어야 한다')
    expect(result.message).toContain('오프라인')
    expect(suggest).not.toHaveBeenCalled()

    const confirmed = rubric.confirm(DOCUMENT,
      [{ itemId: null, title: '측정 조건', description: '', importance: 4 }])
    expect(confirmed.ok).toBe(true)
  })

  it('키가 없으면 그 이유를 그대로 알리고 부르지 않는다', async () => {
    model.checkAvailability = () => Promise.resolve({ available: false, reason: 'no-key', message: '키를 등록해 주세요.' })
    const result = await rubric.suggestDraft(DOCUMENT)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('막았어야 한다')
    expect(result.message).toBe('키를 등록해 주세요.')
    expect(suggest).not.toHaveBeenCalled()
  })

  it('형식을 어기면 정해진 횟수만 다시 묻고 원문을 보여 주지 않는다 (T-27)', async () => {
    suggest.mockResolvedValue({ ok: true, text: '초안입니다: 1) 측정 조건' })
    const result = await rubric.suggestDraft(DOCUMENT)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('막았어야 한다')
    expect(suggest).toHaveBeenCalledTimes(RUBRIC_DRAFT_ATTEMPTS)
    expect(result.message).not.toContain('측정 조건')
  })

  it('형식 문제만 다시 묻고 한도 초과는 곧바로 알린다', async () => {
    suggest.mockResolvedValueOnce({ ok: false, reason: 'malformed', message: '읽지 못했습니다' })
    suggest.mockResolvedValueOnce({ ok: false, reason: 'rate-limited', message: '요청 한도를 넘었습니다.' })
    const result = await rubric.suggestDraft(DOCUMENT)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('막았어야 한다')
    expect(result.message).toBe('요청 한도를 넘었습니다.')
    expect(suggest).toHaveBeenCalledTimes(2)
  })

  it('뼈대가 없으면 모델을 부르지 않고 직접 입력을 권한다', async () => {
    const empty = createModelRubricSuggester({ documents, model, online: { isOnline: () => true } })
    const result = await empty.suggest({ documentId: DOCUMENT, paragraphs: [para('그냥 줄글이다.', 0)] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('막았어야 한다')
    expect(result.message).toContain('직접 입력')
    expect(suggest).not.toHaveBeenCalled()
  })

  it('제안 기능이 없는 어댑터여도 나머지 지침 기능은 그대로다', async () => {
    const bare: ReviewModel = { modelId: model.modelId, promptVersion: model.promptVersion,
      checkAvailability: () => Promise.resolve({ available: true }),
      review: () => Promise.resolve({ ok: false, reason: 'rejected', message: '부르지 않는다' }) }
    const suggester = createModelRubricSuggester({ documents, model: bare, online: { isOnline: () => true } })
    const result = await suggester.suggest({ documentId: DOCUMENT, paragraphs: report() })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('막았어야 한다')
    expect(result.message).toContain('직접 입력')
  })

  it('모델이 형식은 지켰지만 내용 규칙을 어기면 코어 검증이 한 번 더 막는다', async () => {
    // 길이·중요도의 최종 판단은 prepareRubricItems 가 한다. 제안도 사용자 입력과 같은 문을 지난다.
    suggest.mockResolvedValue({ ok: true, text: JSON.stringify({ items: [{ title: '   ', description: '' }] }) })
    const result = await rubric.suggestDraft(DOCUMENT)
    expect(result.ok).toBe(false)
  })
})
