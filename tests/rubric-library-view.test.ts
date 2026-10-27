/**
 * 평가 지침 탭 — 모음과 적용 ([Q-40]).
 *
 * 브라우저 대역으로 이벤트 연결과 화면 글만 본다. 실제 Electron 배치 검증은 따로다.
 * - 적용은 사용자가 누른 버튼에서만 일어난다.
 * - 저장 버튼에 따라가는 보고서 수가 적혀, 저장이 어디에 적용되는지 알고 누르게 한다.
 * - 보고서에서 고친 보고서에는 "다시 따르기" 가 보인다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openRubricTab } from '../src/renderer/src/views/rubric-library.js'
import type { DocumentSummary, RubricTemplateView } from '../src/shared/ipc.js'

import { documentStub, NodeStub } from './helpers/dom-stub.js'

const DOC: DocumentSummary = {
  documentId: 'doc-1', displayName: '실험1.hwpx', path: '/tmp/실험1.hwpx', subject: '일반화학실험',
  versionCount: 1, paragraphCount: 3, pathLost: false, checkpoints: [], summary: null,
}

function template(overrides: Partial<RubricTemplateView> = {}): RubricTemplateView {
  return { id: 't-1', name: '화학 기본', updatedAt: '2026-09-22T00:00:00.000Z',
    items: [{ itemId: 'a', title: '실험 목적', description: '', importance: 4 }],
    followingDocumentIds: [], detachedDocumentIds: [], ...overrides }
}

const CHECKED = {
  overall: 50, createdAt: '2026-09-28T00:00:00.000Z', modelId: 'opus', documentChanged: false, checklistChanged: false,
  results: [
    { title: '실험 목적', score: 100, status: 'met', evidence: '1번 제목 아래 목적이 적혀 있다.', paragraphNumbers: [12] },
    { title: '참고문헌', score: 0, status: 'missing', evidence: '참고문헌 목록이 없다.', paragraphNumbers: [] },
  ],
}

function harness(opts: { templates?: RubricTemplateView[]; link?: unknown; current?: number | null } = {}) {
  vi.stubGlobal('document', documentStub())
  const agent = {
    listRubricTemplates: vi.fn(() => Promise.resolve({ status: 'ok', templates: opts.templates ?? [template()],
      link: opts.link ?? null, suggestedId: 't-1' })),
    getRubric: vi.fn(() => Promise.resolve({ status: 'ok', editor: { documentId: 'doc-1', draft: null,
      current: opts.current == null ? null : { ordinal: opts.current, rubricVersion: 'r', confirmedAt: '', items: [] },
      history: [] } })),
    applyRubricTemplate: vi.fn(() => Promise.resolve({ status: 'applied', ordinal: 2 })),
    updateRubricTemplate: vi.fn(() => Promise.resolve({ status: 'saved', updatedDocuments: 1,
      template: template({ followingDocumentIds: ['doc-1'] }) })),
    createRubricTemplate: vi.fn(),
    deleteRubricTemplate: vi.fn(() => Promise.resolve({ status: 'canceled' })),
    saveDocumentRubricToLibrary: vi.fn(),
    suggestRubricDraft: vi.fn(),
    getCheck: vi.fn((): Promise<unknown> => Promise.resolve({ status: 'ok', check: null })),
    runCheck: vi.fn((): Promise<unknown> => Promise.resolve({ status: 'checked', check: CHECKED })),
  }
  vi.stubGlobal('window', { agent })
  const root = new NodeStub('main')
  const notify = vi.fn()
  const onRubricChanged = vi.fn()
  const open = (document: DocumentSummary | undefined) => openRubricTab({
    container: root as unknown as HTMLElement, document, documents: [DOC], notify, onRubricChanged,
    onSubjectChanged: () => Promise.resolve() })
  const byText = (text: string) => root.all().find((n) => n.textContent === text)
  const text = () => root.all().map((n) => n.textContent).join('\n')
  return { root, agent, notify, onRubricChanged, open, byText, text }
}

afterEach(() => vi.unstubAllGlobals())

it('보고서를 고르지 않아도 지침 모음은 보인다', async () => {
  const h = harness()
  await h.open(undefined)
  expect(h.byText('지침 모음 (1)')).toBeDefined()
  expect(h.byText('화학 기본')).toBeDefined()
  expect(h.agent.getRubric).not.toHaveBeenCalled()
})

it('적용은 누를 때만 일어나고, 적용한 보고서의 검토 화면을 새로 읽게 한다', async () => {
  const h = harness()
  await h.open(DOC)
  expect(h.agent.applyRubricTemplate).not.toHaveBeenCalled()
  expect(h.text()).toContain('아직 적용한 지침이 없습니다')
  h.byText('적용')!.click()
  await vi.waitFor(() => expect(h.agent.applyRubricTemplate).toHaveBeenCalledWith('doc-1', 't-1'))
  await vi.waitFor(() => expect(h.onRubricChanged).toHaveBeenCalledWith(['doc-1']))
})

it('따라가는 보고서가 있으면 저장 버튼에 그 수를 적는다', async () => {
  const h = harness({ templates: [template({ followingDocumentIds: ['doc-1'] })],
    link: { templateId: 't-1', templateName: '화학 기본', following: true }, current: 1 })
  await h.open(DOC)
  expect(h.text()).toContain("'화학 기본' 적용 중")
  h.byText('고치기')!.click()
  expect(h.byText('저장 · 따라가는 보고서 1개에도 적용')).toBeDefined()
  expect(h.text()).toContain('따라가는 보고서(실험1)의 지침도 함께 확정됩니다')
  h.byText('저장 · 따라가는 보고서 1개에도 적용')!.click()
  await vi.waitFor(() => expect(h.agent.updateRubricTemplate).toHaveBeenCalled())
  await vi.waitFor(() => expect(h.onRubricChanged).toHaveBeenCalledWith(['doc-1']))
})

it('보고서에서 고친 보고서에는 다시 따르기와 모음에 저장이 보인다', async () => {
  const h = harness({ link: { templateId: 't-1', templateName: '화학 기본', following: false }, current: 3 })
  await h.open(DOC)
  expect(h.text()).toContain('이 보고서에서 고쳤습니다')
  expect(h.byText('모음 지침 다시 따르기')).toBeDefined()
  expect(h.byText('이 지침을 모음에 저장')).toBeDefined()
})

it('삭제를 확인 창에서 취소하면 아무것도 바뀌지 않는다', async () => {
  const h = harness()
  await h.open(DOC)
  h.byText('삭제')!.click()
  await vi.waitFor(() => expect(h.agent.deleteRubricTemplate).toHaveBeenCalledWith('t-1'))
  expect(h.agent.listRubricTemplates).toHaveBeenCalledTimes(1)
})

describe('제출 점검 ([Q-48])', () => {
  it('점검표를 확정하지 않았으면 점검할 수 없다', async () => {
    const h = harness({ current: null })
    await h.open(DOC)
    expect(h.byText('양식 점검')!.disabled).toBe(true)
    expect(h.agent.getCheck).not.toHaveBeenCalled()
  })

  it('누를 때만 점검하고, 전체 충족도와 조건마다 퍼센트·근거를 보여 준다 ([Q-49])', async () => {
    const h = harness({ current: 1 })
    await h.open(DOC)
    await vi.waitFor(() => expect(h.byText('아직 점검하지 않았습니다. `양식 점검` 을 눌러 주세요.')).toBeDefined())
    expect(h.agent.runCheck).not.toHaveBeenCalled()
    h.byText('양식 점검')!.click()
    await vi.waitFor(() => expect(h.byText('참고문헌 목록이 없다.')).toBeDefined())
    expect(h.agent.runCheck).toHaveBeenCalledWith('doc-1')
    expect(h.byText('50%')).toBeDefined()
    expect(h.byText('100%')).toBeDefined()
    expect(h.byText('0%')).toBeDefined()
    expect(h.text()).toContain('충족 1 / 2')
    expect(h.byText('문단 12')).toBeDefined()
    expect(h.notify).toHaveBeenCalledWith('양식 충족도 50%')
  })

  it('지난 결과가 낡았으면 그렇다고 적는다', async () => {
    const h = harness({ current: 1 })
    h.agent.getCheck.mockResolvedValue({ status: 'ok', check: { ...CHECKED, documentChanged: true } })
    await h.open(DOC)
    await vi.waitFor(() => expect(h.text()).toContain('점검한 뒤 보고서를 다시 저장했습니다.'))
  })
})

describe('조건은 한 줄 ([Q-50])', () => {
  it('예전의 이름 + 설명을 한 줄로 합쳐 보여 주고, 저장할 때 설명을 따로 남기지 않는다', async () => {
    vi.stubGlobal('document', documentStub())
    const { createRubricItemList, oneLine } = await import('../src/renderer/src/views/rubric-editor.js')
    expect(oneLine({ title: '실험 방법', description: '실험이 누가 봐도 재현가능하게 서술해야 함.' }))
      .toBe('실험 방법 — 실험이 누가 봐도 재현가능하게 서술해야 함.')
    expect(oneLine({ title: '고찰 부분은 200자 이상이어야 한다.', description: '' })).toBe('고찰 부분은 200자 이상이어야 한다.')
    expect(oneLine({ title: '가'.repeat(90), description: '나'.repeat(50) })).toHaveLength(100)

    const editor = createRubricItemList([
      { itemId: 'a', title: '실험 방법', description: '실험이 누가 봐도 재현가능하게 서술해야 함.', importance: 4 },
    ], () => undefined)
    const root = editor.list as unknown as NodeStub
    expect(root.all().filter((n) => n.tag === 'textarea')).toEqual([])
    const field = root.all().find((n) => n.tag === 'input')!
    expect(field.value).toBe('실험 방법 — 실험이 누가 봐도 재현가능하게 서술해야 함.')
    expect(field.attributes.get('placeholder') ?? (field as unknown as { placeholder: string }).placeholder)
      .toBe('예: 고찰 부분은 200자 이상이어야 한다.')
    // 중요도는 보이지 않게 그대로 들고 간다 (저장소가 값을 요구한다).
    expect(editor.collect()).toEqual([
      { itemId: 'a', title: '실험 방법 — 실험이 누가 봐도 재현가능하게 서술해야 함.', description: '', importance: 4 },
    ])
  })

  it('지침 모음 카드는 조건을 한 줄에 하나씩 보여 준다', async () => {
    const h = harness({ templates: [template({ items: [
      { itemId: 'a', title: '실험 방법', description: '재현 가능해야 한다.', importance: 3 },
      { itemId: 'b', title: '고찰 부분은 200자 이상이어야 한다.', description: '', importance: 3 },
    ] })] })
    await h.open(undefined)
    expect(h.byText('실험 방법 — 재현 가능해야 한다.')).toBeDefined()
    expect(h.byText('고찰 부분은 200자 이상이어야 한다.')).toBeDefined()
    expect(h.byText('조건 2개')).toBeDefined()
  })
})
