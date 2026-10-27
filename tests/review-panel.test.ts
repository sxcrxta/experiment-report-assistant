/** 브라우저 대역으로 이벤트 연결을 검증한다. 실제 Electron 레이아웃 검증은 별도다. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { noteSaved, openReviewPanel, refreshReviewPanel } from '../src/renderer/src/views/review-panel.js'
import type { FeedbackCard, ReviewPanel } from '../src/shared/feedback.js'
import type { DocumentPreviewResult } from '../src/shared/document-preview.js'
import type { RepeatedObservation } from '../src/shared/personalization.js'
import { documentStub, NodeStub } from './helpers/dom-stub.js'

function panel(documentId = 'doc-1', versionOrdinal = 1): ReviewPanel {
  return {
    documentId, documentName: documentId, versionOrdinal,
    requestAvailable: false, unavailableMessage: '오프라인', rubricConfirmed: true, readyExceptRubric: false,
    depths: [
      { depth: 'quick', label: '빠른 검토', available: false, unavailableMessage: '오프라인' },
      { depth: 'deep', label: '심층 검토', available: false, unavailableMessage: 'Claude Code 를 찾지 못했습니다.' },
    ],
    paragraphs: ['p1', 'p2'].map((paragraphId, index) => ({
      paragraphId, number: index + 1, text: paragraphId, hasContent: true, role: 'body', table: null,
      sentences: [], equations: [], changed: false,
    })),
    sections: [{ ordinal: 1, title: '전체', startIndex: 0, endIndex: 1,
      startParagraphUuid: 'p1', endParagraphUuid: 'p2', source: 'fallback' }],
    sectionNotice: '', cards: [], hiddenCount: 0,
    recommended: { perspectives: ['logic'], stage: 'question', reason: '테스트' },
  }
}

/** 카드 하나짜리 화면. 반복 관찰 근거만 바꿔 가며 쓴다. */
function panelWithCard(repeatedObservation: RepeatedObservation): ReviewPanel {
  const card: FeedbackCard = {
    itemId: 'item-1', requestId: 'req-1', paragraphId: 'p1', paragraphNumber: 1,
    perspective: 'logic', stage: 'question', severity: 3,
    summary: '근거가 무엇인가요?', body: '근거가 무엇인가요?', rationale: '측정값 언급이 없습니다.',
    example: null, appliedRubric: [{ itemId: 'r1', title: '결과', importance: 4 }],
    requestedAt: '2026-09-12T00:00:00.000Z', scope: 'paragraph', anchor: null, revision: null,
    grantedStages: ['question'], nextStage: 'weak_hint', nextStageNeedsRequest: false,
    targetKey: 'p1|logic', repeatedObservation,
  }
  return { ...panel(), cards: [card] }
}

function harness(
  getReviewPanel = vi.fn((id: string) => Promise.resolve({ status: 'ok', panel: panel(id) })),
  getDocumentPreview: () => Promise<DocumentPreviewResult> =
    vi.fn(() => Promise.resolve<DocumentPreviewResult>({ status: 'failed', message: '서식 미리보기를 읽지 못했습니다.' })),
) {
  vi.stubGlobal('document', documentStub())
  const saveSectionBoundaries = vi.fn(() => Promise.resolve({ status: 'ok' }))
  const requestStagedReview = vi.fn(() => Promise.resolve({ status: 'failed', message: '테스트' }))
  const cancelDeepReview = vi.fn(() => Promise.resolve({ status: 'canceled' }))
  const getRubric = vi.fn(() => Promise.resolve({ status: 'ok', editor: { draft: { updatedAt: '', items: [
    { itemId: 'r1', title: '실험 목적', description: '', importance: 4 },
    { itemId: 'r2', title: '고찰', description: '', importance: 5 },
  ] }, current: null, history: [] } }))
  const confirmRubric = vi.fn(() => Promise.resolve({ status: 'confirmed', created: true, ordinal: 1, editor: {} }))
  const listRubricTemplates = vi.fn(() => Promise.resolve({ status: 'ok', templates: [] as unknown[], link: null,
    suggestedId: null as string | null }))
  const applyRubricTemplate = vi.fn(() => Promise.resolve({ status: 'applied', ordinal: 1 }))
  vi.stubGlobal('window', { agent: { getReviewPanel, saveSectionBoundaries, requestStagedReview,
    cancelDeepReview, getRubric, confirmRubric, listRubricTemplates, applyRubricTemplate,
    getDocumentPreview,
    getPersonalRecords:()=>Promise.resolve({status:'ok',value:{reactions:[],assessments:[]}}) } })
  const root = new NodeStub('main')
  const container = root as unknown as HTMLElement
  const notify = vi.fn()
  const byText = (text: string): NodeStub => root.all().find((node) => node.textContent === text)!
  const byLabel = (label: string): NodeStub => root.all().find((node) => node.attributes.get('aria-label') === label)!
  return { root, container, notify, byText, byLabel, saveSectionBoundaries, requestStagedReview, cancelDeepReview,
    getDocumentPreview, getRubric, confirmRubric, listRubricTemplates, applyRubricTemplate }
}

/** 깊이 상태만 바꾼 화면 */
function panelWithDepths(deepAvailable: boolean, deepMessage = 'Claude Code 를 찾지 못했습니다.'): ReviewPanel {
  return {
    ...panel(),
    requestAvailable: true,
    unavailableMessage: '',
    depths: [
      { depth: 'quick', label: '빠른 검토', available: true, unavailableMessage: '' },
      { depth: 'deep', label: '심층 검토', available: deepAvailable,
        unavailableMessage: deepAvailable ? '' : deepMessage },
    ],
  }
}

afterEach(() => vi.unstubAllGlobals())

it('통째로 묶인 항목도 두 개로 나눠 저장하고 삭제 후 순번을 다시 붙일 수 있다', async () => {
  const h = harness()
  await openReviewPanel({ ...h, documentId: 'doc-1' })
  expect(h.byLabel('1번 항목 삭제').disabled).toBe(true)
  h.byText('항목 추가').click()
  h.byLabel('1번 항목 이름').value = '목적'
  h.byLabel('1번 항목 끝 문단').value = 'p1'
  h.byLabel('2번 항목 이름').value = '결과'
  h.byLabel('2번 항목 시작 문단').value = 'p2'
  h.byLabel('2번 항목 끝 문단').value = 'p2'
  h.byText('경계 저장').click()
  expect(h.saveSectionBoundaries).toHaveBeenLastCalledWith('doc-1', [
    { ordinal: 1, title: '목적', startParagraphUuid: 'p1', endParagraphUuid: 'p1' },
    { ordinal: 2, title: '결과', startParagraphUuid: 'p2', endParagraphUuid: 'p2' },
  ])
  h.byLabel('1번 항목 삭제').click()
  expect(h.byLabel('1번 항목 이름').value).toBe('결과')
  expect(h.byLabel('1번 항목 삭제').disabled).toBe(true)
  h.byText('경계 저장').click()
  expect(h.saveSectionBoundaries).toHaveBeenLastCalledWith('doc-1', [
    { ordinal: 1, title: '결과', startParagraphUuid: 'p2', endParagraphUuid: 'p2' },
  ])
  // 비동기 저장 후 새로고침이 테스트 전역 정리 이후 실행되지 않도록 기다린다.
  await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(2))
})

it('이전 문서의 늦은 응답이 새로 연 문서 화면을 덮지 않는다', async () => {
  let finish!: (value: { status: string; panel: ReviewPanel }) => void
  const old = new Promise<{ status: string; panel: ReviewPanel }>((resolve) => { finish = resolve })
  const h = harness(vi.fn((id: string) => id === 'old' ? old : Promise.resolve({ status: 'ok', panel: panel(id) })))
  const pending = openReviewPanel({ ...h, documentId: 'old' })
  await openReviewPanel({ ...h, documentId: 'new' })
  finish({ status: 'ok', panel: panel('old') })
  await pending
  expect(h.byText('new')).toBeDefined()
  expect(h.byText('old')).toBeUndefined()
})

it('저장 알림은 해당 문서 패널만 최신 버전으로 다시 읽는다', async () => {
  let version = 1
  const getPanel = vi.fn((id: string) => Promise.resolve({ status: 'ok', panel: panel(id, version) }))
  const h = harness(getPanel)
  await openReviewPanel({ ...h, documentId: 'doc-1' })
  version = 2
  await refreshReviewPanel(h.container, 'other')
  expect(getPanel).toHaveBeenCalledTimes(1)
  await refreshReviewPanel(h.container, 'doc-1')
  expect(h.byText('버전 2')).toBeDefined()
})

it('취약점 카드에는 반복 관찰 근거가 문서 버전과 함께 언제나 붙는다 (T-8)', async () => {
  const repeated = { count: 2, versions: [
    { documentId: 'doc-1', documentName: '실험1.hwpx', versionOrdinal: 1 },
    { documentId: 'doc-1', documentName: '실험1.hwpx', versionOrdinal: 3 },
  ] }
  const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: panelWithCard(repeated) })))
  await openReviewPanel({ ...h, documentId: 'doc-1' })
  expect(h.byText('반복 관찰 근거')).toBeDefined()
  expect(h.byText('실험1.hwpx · 버전 1')).toBeDefined()
  expect(h.byText('실험1.hwpx · 버전 3')).toBeDefined()
  // 근거는 붙이되 능력을 단정하지 않는다 (CLAUDE.md §1).
  const texts = h.root.all().map((node) => node.textContent).join('\n')
  expect(texts).toContain('반복 취약점 후보')
  expect(texts).not.toMatch(/능력|부족합니다|잘합니다/)
})

it('반복 관찰 근거가 없어도 카드는 그 사실을 빈칸 대신 적는다 (T-8)', async () => {
  const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: panelWithCard({ count: 0, versions: [] }) })))
  await openReviewPanel({ ...h, documentId: 'doc-1' })
  expect(h.byText('반복 관찰 근거')).toBeDefined()
  expect(h.byText('다른 버전에서 관찰된 적 없음')).toBeDefined()
})


it('카드의 삭제는 확인을 메인 프로세스에 맡기고, 지웠으면 목록을 다시 읽는다', async () => {
  const getPanel = vi.fn(() => Promise.resolve({ status: 'ok', panel: panelWithCard({ count: 0, versions: [] }) }))
  const h = harness(getPanel)
  const deleteFeedback = vi.fn(() => Promise.resolve({ status: 'deleted' }))
  ;(window as unknown as { agent: Record<string, unknown> }).agent.deleteFeedback = deleteFeedback
  await openReviewPanel({ ...h, documentId: 'doc-1' })
  const before = getPanel.mock.calls.length
  h.byLabel('이 피드백 삭제').click()
  await vi.waitFor(() => expect(getPanel.mock.calls.length).toBeGreaterThan(before))
  expect(deleteFeedback).toHaveBeenCalledWith('doc-1', 'item-1')
  expect(h.notify).toHaveBeenCalledWith('피드백을 삭제했습니다.')
})

it('카드 삭제를 취소하면 아무것도 다시 읽지 않는다', async () => {
  const getPanel = vi.fn(() => Promise.resolve({ status: 'ok', panel: panelWithCard({ count: 0, versions: [] }) }))
  const h = harness(getPanel)
  const deleteFeedback = vi.fn(() => Promise.resolve({ status: 'canceled' }))
  ;(window as unknown as { agent: Record<string, unknown> }).agent.deleteFeedback = deleteFeedback
  await openReviewPanel({ ...h, documentId: 'doc-1' })
  const before = getPanel.mock.calls.length
  h.byLabel('이 피드백 삭제').click()
  await vi.waitFor(() => expect(deleteFeedback).toHaveBeenCalled())
  await Promise.resolve()
  expect(getPanel.mock.calls.length).toBe(before)
})

describe('말로 하는 요청 ([Q-44])', () => {
  function ready(): ReviewPanel {
    const base = panelWithDepths(false)
    return { ...base, paragraphs: ['1. 실험 결과', '176.70 g', '2. 고찰', '오차의 원인은 공기 보정이다.', '3. 결론']
      .map((text, index) => ({ paragraphId: `p${index + 1}`, number: index + 1, text, hasContent: true, role: 'body',
        table: null, sentences: [], equations: [], changed: false })) }
  }
  async function say(text: string, current = ready()) {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: current })))
    await openReviewPanel({ ...h, documentId: 'doc-1' })
    const field = h.byLabel('무엇을 볼지 말로 요청')
    field.value = text
    field.fire('input')
    field.parent!.submit()
    return h
  }

  it('"고찰 부분 피드백해줘" 는 그 제목 아래 문단을 골라 바로 요청한다', async () => {
    const h = await say('고찰 부분 피드백해줘')
    await vi.waitFor(() => expect(h.requestStagedReview).toHaveBeenCalled())
    expect(h.requestStagedReview).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'paragraph', paragraphIds: ['p3', 'p4'], depth: 'quick', stage: 'question', exampleRequested: false }))
    expect(h.notify).toHaveBeenCalledWith('2. 고찰 (문단 2개) · 검토 중…')
  })

  it('못 알아들으면 요청하지 않고 이유를 알린다', async () => {
    const h = await say('서론 봐줘')
    expect(h.requestStagedReview).not.toHaveBeenCalled()
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain('찾지 못했습니다')
  })

  it('"꼼꼼하게" 라고 해도 심층을 쓸 수 없으면 요청하지 않는다', async () => {
    const h = await say('고찰 꼼꼼하게 봐줘')
    expect(h.requestStagedReview).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith('Claude Code 를 찾지 못했습니다.')
  })

})

/**
 * 전문 없이 요청하는 화면 ([Q-45]). 이전에 문단을 눌러 고르던 검증을 요청 칸으로 옮겼다.
 * 지키는 것(깊이 잠금·심층 중단·지침 확정 뒤 요청·오프라인 잠금·관점은 싣지 않음)은 그대로다.
 */
/** 지침만 확정 전인 화면 ([Q-39]). ready 가 false 면 연결도 없다 */
function unconfirmedPanel(ready: boolean): ReviewPanel {
  return {
    ...panelWithDepths(false),
    rubricConfirmed: false,
    readyExceptRubric: ready,
    requestAvailable: false,
    unavailableMessage: ready ? '평가 지침을 먼저 입력하고 확정해 주세요.' : '오프라인',
  }
}

describe('전문 없는 검토 화면 ([Q-45])', () => {
  async function open(current: ReviewPanel) {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: current })))
    await openReviewPanel({ ...h, documentId: 'doc-1' })
    const say = (text: string): void => {
      const field = h.byLabel('무엇을 볼지 말로 요청')
      field.value = text
      field.fire('input')
      field.parent!.submit()
    }
    return { ...h, say }
  }

  it('보고서 본문을 그리지 않는다', async () => {
    const h = await open(panelWithDepths(false))
    expect(h.root.all().some(n => n.className.includes('document-sheet'))).toBe(false)
    expect(h.getDocumentPreview).not.toHaveBeenCalled()
  })

  it('목차를 누르면 고르기만 하고, 요청을 눌러야 보낸다 ([Q-47])', async () => {
    const base = panelWithDepths(false)
    const h = await open({ ...base, paragraphs: ['1. 실험 목적', '몰질량', '2. 고찰', '오차'].map((text, index) => ({
      paragraphId: `p${index + 1}`, number: index + 1, text, hasContent: true, role: 'body' as const,
      table: null, sentences: [], equations: [], changed: index === 3 })) })
    expect(['전체', '바뀐 부분 1', '실험 목적', '고찰'].every(label => h.byText(label) !== undefined)).toBe(true)
    expect(h.byText('요청').disabled).toBe(true)
    h.byText('고찰').click()
    expect(h.requestStagedReview).not.toHaveBeenCalled()
    expect(h.byText('선택: 2. 고찰 (문단 2개)')).toBeDefined()
    expect(h.byText('요청').disabled).toBe(false)
    h.say('')
    await vi.waitFor(() => expect(h.requestStagedReview).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'paragraph', paragraphIds: ['p3', 'p4'] })))
  })

  it('관점은 싣지 않고, 단계는 말에 없으면 프로그램이 정한 대로 요청된다 ([Q-41])', async () => {
    const h = await open({ ...panelWithDepths(false),
      recommended: { perspectives: ['figures', 'references'], stage: 'weak_hint', reason: '지침에서 골랐습니다.' } })
    h.say('전체')
    await vi.waitFor(() => expect(h.requestStagedReview).toHaveBeenCalled())
    const sent = (h.requestStagedReview.mock.calls as unknown as [Record<string, unknown>][])[0]![0]
    expect(sent).toMatchObject({ scope: 'document', stage: 'weak_hint', depth: 'quick' })
    expect('perspectives' in sent).toBe(false)
  })

  it('무엇으로 보는지 한 줄로 적고, 관점 칩은 없다', async () => {
    const h = await open({ ...panelWithDepths(false),
      recommended: { perspectives: ['logic'], stage: 'question', reason: '' } })
    expect(h.root.all().some(n => n.textContent === '질문 · 내용의 논리')).toBe(true)
    expect(h.byText('표·그림 설명')).toBeUndefined()
    const all = await open({ ...panelWithDepths(false), recommended: { perspectives: ['format', 'figures', 'references',
      'scientific_accuracy', 'logic', 'structure', 'expression'], stage: 'question', reason: '' } })
    expect(all.root.all().some(n => n.textContent === '질문 · 모든 관점')).toBe(true)
  })

  it('"꼼꼼하게" 는 심층으로 요청하고, 도는 동안만 중단 버튼이 있다 (T-28)', async () => {
    const h = await open(panelWithDepths(true))
    let finish!: (value: { status: string; message: string }) => void
    h.requestStagedReview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    expect(h.byText('심층 검토 중단')).toBeUndefined()
    h.say('전체 꼼꼼하게')
    await vi.waitFor(() => expect(h.byText('심층 검토 중단')).toBeDefined())
    expect(h.requestStagedReview).toHaveBeenCalledWith(expect.objectContaining({ depth: 'deep' }))
    h.byText('심층 검토 중단').click()
    await Promise.resolve()
    expect(h.cancelDeepReview).toHaveBeenCalled()
    finish({ status: 'failed', message: '중단했습니다.' })
    await vi.waitFor(() => expect(h.byText('심층 검토 중단')).toBeUndefined())
  })



  it('오프라인이면 요청만 잠기고(고르기는 된다) 이유를 적는다', async () => {
    const h = await open(unconfirmedPanel(false))
    h.byText('전체').click()
    expect(h.byText('요청').disabled).toBe(true)
    expect(h.byText('오프라인')).toBeDefined()
  })

  it('예시는 요청 칸으로 열지 않는다 (카드에서 직접)', async () => {
    const h = await open(panelWithDepths(true))
    h.say('전체 예시 보여줘')
    expect(h.requestStagedReview).not.toHaveBeenCalled()
    expect(h.notify).toHaveBeenCalledWith('짧은 수정 예시는 피드백 카드에서 직접 요청해 주세요.')
  })
})

describe('검토와 다듬기를 한 자리에서 ([Q-46])', () => {
  async function open() {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: panelWithDepths(false) })))
    const polishText = vi.fn(() => Promise.resolve({ status: 'polished', text: '온도가 오르자 압력도 올랐다.', modelId: 'gemma' }))
    ;(window as unknown as { agent: Record<string, unknown> }).agent.polishText = polishText
    await openReviewPanel({ ...h, documentId: 'doc-1', subject: '화학' })
    return { ...h, polishText }
  }
  afterEach(async () => { (await import('../src/renderer/src/views/polish.js')).resetPolishState() })

  it('다듬기로 바꾸면 같은 화면에서 다듬고, 과목을 함께 보낸다. 피드백 목록은 그대로 있다', async () => {
    const h = await open()
    expect(h.byLabel('전하고 싶은 내용')).toBeUndefined()
    h.byText('다듬기').click()
    const draft = h.byLabel('전하고 싶은 내용')
    expect(draft).toBeDefined()
    expect(h.byText('피드백')).toBeDefined()
    draft.value = '온도 올리니 압력 올라감'
    draft.fire('input')
    h.root.all().find(n => n.tag === 'button' && n.textContent === '다듬기' && n.className.includes('primary'))!.click()
    await vi.waitFor(() => expect(h.byText('온도가 오르자 압력도 올랐다.')).toBeDefined())
    expect(h.polishText).toHaveBeenCalledWith({ draft: '온도 올리니 압력 올라감', note: '', subject: '화학', depth: 'quick', kind: null })
    // 검토로 돌아갔다 와도 결과가 남아 있다.
    h.byText('검토').click()
    h.byText('다듬기').click()
    expect(h.byText('온도가 오르자 압력도 올랐다.')).toBeDefined()
  })

  it('요청 칸에 "다듬어줘: …" 라고 적으면 다듬기로 넘어가 적은 내용을 채운다 (검토는 요청하지 않는다)', async () => {
    const h = await open()
    const field = h.byLabel('무엇을 볼지 말로 요청')
    field.value = '다듬어줘: 기울기 일정 → 비례인 듯'
    field.fire('input')
    field.parent!.submit()
    expect(h.byLabel('전하고 싶은 내용').value).toBe('기울기 일정 → 비례인 듯')
    expect(h.requestStagedReview).not.toHaveBeenCalled()
    expect(h.polishText).not.toHaveBeenCalled()
  })
})

describe('목차에서 하위 항목 고르기 ([Q-47])', () => {
  const texts = ['1. 실험 목적', '몰질량을 구한다.', '2. 이론적 배경', '가. 이상기체', 'PV=nRT', '나. 수상치환', '돌턴 법칙', '3. 결론', '끝']
  function outlined(): ReviewPanel {
    return { ...panelWithDepths(false), paragraphs: texts.map((text, index) => ({
      paragraphId: `p${index + 1}`, number: index + 1, text, hasContent: true, role: 'body' as const,
      table: null, sentences: [], equations: [], changed: false })) }
  }
  async function open(current: ReviewPanel) {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: current })))
    await openReviewPanel({ ...h, documentId: 'doc-1' })
    const submit = (text = ''): void => {
      const field = h.byLabel('무엇을 볼지 말로 요청')
      field.value = text
      field.fire('input')
      field.parent!.submit()
    }
    return { ...h, submit }
  }

  it('큰 제목을 누르면 가·나 하위 항목이 펼쳐지고, 하위 항목을 골라 요청할 수 있다', async () => {
    const h = await open(outlined())
    expect(h.byText('이상기체')).toBeUndefined()
    h.byText('이론적 배경 ▸').click()
    expect(h.byText('선택: 2. 이론적 배경 (문단 5개)')).toBeDefined()
    h.byText('이상기체').click()
    expect(h.byText('선택: 가. 이상기체 (문단 2개)')).toBeDefined()
    // 윗항목은 눌린 채로, 하위 줄은 펼친 채로 남는다.
    expect(h.byText('이론적 배경 ▸').attributes.get('aria-pressed')).toBe('true')
    h.submit('힌트 줘')
    await vi.waitFor(() => expect(h.requestStagedReview).toHaveBeenCalledWith(expect.objectContaining({
      paragraphIds: ['p4', 'p5'], stage: 'weak_hint' })))
  })

  it('같은 항목을 다시 누르면 고른 것이 풀린다', async () => {
    const h = await open(outlined())
    h.byText('결론').click()
    h.byText('결론').click()
    expect(h.root.all().some(n => n.textContent.startsWith('선택:'))).toBe(false)
  })

  it('AI 목차가 주어지면 그것으로 버튼을 만들고 누가 나눴는지 적는다', async () => {
    const panel = outlined()
    const h = await open({ ...panel, outline: { source: 'ai', status: 'ready', modelId: 'opus', nodes: [
      { title: '서론', level: 1, paragraphIds: ['p1', 'p2'], writtenCount: 2, children: [] },
    ] } })
    expect(h.byText('서론')).toBeDefined()
    expect(h.byText('이론적 배경 ▸')).toBeUndefined()
    expect(h.byText('목차: AI 분석 · opus')).toBeDefined()
  })

  it('AI 목차가 없으면 한 번 저절로 나눠 보고, 실패해도 번호 규칙으로 계속 쓴다', async () => {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: { ...outlined(), requestAvailable: true,
      outline: { source: 'rule' as const, status: 'missing' as const, modelId: null, nodes: [] } } })))
    const analyzeOutline = vi.fn(() => Promise.resolve({ status: 'failed', message: '오프라인이라 번호 규칙으로 나눴습니다.' }))
    ;(window as unknown as { agent: Record<string, unknown> }).agent.analyzeOutline = analyzeOutline
    await openReviewPanel({ ...h, documentId: 'doc-1' })
    await vi.waitFor(() => expect(h.byText('목차: 번호 규칙 · 오프라인이라 번호 규칙으로 나눴습니다.')).toBeDefined())
    expect(analyzeOutline).toHaveBeenCalledTimes(1)
  })
})

describe('요청 결과를 요청 칸 밑에 보인다', () => {
  async function run(reply: unknown) {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: panelWithDepths(false) })))
    h.requestStagedReview.mockResolvedValue(reply as never)
    await openReviewPanel({ ...h, documentId: 'doc-1' })
    h.byText('전체').click()
    h.byLabel('무엇을 볼지 말로 요청').parent!.submit()
    return h
  }

  it('막히면 이유를 화면 안에 적는다 (아래 상태줄만 보고 놓치지 않게)', async () => {
    const h = await run({ status: 'failed', message: '아직 글로 쓴 내용이 없는 문단은 검토를 요청할 수 없습니다.' })
    await vi.waitFor(() => expect(h.byText('문서 전체 · 요청하지 못했습니다 — 아직 글로 쓴 내용이 없는 문단은 검토를 요청할 수 없습니다.')).toBeDefined())
    expect(h.byText('문서 전체 · 요청하지 못했습니다 — 아직 글로 쓴 내용이 없는 문단은 검토를 요청할 수 없습니다.').attributes.get('role')).toBe('alert')
  })

  it('피드백이 0개면 그렇다고 적는다', async () => {
    const h = await run({ status: 'reviewed', itemCount: 0, droppedCount: 0, panel: panelWithDepths(false) })
    await vi.waitFor(() => expect(h.root.all().some(n => n.textContent.includes('피드백 0개'))).toBe(true))
  })
})

describe('평가 지침과 떨어진 검토 ([Q-48])', () => {
  it('지침을 묻지 않고 바로 요청하고, 지침 목록도 읽지 않는다', async () => {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: panelWithDepths(false) })))
    await openReviewPanel({ ...h, documentId: 'doc-1' })
    h.byText('전체').click()
    h.byLabel('무엇을 볼지 말로 요청').parent!.submit()
    await vi.waitFor(() => expect(h.requestStagedReview).toHaveBeenCalled())
    expect(h.byText('어떤 평가 지침으로 검토할까요?')).toBeUndefined()
    expect(h.listRubricTemplates).not.toHaveBeenCalled()
    expect(h.confirmRubric).not.toHaveBeenCalled()
  })

  it('문서 종류를 보여 주고 고칠 수 있다', async () => {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: { ...panelWithDepths(false),
      profile: { kind: '실험 보고서 — 기체 몰질량', source: 'ai' as const } } })))
    const setDocumentKind = vi.fn(() => Promise.resolve({ status: 'saved' }))
    ;(window as unknown as { agent: Record<string, unknown> }).agent.setDocumentKind = setDocumentKind
    await openReviewPanel({ ...h, documentId: 'doc-1' })
    expect(h.byText('실험 보고서 — 기체 몰질량')).toBeDefined()
    expect(h.byText('· AI 짐작')).toBeDefined()
    h.byText('고치기').click()
    const field = h.byLabel('문서 종류')
    field.value = '대회 참가 신청서'
    field.parent!.submit()
    await vi.waitFor(() => expect(setDocumentKind).toHaveBeenCalledWith('doc-1', '대회 참가 신청서'))
  })

  it('종류를 모르면 그렇다고 적고 직접 적을 수 있게 한다', async () => {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: { ...panelWithDepths(false), profile: null } })))
    await openReviewPanel({ ...h, documentId: 'doc-1' })
    expect(h.byText('아직 모름')).toBeDefined()
    expect(h.byText('직접 적기')).toBeDefined()
  })
})

it('목차가 있어도 문서 종류를 아직 모르면 한 번 다시 나눠 종류를 짐작한다 ([Q-48])', async () => {
  const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: { ...panelWithDepths(false), requestAvailable: true,
    profile: null, outline: { source: 'ai' as const, status: 'ready' as const, modelId: 'opus', nodes: [] } } })))
  const analyzeOutline = vi.fn(() => Promise.resolve({ status: 'analyzed', count: 3, modelId: 'opus' }))
  ;(window as unknown as { agent: Record<string, unknown> }).agent.analyzeOutline = analyzeOutline
  await openReviewPanel({ ...h, documentId: 'doc-1' })
  await vi.waitFor(() => expect(analyzeOutline).toHaveBeenCalledTimes(1))
})

describe('저장하고 돌아오면 바뀐 부분 검토 ([Q-51])', () => {
  function saved(versionOrdinal = 2, changed = [false, true]): ReviewPanel {
    const base = { ...panelWithDepths(false), versionOrdinal }
    return { ...base, paragraphs: base.paragraphs.map((p, i) => ({ ...p, changed: changed[i] ?? false })) }
  }
  async function open(current: ReviewPanel, documentId = 'doc-1') {
    const h = harness(vi.fn(() => Promise.resolve({ status: 'ok', panel: current })))
    await openReviewPanel({ ...h, documentId })
    return h
  }

  it('저장 소식이 오지 않으면 묻지 않는다', async () => {
    const h = await open(saved(), 'doc-quiet')
    expect(h.byText('바뀐 부분 검토')).toBeUndefined()
  })

  it('누르면 바뀐 문단을 프로그램이 정한 단계·빠른 검토로 요청하고, 다시 묻지 않는다', async () => {
    noteSaved('doc-a', 2)
    const h = await open(saved(), 'doc-a')
    expect(h.byText('방금 저장 · 바뀐 문단 1개')).toBeDefined()
    expect(h.requestStagedReview).not.toHaveBeenCalled()
    h.byText('바뀐 부분 검토').click()
    await vi.waitFor(() => expect(h.requestStagedReview).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-a', scope: 'paragraph', paragraphIds: ['p2'], stage: 'question', depth: 'quick',
      exampleRequested: false })))
    await vi.waitFor(() => expect(h.byText('바뀐 부분 검토')).toBeUndefined())
  })

  it('`나중에` 를 누르면 이 버전에서는 다시 묻지 않는다', async () => {
    noteSaved('doc-b', 2)
    const h = await open(saved(), 'doc-b')
    h.byText('나중에').click()
    expect(h.byText('바뀐 부분 검토')).toBeUndefined()
    await refreshReviewPanel(h.container, 'doc-b')
    expect(h.byText('바뀐 부분 검토')).toBeUndefined()
    expect(h.requestStagedReview).not.toHaveBeenCalled()
  })

  it('요청할 수 없거나, 바뀐 글이 없거나, 다른 버전이면 묻지 않는다', async () => {
    noteSaved('doc-c', 2)
    expect((await open({ ...saved(), requestAvailable: false, unavailableMessage: '오프라인' }, 'doc-c'))
      .byText('바뀐 부분 검토')).toBeUndefined()
    expect((await open(saved(2, [false, false]), 'doc-c')).byText('바뀐 부분 검토')).toBeUndefined()
    expect((await open(saved(1), 'doc-c')).byText('바뀐 부분 검토')).toBeUndefined()
  })
})
