/**
 * 3단계 — 평가 지침.
 *
 * T-5 사용자가 확정하지 않은 지침으로는 AI 호출이 일어나지 않는다.
 *     타입(확정 지침 표식)과 런타임(`assertConfirmedRubric`, 관문 `withConfirmedRubric`) 양쪽을 본다.
 * 완료 조건: 지침을 바꾸면 새 rubricVersion 이 생기고 이전 버전이 남는다.
 *
 * 그 밖에 이 단계의 작업 항목
 * - 지침 입력·수정·삭제가 문서 상태와 무관한 단일 경로다 ([Q-3])
 * - 항목별 중요도(6단계 점수 입력값)가 저장되고, 바꾸면 새 버전이 된다
 * - 초안 제안은 자리만 있다. 제안이 초안이나 AI 요청으로 새지 않는다
 */
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDocumentRepository, type DocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createRubricRepository, type RubricRepository } from '../src/adapters/repo/rubric.js'
import {
  createRubricService,
  UNAVAILABLE_SUGGESTER,
  type RubricDraftSuggester,
  type RubricService,
} from '../src/app/rubric.js'
import type { Paragraph } from '../src/core/document/model.js'
import {
  assertConfirmedRubric,
  confirmRubric,
  isConfirmedRubric,
  prepareRubricItems,
  restoreConfirmedRubric,
  RubricIntegrityError,
  UnconfirmedRubricError,
  type ConfirmedRubric,
  type RubricDraft,
  type RubricItem,
} from '../src/core/rubric/model.js'
import { computeRubricVersion, rubricContentHash } from '../src/core/rubric/version.js'
import { createRubricHandlers, parseRubricItemsInput } from '../src/main/rubric-ipc.js'
import type { ConfirmRequest } from '../src/main/document-ipc.js'
import { RUBRIC_MAX_ITEMS, type RubricItemInput } from '../src/shared/rubric.js'

import { makeParagraphs } from './helpers/paragraphs.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')

function input(title: string, importance = 3, description = '', itemId: string | null = null): RubricItemInput {
  return { itemId, title, description, importance }
}

function item(itemId: string, title: string, importance: RubricItem['importance'] = 3): RubricItem {
  return { itemId, title, description: '', importance }
}

function confirmed(items: readonly RubricItem[], ordinal = 1, documentId = 'doc-1'): ConfirmedRubric {
  const result = confirmRubric({ documentId, ordinal, items, confirmedAt: '2026-09-11T00:00:00.000Z' })
  if (!result.ok) throw new Error(result.problems.join('\n'))
  return result.rubric
}

// ---------------------------------------------------------------------------
// 코어
// ---------------------------------------------------------------------------

describe('rubricVersion 계산 (core/rubric/version.ts)', () => {
  const base = [item('a', '실험 목적'), item('b', '결과와 고찰의 연결', 5)]

  it('같은 입력이면 언제나 같은 값이다', () => {
    expect(rubricContentHash(base)).toBe(rubricContentHash(base.map((i) => ({ ...i }))))
    const contentHash = rubricContentHash(base)
    expect(computeRubricVersion({ documentId: 'd', ordinal: 1, contentHash })).toBe(
      computeRubricVersion({ documentId: 'd', ordinal: 1, contentHash }),
    )
  })

  it('이름·설명·중요도·순서·식별자 중 하나만 바뀌어도 내용 해시가 달라진다', () => {
    const original = rubricContentHash(base)
    const variants: RubricItem[][] = [
      [{ ...base[0]!, title: '실험의 목적' }, base[1]!],
      [{ ...base[0]!, description: '가설이 드러나는가' }, base[1]!],
      [base[0]!, { ...base[1]!, importance: 4 }],
      [base[1]!, base[0]!],
      [{ ...base[0]!, itemId: 'z' }, base[1]!],
    ]
    for (const variant of variants) expect(rubricContentHash(variant)).not.toBe(original)
  })

  it('확정 순번이나 문서가 다르면 내용이 같아도 다른 버전이다', () => {
    const contentHash = rubricContentHash(base)
    const v1 = computeRubricVersion({ documentId: 'd', ordinal: 1, contentHash })
    expect(computeRubricVersion({ documentId: 'd', ordinal: 2, contentHash })).not.toBe(v1)
    expect(computeRubricVersion({ documentId: 'e', ordinal: 1, contentHash })).not.toBe(v1)
  })
})

describe('지침 항목 입력 (core/rubric/model.ts)', () => {
  it('이름과 설명을 정규화하고, 새 항목에 식별자를 준다', () => {
    let n = 0
    const result = prepareRubricItems(
      [
        input('  결과와　고찰의   연결 ', 5, '  그래프 해석이\r\n  결론으로 이어지는가  \n'),
        input('실험 목적', 2, '', 'kept-id'),
      ],
      () => `new-${(n += 1)}`,
    )
    expect(result).toEqual({
      ok: true,
      items: [
        {
          itemId: 'new-1',
          title: '결과와 고찰의 연결',
          description: '그래프 해석이\n  결론으로 이어지는가',
          importance: 5,
        },
        { itemId: 'kept-id', title: '실험 목적', description: '', importance: 2 },
      ],
    })
  })

  it('NFD 로 들어온 이름도 NFC 로 저장한다', () => {
    const result = prepareRubricItems([input('고찰'.normalize('NFD'))], () => 'x')
    expect(result.ok && result.items[0]?.title).toBe('고찰')
  })

  it('이름과 설명이 모두 빈 줄은 항목으로 만들지 않는다', () => {
    const result = prepareRubricItems([input(''), input('  '), input('실험 방법')], () => 'x')
    expect(result.ok && result.items.map((i) => i.title)).toEqual(['실험 방법'])
  })

  it('중요도는 1~5 의 정수만 받는다', () => {
    for (const importance of [0, 6, 2.5, Number.NaN]) {
      const result = prepareRubricItems([input('실험 목적', importance)], () => 'x')
      expect(result.ok).toBe(false)
    }
  })

  it('너무 긴 이름, 너무 많은 항목, 겹치는 식별자를 거절한다', () => {
    expect(prepareRubricItems([input('가'.repeat(101))], () => 'x').ok).toBe(false)

    let n = 0
    const many = Array.from({ length: RUBRIC_MAX_ITEMS + 1 }, (_, i) => input(`항목 ${i}`))
    expect(prepareRubricItems(many, () => `id-${(n += 1)}`).ok).toBe(false)

    const duplicated = [input('가', 3, '', 'same'), input('나', 3, '', 'same')]
    expect(prepareRubricItems(duplicated, () => 'x').ok).toBe(false)
  })

  it('초안은 이름이 비어 있어도 저장할 수 있지만 확정은 할 수 없다', () => {
    const prepared = prepareRubricItems([input('', 3, '설명만 먼저 적었다')], () => 'x')
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const result = confirmRubric({
      documentId: 'doc-1',
      ordinal: 1,
      items: prepared.items,
      confirmedAt: 'now',
    })
    expect(result).toEqual({ ok: false, problems: ['1번 항목: 이름을 적어 주세요.'] })
  })

  it('항목이 없는 지침과 이름이 겹치는 지침은 확정하지 않는다', () => {
    expect(confirmRubric({ documentId: 'd', ordinal: 1, items: [], confirmedAt: 'now' })).toEqual({
      ok: false,
      problems: ['지침 항목을 하나 이상 입력해 주세요.'],
    })
    const twins = confirmRubric({
      documentId: 'd',
      ordinal: 1,
      items: [item('a', '고찰'), item('b', '고찰')],
      confirmedAt: 'now',
    })
    expect(twins.ok).toBe(false)
  })
})

describe('확정 지침은 확정 입구로만 생기고 바뀌지 않는다 (T-5, 런타임)', () => {
  const items = [item('a', '실험 목적'), item('b', '결과 해석', 5)]

  it('확정한 지침은 얼어 있어 고칠 수 없다', () => {
    const rubric = confirmed(items)
    expect(isConfirmedRubric(rubric)).toBe(true)
    expect(() => {
      ;(rubric.items[0] as RubricItem).title = '몰래 바꾼 이름'
    }).toThrow(TypeError)
    expect(() => {
      ;(rubric as { items: unknown }).items = []
    }).toThrow(TypeError)
    expect(rubric.items[0]?.title).toBe('실험 목적')
  })

  it('초안은 확정 지침이 아니다', () => {
    const draft: RubricDraft = { status: 'draft', documentId: 'doc-1', items, updatedAt: 'now' }
    expect(isConfirmedRubric(draft)).toBe(false)
    expect(() => assertConfirmedRubric(draft)).toThrow(UnconfirmedRubricError)
  })

  it('확정 지침을 흉내 낸 객체도 확정 지침이 아니다', () => {
    const rubric = confirmed(items)

    // 해시까지 맞게 손으로 만든 객체 (얼어 있지 않다)
    const forged = { ...rubric, items: rubric.items.map((i) => ({ ...i })) }
    expect(isConfirmedRubric(forged)).toBe(false)

    // IPC 로 오가며 복제된 객체
    expect(isConfirmedRubric(structuredClone(rubric))).toBe(false)

    // 상태를 초안으로 둔 객체
    expect(isConfirmedRubric(Object.freeze({ ...rubric, status: 'draft' }))).toBe(false)

    // 얼려 두었어도 내용이 확정할 때와 다른 객체
    const tampered = Object.freeze({
      ...rubric,
      items: Object.freeze([Object.freeze({ ...rubric.items[0]!, title: '바뀐 이름' }), rubric.items[1]!]),
    })
    expect(isConfirmedRubric(tampered)).toBe(false)

    for (const value of [null, undefined, 'rubric', 1, [], {}]) {
      expect(() => assertConfirmedRubric(value)).toThrow(UnconfirmedRubricError)
    }
  })

  it('저장된 값이 확정할 때와 다르면 되살리지 않는다', () => {
    const rubric = confirmed(items)
    const stored = {
      documentId: rubric.documentId,
      ordinal: rubric.ordinal,
      rubricVersion: rubric.rubricVersion,
      contentHash: rubric.contentHash,
      items: [...rubric.items],
      confirmedAt: rubric.confirmedAt,
    }
    expect(restoreConfirmedRubric(stored)).toEqual(rubric)
    expect(() => restoreConfirmedRubric({ ...stored, items: [items[0]!] })).toThrow(RubricIntegrityError)
    expect(() => restoreConfirmedRubric({ ...stored, ordinal: 2 })).toThrow(RubricIntegrityError)
  })
})

describe('확정 지침은 타입으로도 구별된다 (T-5, 타입)', () => {
  /** AI 요청 자리를 흉내 낸 함수. 확정 지침만 받는다 */
  function acceptsOnlyConfirmed(rubric: ConfirmedRubric): string {
    return rubric.rubricVersion
  }

  it('초안이나 손으로 만든 객체를 넘기면 컴파일이 실패한다', () => {
    const draft: RubricDraft = { status: 'draft', documentId: 'doc-1', items: [], updatedAt: 'now' }
    const rubric = confirmed([item('a', '실험 목적')])
    const lookalike = {
      status: 'confirmed' as const,
      documentId: rubric.documentId,
      ordinal: rubric.ordinal,
      rubricVersion: rubric.rubricVersion,
      contentHash: rubric.contentHash,
      items: rubric.items,
      confirmedAt: rubric.confirmedAt,
    }

    // 아래 두 줄이 컴파일되면 tsc(`npm run check:types`)가 실패한다. 표식이 없는 값은 받지 않는다.
    // @ts-expect-error 초안은 확정 지침 자리에 들어갈 수 없다
    expect(() => assertConfirmedRubric(acceptsOnlyConfirmed(draft))).toThrow()
    // @ts-expect-error 확정 입구를 거치지 않은 객체도 들어갈 수 없다
    expect(acceptsOnlyConfirmed(lookalike)).toBe(rubric.rubricVersion)

    expect(acceptsOnlyConfirmed(rubric)).toBe(rubric.rubricVersion)
  })
})

// ---------------------------------------------------------------------------
// 저장소 · 유스케이스
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database
  documents: DocumentRepository
  rubrics: RubricRepository
  service: RubricService
  documentId: string
  suggestCalls: { documentId: string; paragraphs: readonly Paragraph[] }[]
  /** 다음 제안 결과. null 이면 아직 준비되지 않은 제안기(3단계 기본값)를 쓴다 */
  setSuggestion: (items: { title: string; description: string; importance: 1 | 2 | 3 | 4 | 5 }[] | null) => void
}

const cleanups: (() => void)[] = []
let h: Harness

function addDocument(documents: DocumentRepository, id: string, paragraphs: readonly Paragraph[]): void {
  documents.createDocument({
    id,
    path: `/tmp/${id}.hwpx`,
    displayName: `${id}.hwpx`,
    subject: '화학',
    createdAt: '2026-09-11T00:00:00.000Z',
  })
  documents.appendVersion({
    id: `${id}-v1`,
    documentId: id,
    detectedAt: '2026-09-11T00:00:00.000Z',
    sourcePath: `/tmp/${id}.hwpx`,
    byteSize: 1,
    contentHash: `${id}-bytes`,
    paragraphs: paragraphs.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
    lineage: [],
    diffEntries: [],
    previousVersionId: null,
  })
}

function createHarness(): Harness {
  const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })
  cleanups.push(() => db.close())

  const documents = createDocumentRepository(db)
  const rubrics = createRubricRepository(db)
  addDocument(documents, 'doc-1', makeParagraphs(['1. 실험 목적', '2. 실험 방법', '3. 결과']))

  const suggestCalls: Harness['suggestCalls'] = []
  let suggestion: Parameters<Harness['setSuggestion']>[0] = null
  const suggester: RubricDraftSuggester = {
    suggest: (request) => {
      suggestCalls.push(request)
      return suggestion === null
        ? UNAVAILABLE_SUGGESTER.suggest(request)
        : Promise.resolve({ ok: true, items: suggestion })
    },
  }

  let clock = 0
  let ids = 0
  const service = createRubricService({
    documents,
    rubrics,
    suggester,
    now: () => new Date(1_700_000_000_000 + (clock += 1) * 1000).toISOString(),
    newId: () => `item-${(ids += 1)}`,
  })

  return {
    db,
    documents,
    rubrics,
    service,
    documentId: 'doc-1',
    suggestCalls,
    setSuggestion: (items) => {
      suggestion = items
    },
  }
}

beforeEach(() => {
  h = createHarness()
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function confirmItems(inputs: readonly RubricItemInput[], documentId = h.documentId): ConfirmedRubric {
  const result = h.service.confirm(documentId, inputs)
  if (!result.ok) throw new Error(result.message)
  return result.rubric
}

/** 확정 버전의 항목을 편집기 입력 형태로 바꾼다 (식별자를 유지한 채 고칠 때) */
function asInputs(rubric: ConfirmedRubric): RubricItemInput[] {
  return rubric.items.map((i) => ({ ...i }))
}

describe('확정 전 지침으로는 AI 호출이 일어나지 않는다 (T-5, 완료 조건)', () => {
  function spyCall(): { call: (rubric: ConfirmedRubric) => Promise<string>; received: ConfirmedRubric[] } {
    const received: ConfirmedRubric[] = []
    return {
      received,
      call: (rubric) => {
        received.push(rubric)
        return Promise.resolve('AI 응답')
      },
    }
  }

  it('지침을 입력한 적이 없으면 호출하지 않는다', async () => {
    const spy = spyCall()
    const result = await h.service.withConfirmedRubric(h.documentId, spy.call)

    expect(result).toMatchObject({ ok: false, reason: 'rubric-not-confirmed' })
    expect(spy.received).toEqual([])
  })

  it('초안만 저장했으면 호출하지 않는다', async () => {
    const saved = h.service.saveDraft(h.documentId, [input('실험 목적', 4), input('결과 해석', 5)])
    expect(saved.ok && saved.state.draft?.items).toHaveLength(2)

    const spy = spyCall()
    const result = await h.service.withConfirmedRubric(h.documentId, spy.call)

    expect(result).toMatchObject({ ok: false, reason: 'rubric-not-confirmed' })
    expect(spy.received).toEqual([])
  })

  it('확정한 뒤 고친 초안이 있어도 AI 에는 마지막 확정 버전만 간다', async () => {
    const v1 = confirmItems([input('실험 목적', 4)])
    h.service.saveDraft(h.documentId, [input('확정하지 않은 새 항목', 5)])

    const spy = spyCall()
    const result = await h.service.withConfirmedRubric(h.documentId, spy.call)

    expect(result).toMatchObject({ ok: true, value: 'AI 응답', pendingDraft: true })
    expect(spy.received).toHaveLength(1)
    expect(spy.received[0]?.rubricVersion).toBe(v1.rubricVersion)
    expect(JSON.stringify(spy.received)).not.toContain('확정하지 않은 새 항목')
    expect(isConfirmedRubric(spy.received[0])).toBe(true)
  })

  it('확정하면 그때부터 확정한 지침으로 호출한다', async () => {
    h.service.saveDraft(h.documentId, [input('실험 목적', 4)])
    const rubric = confirmItems([input('실험 목적', 4)])

    const spy = spyCall()
    const result = await h.service.withConfirmedRubric(h.documentId, spy.call)

    expect(result).toMatchObject({ ok: true, pendingDraft: false })
    expect(spy.received).toEqual([rubric])
  })

  it('저장된 확정 지침이 바뀌어 있으면 호출하지 않는다', async () => {
    confirmItems([input('실험 목적', 4), input('결과 해석', 5)])
    // 누군가 DB 에서 항목을 지웠다. 확정할 때의 해시와 맞지 않는다.
    h.db.prepare('DELETE FROM rubric_item WHERE position = 1').run()

    const spy = spyCall()
    const result = await h.service.withConfirmedRubric(h.documentId, spy.call)

    expect(result).toMatchObject({ ok: false, reason: 'rubric-unreadable' })
    expect(spy.received).toEqual([])
  })

  it('등록되지 않은 문서로는 호출하지 않는다', async () => {
    const spy = spyCall()
    expect(await h.service.withConfirmedRubric('없는-문서', spy.call)).toMatchObject({
      ok: false,
      reason: 'unknown-document',
    })
    expect(spy.received).toEqual([])
  })

  it('초안 제안은 편집기로만 돌아가고 초안·AI 요청에 실리지 않는다', async () => {
    h.setSuggestion([{ title: ' 제안된　항목 ', description: '', importance: 3 }])
    const suggested = await h.service.suggestDraft(h.documentId)

    expect(suggested).toEqual({
      ok: true,
      items: [{ title: '제안된 항목', description: '', importance: 3 }],
    })
    // 제안기에는 문서 구조만 간다. 사용자의 초안이나 지침은 넘기지 않는다.
    expect(Object.keys(h.suggestCalls[0] ?? {}).sort()).toEqual(['documentId', 'paragraphs'])
    expect(h.suggestCalls[0]?.paragraphs.map((p) => p.text)).toEqual([
      '1. 실험 목적',
      '2. 실험 방법',
      '3. 결과',
    ])
    expect(h.rubrics.getDraft(h.documentId)).toBeNull()

    const spy = spyCall()
    expect(await h.service.withConfirmedRubric(h.documentId, spy.call)).toMatchObject({
      ok: false,
      reason: 'rubric-not-confirmed',
    })
    expect(spy.received).toEqual([])
  })
})

describe('지침 버전 (완료 조건: 바꾸면 새 버전, 이전 버전은 남는다)', () => {
  it('처음 확정하면 버전 1 이 생긴다', () => {
    const result = h.service.confirm(h.documentId, [input('실험 목적', 4)])
    expect(result).toMatchObject({ ok: true, created: true, rubric: { ordinal: 1 } })
  })

  it('지침을 바꿔 확정하면 새 rubricVersion 이 생기고 이전 버전이 그대로 남는다', () => {
    const v1 = confirmItems([input('실험 목적', 4), input('결과 해석', 5)])

    const edited = asInputs(v1)
    edited[0] = { ...edited[0]!, title: '실험 목적과 가설' }
    edited.push(input('참고문헌 표기', 2))
    const v2 = confirmItems(edited)

    expect(v2.ordinal).toBe(2)
    expect(v2.rubricVersion).not.toBe(v1.rubricVersion)

    const history = h.rubrics.listConfirmed(h.documentId)
    expect(history.map((r) => r.rubricVersion)).toEqual([v1.rubricVersion, v2.rubricVersion])
    expect(h.rubrics.getConfirmed(v1.rubricVersion)).toEqual(v1)
    expect(h.rubrics.getConfirmed(v1.rubricVersion)?.items.map((i) => i.title)).toEqual([
      '실험 목적',
      '결과 해석',
    ])
  })

  it('고친 항목은 식별자를 유지한다', () => {
    const v1 = confirmItems([input('실험 목적', 4)])
    const v2 = confirmItems([{ ...asInputs(v1)[0]!, description: '가설이 드러나는가' }])
    expect(v2.items[0]?.itemId).toBe(v1.items[0]?.itemId)
  })

  it('중요도만 바꿔도 새 버전이다 (6단계 점수 입력값)', () => {
    const v1 = confirmItems([input('실험 목적', 2)])
    const v2 = confirmItems([{ ...asInputs(v1)[0]!, importance: 5 }])

    expect(v2.rubricVersion).not.toBe(v1.rubricVersion)
    expect(v2.items[0]?.importance).toBe(5)
    expect(h.rubrics.getConfirmed(v1.rubricVersion)?.items[0]?.importance).toBe(2)
  })

  it('항목을 지우고 확정해도 새 버전이며, 지운 항목은 이전 버전에 남는다', () => {
    const v1 = confirmItems([input('실험 목적'), input('지울 항목')])
    const v2 = confirmItems([asInputs(v1)[0]!])

    expect(v2.items.map((i) => i.title)).toEqual(['실험 목적'])
    expect(h.rubrics.getConfirmed(v1.rubricVersion)?.items.map((i) => i.title)).toEqual([
      '실험 목적',
      '지울 항목',
    ])
  })

  it('바뀐 것이 없으면 새 버전을 만들지 않는다', () => {
    const v1 = confirmItems([input('실험 목적', 4)])
    const again = h.service.confirm(h.documentId, asInputs(v1))

    expect(again).toMatchObject({ ok: true, created: false })
    expect(again.ok && again.rubric.rubricVersion).toBe(v1.rubricVersion)
    expect(h.rubrics.listConfirmed(h.documentId)).toHaveLength(1)
  })

  it('예전 내용으로 되돌려 확정해도 버전은 되감기지 않고 새로 올라간다', () => {
    const v1 = confirmItems([input('실험 목적', 4)])
    const v2 = confirmItems([{ ...asInputs(v1)[0]!, title: '바꾼 이름' }])
    const v3 = confirmItems(asInputs(v1))

    expect(v3.ordinal).toBe(3)
    expect(new Set([v1.rubricVersion, v2.rubricVersion, v3.rubricVersion]).size).toBe(3)
  })

  it('확정한 지침은 DB 에서도 고칠 수 없다', () => {
    const v1 = confirmItems([input('실험 목적', 4)])
    expect(() => h.db.prepare("UPDATE rubric_item SET title = '바꿈'").run()).toThrow(
      '확정한 지침은 고칠 수 없습니다',
    )
    expect(() => h.db.prepare('UPDATE rubric_version SET ordinal = 9').run()).toThrow(
      '확정한 지침은 고칠 수 없습니다',
    )
    expect(h.rubrics.getConfirmed(v1.rubricVersion)).toEqual(v1)
  })

  it('확정할 수 없는 내용이면 버전을 만들지 않고 이유를 알린다', () => {
    const result = h.service.confirm(h.documentId, [input('', 3, '이름 없이 설명만')])
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-rubric',
      message: '1번 항목: 이름을 적어 주세요.',
    })
    expect(h.rubrics.listConfirmed(h.documentId)).toEqual([])
  })
})

describe('지침 입력·수정·삭제 (단일 경로)', () => {
  it('초안을 저장하고 고치고 버릴 수 있으며, 확정한 버전은 건드리지 않는다', () => {
    const v1 = confirmItems([input('실험 목적')])

    const saved = h.service.saveDraft(h.documentId, [...asInputs(v1), input('새 항목')])
    expect(saved.ok && saved.state.draft?.items.map((i) => i.title)).toEqual(['실험 목적', '새 항목'])
    expect(saved.ok && saved.state.current?.rubricVersion).toBe(v1.rubricVersion)

    const resaved = h.service.saveDraft(h.documentId, [input('새 항목만 남김')])
    expect(resaved.ok && resaved.state.draft?.items.map((i) => i.title)).toEqual(['새 항목만 남김'])

    const discarded = h.service.discardDraft(h.documentId)
    expect(discarded.ok && discarded.state.draft).toBeNull()
    expect(h.rubrics.listConfirmed(h.documentId)).toEqual([v1])
  })

  it('확정한 내용과 같은 초안은 남기지 않는다', () => {
    const v1 = confirmItems([input('실험 목적')])
    const saved = h.service.saveDraft(h.documentId, asInputs(v1))
    expect(saved.ok && saved.state.draft).toBeNull()
  })

  it('확정하면 초안이 사라진다', () => {
    h.service.saveDraft(h.documentId, [input('실험 목적')])
    confirmItems([input('실험 목적')])
    expect(h.rubrics.getDraft(h.documentId)).toBeNull()
  })

  it('형식에 맞지 않는 초안은 저장하지 않는다', () => {
    const result = h.service.saveDraft(h.documentId, [input('실험 목적', 9)])
    expect(result).toMatchObject({ ok: false, reason: 'invalid-rubric' })
    expect(h.rubrics.getDraft(h.documentId)).toBeNull()
  })

  it('빈 문서와 양식이 있는 문서가 같은 경로를 지난다 ([Q-3])', async () => {
    addDocument(h.documents, 'empty-doc', [])

    for (const documentId of [h.documentId, 'empty-doc']) {
      // 둘 다 지침 없이 시작하고, 확정 전에는 AI 호출이 막히며, 같은 방식으로 확정된다.
      expect(h.service.getEditor(documentId)).toEqual({
        ok: true,
        state: { documentId, draft: null, current: null, history: [] },
      })
      expect(await h.service.withConfirmedRubric(documentId, () => Promise.resolve(1))).toMatchObject({
        ok: false,
        reason: 'rubric-not-confirmed',
      })
      expect(confirmItems([input('실험 목적')], documentId).ordinal).toBe(1)
    }
  })

  it('지침은 문서마다 따로다', () => {
    addDocument(h.documents, 'doc-2', [])
    confirmItems([input('실험 목적')])
    expect(h.rubrics.latestConfirmed('doc-2')).toBeNull()
  })

  it('초안 제안 기능은 아직 준비 중이라고 정직하게 알린다', async () => {
    const result = await h.service.suggestDraft(h.documentId)
    expect(result).toMatchObject({ ok: false, reason: 'suggestion-unavailable' })
    expect(result.ok === false && result.message).toContain('준비 중')
  })
})

// ---------------------------------------------------------------------------
// 메인 프로세스 핸들러
// ---------------------------------------------------------------------------

describe('지침 편집 IPC 핸들러', () => {
  function handlers(answer: boolean): {
    handlers: ReturnType<typeof createRubricHandlers>
    confirms: ConfirmRequest[]
  } {
    const confirms: ConfirmRequest[] = []
    return {
      confirms,
      handlers: createRubricHandlers({
        rubric: h.service,
        confirm: (request) => {
          confirms.push(request)
          return Promise.resolve(answer)
        },
      }),
    }
  }

  it('렌더러가 보낸 항목의 형태를 확인한다', () => {
    expect(parseRubricItemsInput([input('실험 목적')])).toEqual([input('실험 목적')])
    for (const bad of [
      null,
      'items',
      [null],
      [{ itemId: 3, title: 'a', description: '', importance: 3 }],
      [{ itemId: null, title: 'a', description: '', importance: '3' }],
      [{ itemId: null, description: '', importance: 3 }],
    ]) {
      expect(parseRubricItemsInput(bad)).toBeNull()
    }
  })

  it('형태가 틀린 요청은 아무것도 저장하지 않는다', () => {
    const { handlers: rubric } = handlers(true)
    expect(rubric.saveRubricDraft(h.documentId, [{ title: 1 }])).toMatchObject({ status: 'failed' })
    expect(rubric.confirmRubric(h.documentId, 'x')).toMatchObject({ status: 'failed' })
    expect(rubric.confirmRubric(42, [input('실험 목적')])).toMatchObject({ status: 'failed' })
    expect(h.rubrics.getDraft(h.documentId)).toBeNull()
    expect(h.rubrics.listConfirmed(h.documentId)).toEqual([])
  })

  it('확정하면 버전 번호와 편집 상태를 돌려주고, 이전 버전은 최근 것부터 보인다', () => {
    const { handlers: rubric } = handlers(true)
    const first = rubric.confirmRubric(h.documentId, [input('실험 목적')])
    expect(first).toMatchObject({ status: 'confirmed', created: true, ordinal: 1 })

    const second = rubric.confirmRubric(h.documentId, [input('실험 목적'), input('결과 해석', 5)])
    if (second.status !== 'confirmed') throw new Error('확정 실패')
    expect(second.ordinal).toBe(2)
    expect(second.editor.current?.ordinal).toBe(2)
    expect(second.editor.history.map((v) => v.ordinal)).toEqual([2, 1])
    expect(second.editor.current?.items[1]).toMatchObject({ title: '결과 해석', importance: 5 })
  })

  it('초안 버리기는 확인을 받은 뒤에만 한다', async () => {
    h.service.saveDraft(h.documentId, [input('버릴지 모르는 초안')])

    const cancel = handlers(false)
    expect(await cancel.handlers.discardRubricDraft(h.documentId)).toEqual({ status: 'canceled' })
    expect(cancel.confirms).toHaveLength(1)
    expect(h.rubrics.getDraft(h.documentId)).not.toBeNull()

    const accept = handlers(true)
    const result = await accept.handlers.discardRubricDraft(h.documentId)
    expect(result).toMatchObject({ status: 'discarded', editor: { draft: null } })
    expect(h.rubrics.getDraft(h.documentId)).toBeNull()
  })

  it('버릴 초안이 없으면 묻지 않는다', async () => {
    const { handlers: rubric, confirms } = handlers(true)
    expect(await rubric.discardRubricDraft(h.documentId)).toMatchObject({ status: 'discarded' })
    expect(confirms).toEqual([])
  })

  it('초안 제안은 준비 중으로 알린다', async () => {
    const { handlers: rubric } = handlers(true)
    expect(await rubric.suggestRubricDraft(h.documentId)).toMatchObject({ status: 'unavailable' })
  })
})
