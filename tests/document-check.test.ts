/**
 * 제출 점검과 문서 종류 ([Q-48]).
 *
 * 지키는 것
 * - 점검은 사용자가 **확정한 점검표**로만 한다. 초안으로 AI 를 부르지 않는다 (`CLAUDE.md` §1)
 * - 점검표 항목마다 정확히 하나의 결과가 있어야 받는다. 없는 문단 번호는 버린다
 * - 나가는 것은 점검표·과목·문서 종류·글이 있는 문단뿐이다 (`CLAUDE.md` §4 예외 5)
 * - 심층(Claude)을 먼저, 없으면 빠른 모델. 둘 다 없거나 오프라인이면 부르지 않는다
 * - 문서·점검표가 바뀌면 지난 결과를 지우지 않고 낡았다고 알린다
 * - 문서 종류는 AI 가 짐작하되, 사용자가 고친 값은 덮지 않는다
 */
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ModelCallResult, ReviewModel, ReviewModelSet } from '../src/adapters/model/index.js'
import { parseCheck } from '../src/adapters/model/prompts/check.v2.js'
import { levelOf, overallScore, sectionStats } from '../src/shared/check.js'
import { buildOutline, ruleHeadings } from '../src/shared/outline.js'
import { renderCheckPrompt as renderCheckPromptV3 } from '../src/adapters/model/prompts/check.v3.js'
import { parseDocumentKind, renderOutlinePrompt } from '../src/adapters/model/prompts/outline.v2.js'
import { createDocumentCheckRepository } from '../src/adapters/repo/document-check.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createReviewContextRepository } from '../src/adapters/repo/review-context.js'
import { createRubricRepository } from '../src/adapters/repo/rubric.js'
import { createDocumentCheckService, toCheckPayload } from '../src/app/document-check.js'
import { createReviewContextService } from '../src/app/review-context.js'
import { createRubricService, UNAVAILABLE_SUGGESTER } from '../src/app/rubric.js'

import { makeParagraphs } from './helpers/paragraphs.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')

describe('점검 응답 검사 (2판 — 조건마다 충족도 %, [Q-49])', () => {
  const ids = ['C1', 'C2']
  const numbers = new Set([1, 2, 3])
  const reply = (results: unknown[]): string => JSON.stringify({ results })

  it('조건마다 퍼센트 하나씩 받고, 없는 문단 번호는 버린다', () => {
    expect(parseCheck(reply([
      { item: 'C2', score: 0, evidence: '없다', paragraphs: [] },
      { item: 'C1', score: 60, evidence: '  5개 중   3개 ', paragraphs: [1, 99, 1] },
    ]), ids, numbers)).toEqual([
      { item: 'C1', score: 60, evidence: '5개 중 3개', paragraphs: [1] },
      { item: 'C2', score: 0, evidence: '없다', paragraphs: [] },
    ])
  })

  it('조건이 빠지거나 겹치거나, 퍼센트가 0~100 정수가 아니거나, 근거가 비면 받지 않는다', () => {
    const ok = { item: 'C1', score: 100, evidence: '있다', paragraphs: [] }
    expect(parseCheck(reply([ok]), ids, numbers)).toBeNull()
    expect(parseCheck(reply([ok, ok]), ids, numbers)).toBeNull()
    for (const score of [101, -1, 55.5, '80']) {
      expect(parseCheck(reply([ok, { ...ok, item: 'C2', score }]), ids, numbers)).toBeNull()
    }
    expect(parseCheck(reply([ok, { ...ok, item: 'C2', evidence: ' ' }]), ids, numbers)).toBeNull()
    expect(parseCheck(reply([ok, { item: 'C2', status: 'met', evidence: '있다', paragraphs: [] }]), ids, numbers)).toBeNull()
  })
})

describe('충족도 계산은 프로그램이 한다', () => {
  it('100 만 충족, 0 은 미충족, 그 사이는 일부 충족', () => {
    expect([100, 99, 1, 0].map(levelOf)).toEqual(['met', 'partial', 'partial', 'missing'])
  })

  it('전체 충족도는 조건별 퍼센트의 평균(반올림)이다', () => {
    expect(overallScore([100, 60, 0])).toBe(53)
    expect(overallScore([])).toBeNull()
  })
})

describe('문서 종류 짐작 (목차 2판)', () => {
  it('목차와 함께 종류를 묻고, 응답에서 종류를 꺼낸다', () => {
    expect(renderOutlinePrompt({ subject: null, lines: [{ n: 1, text: '서론' }] })).toContain('"kind"')
    expect(parseDocumentKind('{"kind":" 실험 보고서 —  몰질량 ","items":[]}')).toBe('실험 보고서 — 몰질량')
    expect(parseDocumentKind('형식 없음')).toBe('')
  })

  it('사용자가 고친 종류는 AI 가 다시 짐작해도 덮지 않는다', () => {
    const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })
    const documents = createDocumentRepository(db)
    documents.createDocument({ id: 'd', path: '/tmp/d.hwpx', displayName: 'd.hwpx', subject: null, createdAt: 'now' })
    const context = createReviewContextService({ repo: createReviewContextRepository(db), now: () => 'now' })
    context.saveGuess('d', '실험 보고서', 'opus')
    expect(context.profile('d')).toMatchObject({ kind: '실험 보고서', source: 'ai' })
    expect(context.setKind('d', '대회 참가 신청서')).toEqual({ ok: true })
    context.saveGuess('d', '실험 보고서', 'opus')
    expect(context.kindOf('d')).toBe('대회 참가 신청서')
    expect(context.setKind('d', '  ').ok).toBe(false)
    db.close()
  })
})

function fakeModel(modelId: string, replies: ModelCallResult[], available = true): ReviewModel & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    modelId, promptVersion: 'x', calls,
    checkAvailability: () => Promise.resolve(available ? { available: true }
      : { available: false, reason: 'not-installed', message: 'Claude Code 를 찾지 못했습니다.' }),
    review: () => Promise.reject(new Error('검토를 부르면 안 됩니다')),
    checkSubmission: (payload) => {
      calls.push(payload)
      return Promise.resolve(replies.shift() ?? { ok: false, reason: 'server-error', message: '더 없음' })
    },
  }
}

function harness(models: ReviewModelSet, options: { online?: boolean; confirm?: boolean; outline?: boolean } = {}) {
  const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })
  const documents = createDocumentRepository(db)
  documents.createDocument({ id: 'd', path: '/tmp/d.hwpx', displayName: 'd.hwpx', subject: '화학', createdAt: 'now' })
  let versions = 0
  const save = (texts: string[]): void => {
    versions += 1
    const paragraphs = makeParagraphs(texts)
    documents.appendVersion({ id: `v${versions}`, documentId: 'd', detectedAt: 'now', sourcePath: '/tmp/d.hwpx',
      byteSize: 1, contentHash: `h${versions}`, paragraphs: paragraphs.map((p) => ({ uuid: p.uuid, paragraph: p })),
      lineage: [], diffEntries: [], previousVersionId: versions === 1 ? null : `v${versions - 1}` })
  }
  save(['1. 실험 목적', '몰질량을 구한다.', ''])
  let n = 0
  const rubric = createRubricService({ documents, rubrics: createRubricRepository(db), suggester: UNAVAILABLE_SUGGESTER,
    now: () => 'now', newId: () => `item-${(n += 1)}` })
  const items = [{ itemId: null, title: '실험 목적', description: '목적을 한 문장으로', importance: 3 },
    { itemId: null, title: '참고문헌', description: '', importance: 3 }]
  if (options.confirm !== false) rubric.confirm('d', items)
  else rubric.saveDraft('d', items)
  const service = createDocumentCheckService({ documents, rubric, checks: createDocumentCheckRepository(db), models,
    online: { isOnline: () => options.online ?? true }, kindOf: () => '실험 보고서', now: () => 'now',
    ...(options.outline === true
      ? { outlineOf: (_id: string, ps: readonly { paragraphId: string; text: string; hasContent: boolean }[]) =>
        buildOutline(ruleHeadings(ps), ps) }
      : {}) })
  return { service, save, rubric, items, db }
}

const GOOD: ModelCallResult = { ok: true, text: JSON.stringify({ results: [
  { item: 'C1', score: 100, evidence: '1번 제목 아래 목적이 있다.', paragraphs: [2] },
  { item: 'C2', score: 30, evidence: '참고문헌이 1개뿐이다.', paragraphs: [] },
] }) }

describe('제출 점검 서비스', () => {
  it('Claude 를 먼저 써서 점검하고, 결과를 항목 이름과 함께 저장한다', async () => {
    const deep = fakeModel('opus', [GOOD])
    const quick = fakeModel('gemma', [])
    const h = harness({ quick, deep })
    const result = await h.service.run('d')
    expect(result).toMatchObject({ ok: true, view: { modelId: 'opus', documentChanged: false, checklistChanged: false,
      overall: 65,
      results: [{ title: '실험 목적', score: 100, status: 'met', paragraphNumbers: [2] },
        { title: '참고문헌', score: 30, status: 'partial' }] } })
    expect(quick.calls).toEqual([])
    expect(h.service.get('d')?.results).toHaveLength(2)
  })

  it('나가는 것은 점검표·과목·문서 종류·글이 있는 문단과 프로그램이 센 글자 수뿐이다', async () => {
    const deep = fakeModel('opus', [GOOD])
    const h = harness({ quick: fakeModel('gemma', []), deep })
    await h.service.run('d')
    expect(deep.calls[0]).toEqual({ subject: '화학', kind: '실험 보고서', sections: [],
      items: [{ id: 'C1', title: '실험 목적', description: '목적을 한 문장으로' }, { id: 'C2', title: '참고문헌', description: '' }],
      paragraphs: [{ n: 1, text: '1. 실험 목적' }, { n: 2, text: '몰질량을 구한다.' }] })
    expect(toCheckPayload({ subject: null, kind: '', items: [], paragraphs: [{ text: '', written: false }] }).paragraphs).toEqual([])
  })

  it('점검표를 확정하지 않았으면 부르지 않는다', async () => {
    const deep = fakeModel('opus', [GOOD])
    const h = harness({ quick: fakeModel('gemma', []), deep }, { confirm: false })
    expect(await h.service.run('d')).toMatchObject({ ok: false })
    expect(deep.calls).toEqual([])
  })

  it('Claude 가 없으면 빠른 모델로, 형식을 어기면 한 번 더 묻는다. 오프라인이면 부르지 않는다', async () => {
    const quick = fakeModel('gemma', [{ ok: true, text: '{"results":[]}' }, GOOD])
    const h = harness({ quick, deep: fakeModel('opus', [], false) })
    expect(await h.service.run('d')).toMatchObject({ ok: true, view: { modelId: 'gemma' } })
    expect(quick.calls).toHaveLength(2)
    const offline = fakeModel('gemma', [GOOD])
    expect(await harness({ quick: offline, deep: offline }, { online: false }).service.run('d')).toMatchObject({ ok: false })
    expect(offline.calls).toEqual([])
  })

  it('문서를 다시 저장하거나 점검표를 바꾸면 지난 결과를 남긴 채 낡았다고 알린다', async () => {
    const h = harness({ quick: fakeModel('gemma', []), deep: fakeModel('opus', [GOOD]) })
    await h.service.run('d')
    h.save(['1. 실험 목적', '몰질량을 다시 구한다.'])
    expect(h.service.get('d')).toMatchObject({ documentChanged: true, checklistChanged: false })
    h.rubric.confirm('d', [...h.items, { itemId: null, title: '그림 설명', description: '', importance: 3 }])
    expect(h.service.get('d')).toMatchObject({ documentChanged: true, checklistChanged: true })
  })

  it('검토 맥락 행은 평가 지침 목록·최신 지침에 나오지 않는다', () => {
    const h = harness({ quick: fakeModel('gemma', []), deep: fakeModel('opus', []) })
    const context = createReviewContextService({ repo: createReviewContextRepository(h.db), now: () => 'now' })
    context.versionOf('d')
    const editor = h.rubric.getEditor('d')
    if (!editor.ok) throw new Error('지침을 읽지 못했습니다')
    expect(editor.state.history).toHaveLength(1)
    expect(editor.state.current?.ordinal).toBe(1)
  })
})

describe('예전(1판) 점검 결과', () => {
  it('퍼센트가 없으면 구분에서 옮겨 보여 준다 (충족 100 · 부족 50 · 없음 0)', () => {
    const h = harness({ quick: fakeModel('gemma', []), deep: fakeModel('opus', []) })
    const editor = h.rubric.getEditor('d')
    if (!editor.ok || editor.state.current === null) throw new Error('확정 지침이 없습니다')
    createDocumentCheckRepository(h.db).save({ documentId: 'd', versionId: 'v1', rubricVersion: editor.state.current.rubricVersion,
      modelId: 'opus', promptVersion: 'check.v1', createdAt: 'now', results: [
        { itemId: 'a', title: '실험 목적', status: 'met', evidence: '있다', paragraphNumbers: [] },
        { itemId: 'b', title: '참고문헌', status: 'partial', evidence: '모자라다', paragraphNumbers: [] },
      ] })
    expect(h.service.get('d')).toMatchObject({ overall: 75, results: [{ score: 100 }, { score: 50 }] })
  })
})

describe('글자 수는 프로그램이 센다 ([Q-50])', () => {
  const paragraphs = ['1. 실험 목적', '몰질량을 구한다.', '2. 고찰', '오차가 컸다.', '가. 온도', '늦게 쟀다.', '3. 결론', '끝']
    .map((text, i) => ({ paragraphId: `p${i + 1}`, text, hasContent: true }))
  const tree = buildOutline(ruleHeadings(paragraphs), paragraphs)

  it('항목마다 제목 줄을 빼고 세고, 하위 항목의 글은 윗항목에도 들어간다', () => {
    const stats = sectionStats(tree, paragraphs)
    expect(stats.map((s) => [s.title, s.from, s.to, s.chars, s.charsNoSpace])).toEqual([
      ['1. 실험 목적', 1, 2, 9, 8],
      ['2. 고찰', 3, 6, 18, 15],
      ['가. 온도', 5, 6, 6, 5],
      ['3. 결론', 7, 8, 1, 1],
    ])
  })

  it('점검 프롬프트(3판)에 항목별 글자 수를 싣고 직접 세지 말라고 적는다', () => {
    const prompt = renderCheckPromptV3({ subject: null, kind: '', sections: sectionStats(tree, paragraphs),
      items: [{ id: 'C1', title: '고찰 부분은 200자 이상이어야 한다.', description: '' }],
      paragraphs: paragraphs.map((p, i) => ({ n: i + 1, text: p.text })) })
    expect(prompt).toContain('- 2. 고찰 (문단 3~6): 공백 포함 18자, 공백 제외 15자')
    expect(prompt).toContain('  - 가. 온도 (문단 5~6)')
    expect(prompt).toContain('직접 세지 마세요')
    expect(prompt.indexOf('항목별 글자 수')).toBeLessThan(prompt.indexOf('\n문서:\n'))
  })

  it('점검할 때 목차가 있으면 글자 수를 함께 보낸다', async () => {
    const deep = fakeModel('opus', [GOOD])
    const h = harness({ quick: fakeModel('gemma', []), deep }, { outline: true })
    await h.service.run('d')
    expect((deep.calls[0] as { sections: unknown[] }).sections).toEqual([
      { title: '1. 실험 목적', level: 1, from: 1, to: 3, chars: 9, charsNoSpace: 8 },
    ])
  })
})
