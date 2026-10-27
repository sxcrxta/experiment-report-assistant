/**
 * 보고서 목차 ([Q-47]).
 *
 * 지키는 것
 * - AI 는 "어느 문단이 제목이고 몇 급인지" 만 제안한다. 범위는 `buildOutline` 이 정한다 (`CLAUDE.md` §2)
 * - 응답은 검사한다: 없는·빈·순서가 어긋난 문단은 버리고, 문단에 없는 제목 이름은 쓰지 않는다
 * - 깊이는 `modelFor` 로: 심층(Claude)을 먼저, 없으면 빠른 모델, 그것도 없으면 번호 규칙
 * - 나가는 것은 글이 있는 문단의 번호와 앞 60자, 과목뿐이다 (`CLAUDE.md` §4)
 * - 제목이 바뀌면 낡은 목차라고 알린다. 본문만 고치면 그대로다
 */
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ModelCallResult, ReviewModel, ReviewModelSet } from '../src/adapters/model/index.js'
import { parseOutline } from '../src/adapters/model/prompts/outline.v1.js'
import { hwpxReader } from '../src/adapters/hwpx/index.js'
import type { DocumentRepository } from '../src/adapters/repo/documents.js'
import type { OutlineRepository, StoredOutline } from '../src/adapters/repo/outline.js'
import { createOutlineService, toOutlinePayload } from '../src/app/document-outline.js'
import type { Paragraph } from '../src/core/document/model.js'
import { buildOutline, ruleHeadings, type OutlineNode } from '../src/shared/outline.js'

const line = (text: string, i: number) => ({ paragraphId: `p${i + 1}`, text, hasContent: text.trim() !== '' })

describe('목차 나무 (범위는 프로그램이 정한다)', () => {
  const paragraphs = ['1. 목적', '내용', '2. 배경', '가. 첫째', 'a', '나. 둘째', 'b', '3. 결론', 'c'].map(line)

  it('다음의 같은 급·윗급 제목 직전까지를 한 항목으로, 아랫급은 자식으로 둔다', () => {
    const tree = buildOutline(ruleHeadings(paragraphs), paragraphs)
    const shape = (nodes: OutlineNode[]): unknown => nodes.map((n) => [n.title, n.paragraphIds, shape(n.children)])
    expect(shape(tree)).toEqual([
      ['1. 목적', ['p1', 'p2'], []],
      ['2. 배경', ['p3', 'p4', 'p5', 'p6', 'p7'], [
        ['가. 첫째', ['p4', 'p5'], []],
        ['나. 둘째', ['p6', 'p7'], []],
      ]],
      ['3. 결론', ['p8', 'p9'], []],
    ])
  })

  it('급이 건너뛰어도 가까운 윗항목 밑에 두고, 같은 문단을 두 번 쓰지 않는다', () => {
    const tree = buildOutline([{ index: 0, level: 1, title: 'A' }, { index: 1, level: 3, title: 'B' },
      { index: 1, level: 2, title: 'B 또' }], paragraphs.slice(0, 3))
    expect(tree).toHaveLength(1)
    expect(tree[0]!.children.map((n) => n.title)).toEqual(['B'])
  })
})

describe('AI 응답 검사', () => {
  const texts = ['실험 주제', '서론', '이 실험은 …', '결과와 고찰', '값이 컸다', '']

  it('번호 제목이 없는 보고서도 AI 가 고른 제목을 받는다', () => {
    const marks = parseOutline(JSON.stringify({ items: [
      { n: 2, level: 1, title: '서론' }, { n: 4, level: 1, title: '결과와 고찰' },
    ] }), texts)
    expect(marks).toEqual([{ index: 1, level: 1, title: '서론' }, { index: 3, level: 1, title: '결과와 고찰' }])
  })

  it('없는·빈·거꾸로 된 문단은 버리고, 문단에 없는 이름은 문단 글로 바꾼다', () => {
    const marks = parseOutline(JSON.stringify({ items: [
      { n: 4, level: 2, title: '지어낸 제목' }, { n: 2, level: 2, title: '서론' },
      { n: 6, level: 2, title: '빈 문단' }, { n: 99, level: 2, title: 'x' }, { n: 5, level: 9, title: 'y' },
    ] }), texts)
    // 가장 큰 급이 2 였으므로 1 로 당긴다.
    expect(marks).toEqual([{ index: 3, level: 1, title: '결과와 고찰' }])
  })

  it('형식을 어기거나 남는 제목이 없으면 null', () => {
    expect(parseOutline('목차입니다', texts)).toBeNull()
    expect(parseOutline('{"items":[]}', texts)).toBeNull()
  })
})

function paragraph(text: string, i: number): Paragraph {
  return { uuid: `p${i + 1}`, index: i, sectionIndex: 0, role: 'body', headingLevel: null, styleName: null,
    table: null, rawText: text, text, equations: [], hash: `h${i}` } as unknown as Paragraph
}

function fakeModel(modelId: string, replies: ModelCallResult[], available = true): ReviewModel & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    modelId, promptVersion: 'x', calls,
    checkAvailability: () => Promise.resolve(available ? { available: true }
      : { available: false, reason: 'not-installed', message: 'Claude Code 를 찾지 못했습니다.' }),
    review: () => Promise.reject(new Error('검토를 부르면 안 됩니다')),
    analyzeOutline: (payload) => {
      calls.push(payload)
      return Promise.resolve(replies.shift() ?? { ok: false, reason: 'server-error', message: '더 없음' })
    },
  }
}

function harness(texts: string[], models: ReviewModelSet, online = true) {
  let paragraphs = texts.map(paragraph)
  let stored: StoredOutline | null = null
  const documents = {
    getDocument: () => ({ id: 'd', subject: '화학' }),
    latestVersion: () => ({ id: 'v' }),
    listParagraphs: () => paragraphs.map((p) => ({ uuid: p.uuid, paragraph: p })),
  } as unknown as DocumentRepository
  const outlines: OutlineRepository = { get: () => stored, save: (outline) => { stored = outline } }
  const service = createOutlineService({ documents, outlines, models, online: { isOnline: () => online }, now: () => 'now' })
  const choices = () => paragraphs.map((p, i) => line(p.text, i))
  return {
    service, choices,
    edit: (next: string[]) => { paragraphs = next.map(paragraph) },
  }
}

const reply = (items: unknown[]): ModelCallResult => ({ ok: true, text: JSON.stringify({ items }) })
const TEXTS = ['서론', '이 실험은 기체의 몰질량을 구한다.', '결과', '값은 44 g/mol 이었다.']

describe('목차 서비스', () => {
  it('Claude(심층)를 먼저 써서 나누고, 저장한 목차를 화면에 준다', async () => {
    const deep = fakeModel('opus', [reply([{ n: 1, level: 1, title: '서론' }, { n: 3, level: 1, title: '결과' }])])
    const quick = fakeModel('gemma', [])
    const h = harness(TEXTS, { quick, deep })
    expect(h.service.view('d', h.choices())).toMatchObject({ source: 'rule', status: 'missing' })

    expect(await h.service.analyze('d')).toEqual({ ok: true, count: 2, modelId: 'opus' })
    expect(quick.calls).toEqual([])
    const view = h.service.view('d', h.choices())
    expect(view).toMatchObject({ source: 'ai', status: 'ready', modelId: 'opus' })
    expect(view.nodes.map((n) => [n.title, n.paragraphIds])).toEqual([['서론', ['p1', 'p2']], ['결과', ['p3', 'p4']]])
  })

  it('Claude 를 쓸 수 없으면 빠른 모델로, 형식을 어기면 한 번 더 묻는다', async () => {
    const deep = fakeModel('opus', [], false)
    const quick = fakeModel('gemma', [{ ok: true, text: '모르겠어요' }, reply([{ n: 3, level: 1, title: '결과' }])])
    const h = harness(TEXTS, { quick, deep })
    expect(await h.service.analyze('d')).toEqual({ ok: true, count: 1, modelId: 'gemma' })
    expect(quick.calls).toHaveLength(2)
  })

  it('오프라인·연결 없음이면 부르지 않고 번호 규칙 목차를 그대로 쓴다', async () => {
    const deep = fakeModel('opus', [], false)
    const quick = fakeModel('gemma', [], false)
    const offline = harness(TEXTS, { quick, deep }, false)
    expect((await offline.service.analyze('d')).ok).toBe(false)
    expect((await harness(TEXTS, { quick, deep }).service.analyze('d')).ok).toBe(false)
    expect(offline.service.view('d', offline.choices())).toMatchObject({ source: 'rule' })
  })

  it('나가는 것은 글이 있는 문단의 번호와 앞 60자, 과목뿐이다', () => {
    const long = '가'.repeat(100)
    expect(toOutlinePayload('화학', ['제목', '', long].map(line))).toEqual({ subject: '화학',
      lines: [{ n: 1, text: '제목' }, { n: 3, text: `${'가'.repeat(60)}…` }] })
  })

  it('본문만 고치면 그대로, 제목이 바뀌면 낡았다고 알린다. 지운 제목은 빠진다', async () => {
    const deep = fakeModel('opus', [reply([{ n: 1, level: 1, title: '서론' }, { n: 3, level: 1, title: '결과' }])])
    const h = harness(TEXTS, { quick: fakeModel('gemma', []), deep })
    await h.service.analyze('d')
    // 본문과 측정값만 고쳤다.
    h.edit(['서론', '이 실험은 기체의 몰질량을 다시 구했다.', '결과', '값은 45 g/mol 이었다.'])
    expect(h.service.view('d', h.choices())).toMatchObject({ status: 'ready', source: 'ai' })
    // 제목을 바꿨다. 바뀐 제목은 목차에서 빠지고 낡았다고 알린다.
    h.edit(['머리말', '이 실험은 기체의 몰질량을 다시 구했다.', '결과', '값은 45 g/mol 이었다.'])
    const view = h.service.view('d', h.choices())
    expect(view.status).toBe('stale')
    expect(view.nodes.map((n) => n.title)).toEqual(['결과'])
  })
})

describe('실제 샘플 보고서', () => {
  it('번호 규칙 목차에서 "2. 이론적 배경" 아래에 가·나·다·라 하위 항목이 붙는다', () => {
    const doc = hwpxReader.read(join(import.meta.dirname, 'fixtures', 'sample-full.hwpx'))
    const paragraphs = doc.paragraphs.map((p, i) => line(p.text, i))
    const tree = buildOutline(ruleHeadings(paragraphs), paragraphs)
    const background = tree.find((n) => n.title === '2. 이론적 배경')!
    expect(background.children.map((n) => n.title.slice(0, 2))).toEqual(['가.', '나.', '다.', '라.'])
    expect(tree.map((n) => n.title)).toContain('8. 오차 정량 분석 및 고찰')
  })
})
