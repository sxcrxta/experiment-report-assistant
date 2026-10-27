/**
 * 보고서 목록의 한 문단 요약 ([Q-36]).
 *
 * 여기서 지키는 것
 * - **피드백이 아니다.** 저장을 감지했을 때만 만들고, 검토 기록·단계와 무관하다.
 * - **형식을 어긴 응답은 저장하지 않는다.** 파싱하지 못한 원문을 요약인 척 보여 주지 않는다.
 * - **오프라인·키 미등록·모델 오류면 조용히 지나간다.** 저장 기록이 흔들리지 않는다.
 * - **어느 모델이 썼는지 함께 남긴다.** 화면이 그 값으로 갈라지지는 않는다.
 */
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import {
  createDocumentSummaryService, toSummaryPayload, type SummaryInput,
} from '../src/app/document-summary.js'
import { parseDocumentSummary, SUMMARY_MAX_LENGTH } from '../src/adapters/model/prompts/document-summary.v1.js'
import type { ModelCallResult, ReviewModel, ReviewModelSet } from '../src/adapters/model/index.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import type { Paragraph } from '../src/core/document/model.js'
import { documentStub, NodeStub } from './helpers/dom-stub.js'
import {
  NO_SUMMARY_TEXT, renderDocumentWorkspace, STALE_SUMMARY_TEXT,
} from '../src/renderer/src/views/document-workspace.js'

function paragraph(text: string, overrides: Partial<Paragraph> = {}): Paragraph {
  return {
    uuid: `u-${text}`, index: 0, sectionIndex: 0, role: 'body', headingLevel: null, styleName: null,
    table: null, rawText: text, text, equations: [], hash: `h-${text}`, ...overrides,
  }
}

function model(calls: ModelCallResult[]): ReviewModel & { seen: unknown[] } {
  const seen: unknown[] = []
  let at = 0
  return {
    modelId: 'test-model', promptVersion: 'test', seen,
    checkAvailability: () => Promise.resolve({ available: true }),
    review: () => Promise.resolve({ ok: false, reason: 'rejected', message: '안 씀' }),
    summarizeDocument: (payload) => {
      seen.push(payload)
      return Promise.resolve(calls[at++] ?? { ok: false, reason: 'rejected', message: '더 없음' })
    },
  }
}

function harness(quick: ReviewModel, online = true) {
  const { db } = openDatabase({
    file: ':memory:', migrationsDir: join(import.meta.dirname, '../src/adapters/repo/migrations'),
  })
  const repo = createDocumentRepository(db)
  repo.createDocument({ id: 'd', path: '/보고서.hwpx', displayName: '보고서.hwpx', createdAt: 'now', subject: '화학' })
  const version = repo.appendVersion({
    id: 'v1', documentId: 'd', detectedAt: 'now', sourcePath: '/보고서.hwpx', byteSize: 1,
    contentHash: 'h', previousVersionId: null, lineage: [], diffEntries: [],
    paragraphs: [{ uuid: 'u-본문', paragraph: paragraph('본문') }],
  })
  const models = { quick, deep: quick } as unknown as ReviewModelSet
  const service = createDocumentSummaryService({
    repo, models, isOnline: () => online, now: () => '2026-09-17T00:00:00.000Z',
  })
  const input: SummaryInput = {
    documentId: 'd', versionId: version.id, subject: '화학',
    paragraphs: [paragraph('실험 목적은 몰질량 측정이다.')],
  }
  return { db, repo, service, input }
}

afterEach(() => vi.unstubAllGlobals())

it('모델이 준 요약을 어느 모델이 썼는지와 함께 남긴다', async () => {
  const quick = model([{ ok: true, text: '{"summary":"이상기체 상태방정식으로 몰질량을 구한 실험이다."}' }])
  const h = harness(quick)
  try {
    await h.service.refresh(h.input)
    expect(h.repo.getSummary('d')).toMatchObject({
      text: '이상기체 상태방정식으로 몰질량을 구한 실험이다.',
      modelId: 'test-model', promptVersion: 'document-summary.v1', versionId: 'v1',
    })
  } finally { h.db.close() }
})

it('같은 버전이면 다시 부르지 않는다', async () => {
  const quick = model([
    { ok: true, text: '{"summary":"첫 요약"}' },
    { ok: true, text: '{"summary":"두 번째"}' },
  ])
  const h = harness(quick)
  try {
    await h.service.refresh(h.input)
    await h.service.refresh(h.input)
    expect(quick.seen).toHaveLength(1)
    expect(h.repo.getSummary('d')?.text).toBe('첫 요약')
  } finally { h.db.close() }
})

it('형식을 어긴 응답은 다시 묻고, 끝내 못 받으면 저장하지 않는다', async () => {
  const quick = model([
    { ok: true, text: '요약: 그냥 줄글로 답했다' },
    { ok: true, text: '{"summary":123}' },
  ])
  const h = harness(quick)
  try {
    await h.service.refresh(h.input)
    expect(quick.seen).toHaveLength(2)
    // 파싱하지 못한 원문을 요약인 척 저장하지 않는다.
    expect(h.repo.getSummary('d')).toBeNull()
  } finally { h.db.close() }
})

it('오프라인이면 모델을 부르지 않는다', async () => {
  const quick = model([{ ok: true, text: '{"summary":"부르면 안 된다"}' }])
  const h = harness(quick, false)
  try {
    await h.service.refresh(h.input)
    expect(quick.seen).toHaveLength(0)
    expect(h.repo.getSummary('d')).toBeNull()
  } finally { h.db.close() }
})

it('키가 없거나 모델이 실패해도 조용히 지나간다', async () => {
  const quick = model([{ ok: false, reason: 'no-key', message: '키가 없습니다' }])
  const h = harness(quick)
  try {
    await expect(h.service.refresh(h.input)).resolves.toBeUndefined()
    expect(h.repo.getSummary('d')).toBeNull()
  } finally { h.db.close() }
})

it('글이 없는 문서에는 모델을 부르지 않는다 (선행 작성 보장)', async () => {
  const quick = model([{ ok: true, text: '{"summary":"부르면 안 된다"}' }])
  const h = harness(quick)
  try {
    await h.service.refresh({ ...h.input, paragraphs: [paragraph('')] })
    expect(quick.seen).toHaveLength(0)
  } finally { h.db.close() }
})

it('보내는 내용에는 사용자가 쓴 글만 담는다', () => {
  const payload = toSummaryPayload({
    documentId: 'd', versionId: 'v1', subject: '화학',
    paragraphs: [
      paragraph('1. 실험 목적', { role: 'heading' }),
      paragraph(''),
      paragraph('', { equations: ['PV=nRT'] }),
      paragraph('몰질량을 구한다.'),
    ],
  })
  expect(payload.headings).toEqual(['1. 실험 목적'])
  // 빈 문단은 빠지고, 글이 없어도 수식은 사용자가 쓴 내용이므로 함께 간다.
  expect(payload.body).toBe('1. 실험 목적\nPV=nRT\n몰질량을 구한다.')
  expect(payload.subject).toBe('화학')
})

it('요약 형식 검사는 지나치게 긴 글과 어긋난 모양을 걸러 낸다', () => {
  expect(parseDocumentSummary('{"summary":" 두 칸  띄운 글 "}')).toBe('두 칸 띄운 글')
  expect(parseDocumentSummary('앞말 {"summary":"괄호 밖 글이 섞여도 꺼낸다"} 뒷말'))
    .toBe('괄호 밖 글이 섞여도 꺼낸다')
  expect(parseDocumentSummary(`{"summary":"${'가'.repeat(SUMMARY_MAX_LENGTH + 1)}"}`)).toBeNull()
  expect(parseDocumentSummary('{"summary":null}')).toBeNull()
  expect(parseDocumentSummary('{}')).toBeNull()
  expect(parseDocumentSummary('그냥 글')).toBeNull()
})

it('화면은 요약과 함께 어느 모델이 썼는지 보여 주고, 없으면 그 사실을 적는다', () => {
  vi.stubGlobal('document', documentStub())
  const base = {
    documentId: 'd', displayName: '보고서.hwpx', path: '/보고서.hwpx', subject: '화학',
    versionCount: 1, paragraphCount: 1, pathLost: false, checkpoints: [],
  }
  const workspace = {
    paragraphs: [{ paragraphId: 'p1', number: 1, text: '본문', equations: [], tableNumber: null, changed: false }],
    versions: [{ versionId: 'v1', ordinal: 1, detectedAt: '2026-09-17T00:00:00.000Z',
      paragraphCount: 1, changedCount: 0, removedCount: 0 }],
  }
  const draw = (summary: (typeof base & { summary: unknown })['summary']): NodeStub => {
    const container = new NodeStub('main')
    renderDocumentWorkspace({
      container: container as unknown as HTMLElement,
      workspace: { ...workspace, document: { ...base, summary } } as never,
      onReview: vi.fn(), onReconnect: vi.fn(),
      onCheckpoint: vi.fn(() => Promise.resolve()), onRestore: vi.fn(() => Promise.resolve()),
    })
    return container
  }

  const withSummary = draw({ text: '몰질량을 구한 실험이다.', modelId: 'google/gemma-3-27b-it:free',
    createdAt: '2026-09-17T00:00:00.000Z', stale: false })
  const texts = withSummary.all().map(n => n.textContent)
  expect(texts).toContain('몰질량을 구한 실험이다.')
  expect(texts.some(t => t.includes('google/gemma-3-27b-it:free'))).toBe(true)
  // 보고서 본문을 늘어놓지 않는다 (목록에서 내용을 보여 주지 않기로 했다).
  expect(texts).not.toContain('본문')
  // 버전 타임라인을 그리지 않는다.
  expect(texts.some(t => t.includes('버전 기록'))).toBe(false)

  expect(draw(null).all().map(n => n.textContent)).toContain(NO_SUMMARY_TEXT)
  const stale = draw({ text: '오래된 요약', modelId: 'm', createdAt: '2026-09-17T00:00:00.000Z', stale: true })
  expect(stale.all().map(n => n.textContent)).toContain(STALE_SUMMARY_TEXT)
})

it('개요에는 보고서 삭제가 있고, 체크포인트 삭제는 사용자가 남긴 것에만 있다 (최초본 보관, PRD 4.5)', () => {
  vi.stubGlobal('document', documentStub())
  const onDelete = vi.fn(() => Promise.resolve())
  const onDeleteCheckpoint = vi.fn(() => Promise.resolve())
  const container = new NodeStub('main')
  const checkpoint = (id: string, kind: 'initial' | 'user') =>
    ({ checkpointId: id, kind, label: id, versionOrdinal: 1, createdAt: '2026-09-17T00:00:00.000Z' })
  renderDocumentWorkspace({
    container: container as unknown as HTMLElement,
    workspace: { document: { documentId: 'd', displayName: '보고서.hwpx', path: '/보고서.hwpx', subject: '화학',
      versionCount: 1, paragraphCount: 1, pathLost: false, summary: null,
      checkpoints: [checkpoint('최초본', 'initial'), checkpoint('제출 전', 'user')] },
    paragraphs: [], versions: [] },
    onReview: vi.fn(), onReconnect: vi.fn(),
    onCheckpoint: vi.fn(() => Promise.resolve()), onRestore: vi.fn(() => Promise.resolve()),
    onDelete, onDeleteCheckpoint,
  })
  const buttons = container.all().filter(n => n.textContent === '삭제')
  expect(buttons).toHaveLength(1)
  buttons[0]!.click()
  expect(onDeleteCheckpoint).toHaveBeenCalledWith('제출 전')
  container.all().find(n => n.textContent === '보고서 삭제')!.click()
  expect(onDelete).toHaveBeenCalled()
})
