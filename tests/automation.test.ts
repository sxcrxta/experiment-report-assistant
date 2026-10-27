/**
 * 손이 덜 가게 만든 것들 ([Q-37]).
 *
 * 여기서 지키는 것 — **줄인 것은 손길이고, 사용자의 결정권이 아니다.**
 * - 지침 초안은 프로그램이 채워 두지만 **확정은 사용자가 한다.** 사용자가 쓴 것을 덮지 않는다.
 * - 관점·단계 기본값은 프로그램이 정한다 (AI 가 아니다). 사용자가 손대면 그때부터 사용자 것이다.
 * - 변경된 문단 고르기는 Diff 가 아는 것을 그대로 쓴다.
 */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { perspectivesForRubric, perspectivesForRubricItem, rubricSkeleton, SKELETON_MAX_ITEMS } from '../src/core/rubric/skeleton.js'
import { documentOutline } from '../src/core/rubric/outline.js'
import { createRubricService, UNAVAILABLE_SUGGESTER, type RubricDraftSuggester } from '../src/app/rubric.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { createRubricRepository } from '../src/adapters/repo/rubric.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import type { Paragraph } from '../src/core/document/model.js'
import { REVIEW_PERSPECTIVES } from '../src/shared/review.js'

function paragraph(text: string, overrides: Partial<Paragraph> = {}): Paragraph {
  return {
    uuid: `u-${text}`, index: 0, sectionIndex: 0, role: 'body', headingLevel: null, styleName: null,
    table: null, rawText: text, text, equations: [], hash: `h-${text}`, ...overrides,
  }
}

function heading(text: string, level = 1): Paragraph {
  return paragraph(text, { role: 'heading', headingLevel: level })
}

describe('지침 초안 뼈대 — 문서 구조에서 결정론으로', () => {
  it('제목을 항목으로 쓰고 아는 항목에는 확인할 것을 채워 준다', () => {
    const items = rubricSkeleton(documentOutline([
      heading('1. 실험 목적'), paragraph('몰질량을 구한다.'),
      heading('2. 실험 결과'), paragraph('측정값을 적었다.'),
      heading('3. 고찰'), paragraph('오차를 논의했다.'),
    ]))
    expect(items.map(item => item.title)).toEqual(['실험 목적', '실험 결과', '고찰'])
    // 아는 항목이면 설명과 중요도가 채워진다. 결과·고찰이 가장 무겁다.
    expect(items[1]?.importance).toBe(5)
    expect(items[2]?.description).toContain('근거')
    expect(items.every(item => item.title !== '')).toBe(true)
  })

  it('모르는 제목은 이름만 쓰고 설명은 비운다 (지어내지 않는다)', () => {
    const items = rubricSkeleton(documentOutline([heading('가나다 특별 항목'), paragraph('본문')]))
    expect(items).toEqual([{ title: '가나다 특별 항목', description: '', importance: 3 }])
  })

  it('표가 있는데 다루는 항목이 없으면 표·그림 항목을 보탠다', () => {
    const items = rubricSkeleton(documentOutline([
      heading('실험 목적'),
      paragraph('칸', { table: { tableIndex: 0, row: 0, col: 0 } }),
    ]))
    expect(items.map(item => item.title)).toContain('표·그림 설명')
  })

  it('제목이 없는 문서에도 시작점을 준다 (빈 초안을 주지 않는다)', () => {
    // 실제 보고서가 전체를 표 하나로 만들면 제목이 0개로 읽힌다 ([Q-27]).
    const items = rubricSkeleton(documentOutline([paragraph('제목 없이 본문만 있다.')]))
    expect(items.map(item => item.title)).toEqual(['실험 목적', '실험 과정', '실험 결과', '고찰'])
    expect(items.every(item => item.description !== '')).toBe(true)
  })

  it('제목이 없고 표만 있으면 표 항목까지 함께 준다', () => {
    const items = rubricSkeleton(documentOutline([
      paragraph('칸', { table: { tableIndex: 0, row: 0, col: 0 } }),
    ]))
    expect(items.map(item => item.title))
      .toEqual(['실험 목적', '실험 과정', '실험 결과', '고찰', '표·그림 설명'])
  })

  it('항목 수를 묶는다 (읽고 고치는 것이 또 하나의 일이 되지 않게)', () => {
    const many = Array.from({ length: 30 }, (_, at) => heading(`${at + 1}. 항목 ${at + 1}`))
    expect(rubricSkeleton(documentOutline(many)).length).toBeLessThanOrEqual(SKELETON_MAX_ITEMS)
  })

  it('항목 이름에서 관점을 읽는다. 못 읽으면 빈 배열이다', () => {
    expect(perspectivesForRubricItem('고찰')).toEqual(['logic'])
    expect(perspectivesForRubricItem('표·그림 설명')).toEqual(['figures'])
    expect(perspectivesForRubricItem('참고문헌')).toEqual(['references'])
    expect(perspectivesForRubricItem('실험 결과')).toEqual(['scientific_accuracy', 'logic'])
    expect(perspectivesForRubricItem('가나다')).toEqual([])
  })
})

function rubricHarness(suggester: RubricDraftSuggester = UNAVAILABLE_SUGGESTER) {
  const { db } = openDatabase({
    file: ':memory:', migrationsDir: join(import.meta.dirname, '../src/adapters/repo/migrations'),
  })
  const documents = createDocumentRepository(db)
  documents.createDocument({ id: 'd', path: '/보고서.hwpx', displayName: '보고서.hwpx', createdAt: 'now', subject: '화학' })
  let seq = 0
  const service = createRubricService({
    documents, rubrics: createRubricRepository(db), suggester,
    now: () => '2026-09-18T00:00:00.000Z', newId: () => `id-${++seq}`,
  })
  return { db, service }
}

describe('문서를 등록하면 지침 초안이 채워져 있다', () => {
  const paragraphs = [heading('1. 실험 목적'), paragraph('몰질량을 구한다.'), heading('2. 고찰')]

  it('AI 없이도 초안이 만들어진다. 확정은 사용자가 한다', async () => {
    const h = rubricHarness()
    try {
      await h.service.prepareDraft('d', paragraphs)
      const editor = h.service.getEditor('d')
      expect(editor.ok).toBe(true)
      if (!editor.ok) return
      expect(editor.state.draft?.items.map(item => item.title)).toEqual(['실험 목적', '고찰'])
      // 채워 두기만 한다. 확정하지 않았으므로 AI 검토는 여전히 잠겨 있다 (PRD 4.1).
      expect(editor.state.current).toBeNull()
    } finally { h.db.close() }
  })

  it('AI 를 쓸 수 있으면 그 뼈대를 다듬어 바꿔 넣는다', async () => {
    const h = rubricHarness({
      suggest: () => Promise.resolve({ ok: true, items: [
        { title: '실험 목적의 분명함', description: 'AI 가 다듬은 설명', importance: 4 },
      ] }),
    })
    try {
      await h.service.prepareDraft('d', paragraphs)
      const editor = h.service.getEditor('d')
      if (!editor.ok) throw new Error('편집기를 읽지 못했다')
      expect(editor.state.draft?.items.map(item => item.title)).toEqual(['실험 목적의 분명함'])
    } finally { h.db.close() }
  })

  it('사용자가 이미 쓴 초안은 덮지 않는다', async () => {
    const h = rubricHarness()
    try {
      h.service.saveDraft('d', [{ itemId: null, title: '내가 쓴 항목', description: '', importance: 3 }])
      await h.service.prepareDraft('d', paragraphs)
      const editor = h.service.getEditor('d')
      if (!editor.ok) throw new Error('편집기를 읽지 못했다')
      expect(editor.state.draft?.items.map(item => item.title)).toEqual(['내가 쓴 항목'])
    } finally { h.db.close() }
  })

  it('이미 확정한 지침이 있으면 손대지 않는다', async () => {
    const h = rubricHarness()
    try {
      h.service.confirm('d', [{ itemId: null, title: '확정한 항목', description: '', importance: 3 }])
      await h.service.prepareDraft('d', paragraphs)
      const editor = h.service.getEditor('d')
      if (!editor.ok) throw new Error('편집기를 읽지 못했다')
      expect(editor.state.current?.items.map(item => item.title)).toEqual(['확정한 항목'])
      expect(editor.state.draft?.items ?? []).toEqual([])
    } finally { h.db.close() }
  })

  it('다듬는 동안 사용자가 고쳤으면 AI 결과로 덮지 않는다', async () => {
    let release: () => void = () => undefined
    const waiting = new Promise<void>(resolve => { release = resolve })
    const h = rubricHarness({
      suggest: async () => {
        await waiting
        return { ok: true, items: [{ title: 'AI 항목', description: '', importance: 3 }] }
      },
    })
    try {
      const pending = h.service.prepareDraft('d', paragraphs)
      // 뼈대가 저장된 뒤, AI 응답이 오기 전에 사용자가 고친다.
      h.service.saveDraft('d', [{ itemId: null, title: '사용자가 고친 항목', description: '', importance: 3 }])
      release()
      await pending
      const editor = h.service.getEditor('d')
      if (!editor.ok) throw new Error('편집기를 읽지 못했다')
      expect(editor.state.draft?.items.map(item => item.title)).toEqual(['사용자가 고친 항목'])
    } finally { h.db.close() }
  })
})

describe('관점은 지침 전체에서 프로그램이 정한다 ([Q-41])', () => {
  it('모든 항목의 관점을 합치고, PRD 4.2 순서로 둔다', () => {
    expect(perspectivesForRubric([{ title: '고찰' }, { title: '표·그림 설명' }, { title: '실험 결과' }]))
      .toEqual(['figures', 'scientific_accuracy', 'logic'])
  })

  it('관점을 읽지 못한 항목이 하나라도 있으면 모든 관점으로 본다 (그 항목의 피드백이 버려지지 않게)', () => {
    expect(perspectivesForRubric([{ title: '고찰' }, { title: '가나다' }])).toEqual([...REVIEW_PERSPECTIVES])
  })

  it('항목이 없으면 모든 관점이다', () => {
    expect(perspectivesForRubric([])).toEqual([...REVIEW_PERSPECTIVES])
  })

  it('같은 지침이면 언제나 같은 결과다 (캐시 키가 흔들리지 않는다)', () => {
    const items = [{ title: '실험 결과' }, { title: '고찰' }]
    expect(perspectivesForRubric(items)).toEqual(perspectivesForRubric([...items]))
  })
})

/** 화면 쪽 동작은 `review-panel.test.ts` 가 함께 본다. 여기서는 대역 없이 되는 것만 본다. */
describe('AI 를 쓰지 않는다', () => {
  it('뼈대 함수는 모델을 부르지 않는다 (같은 입력에 같은 출력)', () => {
    const outline = documentOutline([heading('실험 결과'), paragraph('값')])
    expect(rubricSkeleton(outline)).toEqual(rubricSkeleton(outline))
    vi.stubGlobal('fetch', () => { throw new Error('부르면 안 된다') })
    expect(() => rubricSkeleton(outline)).not.toThrow()
    vi.unstubAllGlobals()
  })
})
