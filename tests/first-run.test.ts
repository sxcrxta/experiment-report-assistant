/**
 * 9단계 — 첫 실행 설정 (문서 선택, 키 등록). 과목은 선택이라 묻지 않는다 ([Q-52]).
 *
 * 여기서 지키는 것
 * - 키 등록은 **선택**이다. 없어도 나머지는 준비된 것으로 본다 (T-33, [Q-21]).
 * - 안내는 남은 일을 알릴 뿐, 무엇도 대신 하지 않는다 (부작용 없는 순수 함수).
 */
import { describe, expect, it, vi } from 'vitest'

import { firstRunGuide, type FirstRunInput } from '../src/app/first-run.js'
import { renderFirstRun } from '../src/renderer/src/views/first-run.js'
import { documentStub, NodeStub } from './helpers/dom-stub.js'

const BASE: FirstRunInput = {
  documents: [],
  keyStatus: 'missing',
  claudeState: 'not-installed',
  dataPath: '/Users/me/Library/Application Support/experiment-agent',
  logPath: '/Users/me/Library/Logs/experiment-agent',
}

describe('첫 실행 남은 단계', () => {
  it('아무것도 하지 않았으면 보고서 불러오기부터 안내한다', () => {
    const guide = firstRunGuide(BASE)
    expect(guide.ready).toBe(false)
    expect(guide.complete).toBe(false)
    expect(guide.next?.id).toBe('document')
    expect(guide.steps.map((step) => step.done)).toEqual([false, false, false])
    expect(guide.dataPath).toBe(BASE.dataPath)
  })

  it('키가 없어도 문서가 있으면 준비된 것으로 본다 (T-33)', () => {
    const guide = firstRunGuide({ ...BASE, documents: [{ subject: '일반화학실험' }] })
    expect(guide.ready).toBe(true)
    // 선택 단계가 남아 있으므로 complete 는 아직 아니다. 안내는 계속 보인다.
    expect(guide.complete).toBe(false)
    expect(guide.next?.id).toBe('key')
    expect(guide.steps.find((step) => step.id === 'key')?.optional).toBe(true)
    expect(guide.steps.find((step) => step.id === 'key')?.detail).toContain('등록하지 않아도')
  })

  it('과목이 비어 있어도 묻지 않는다 — 과목은 선택이다 ([Q-52])', () => {
    const guide = firstRunGuide({
      ...BASE,
      documents: [{ subject: null }, { subject: '   ' }],
      keyStatus: 'registered', claudeState: 'ready',
    })
    expect(guide).toMatchObject({ ready: true, complete: true, next: null })
    expect(guide.steps.map((step) => step.id)).toEqual(['document', 'key', 'claude'])
  })

  it('모두 마치면 남은 단계가 없다', () => {
    const guide = firstRunGuide({
      ...BASE, documents: [{ subject: '물리' }], keyStatus: 'registered', claudeState: 'ready',
    })
    expect(guide).toMatchObject({ ready: true, complete: true, next: null })
  })

  it('Claude 모드가 없어도 준비된 것으로 보고, 심층 검토만 선택으로 남는다 ([Q-30])', () => {
    const guide = firstRunGuide({
      ...BASE, documents: [{ subject: '물리' }], keyStatus: 'registered', claudeState: 'not-installed',
    })
    const claude = guide.steps.find((step) => step.id === 'claude')
    expect(guide.ready).toBe(true)
    expect(guide.complete).toBe(false)
    expect(claude?.optional).toBe(true)
    expect(claude?.done).toBe(false)
    expect(claude?.detail).toContain('빠른 검토')
    expect(guide.next?.id).toBe('claude')
  })

  it('로그인하지 않았으면 무엇을 하면 되는지 알려 준다', () => {
    const guide = firstRunGuide({
      ...BASE, documents: [{ subject: '물리' }], keyStatus: 'registered', claudeState: 'not-logged-in',
    })
    expect(guide.steps.find((step) => step.id === 'claude')?.detail).toContain('claude auth login')
  })

  it('키체인을 읽지 못하면 등록된 것으로 치지 않고 그 사실을 적는다', () => {
    const guide = firstRunGuide({ ...BASE, documents: [{ subject: '물리' }], keyStatus: 'unreadable' })
    expect(guide.complete).toBe(false)
    expect(guide.steps.find((step) => step.id === 'key')?.detail).toContain('확인하지 못했습니다')
  })

  it('입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다 (T-10)', () => {
    const input: FirstRunInput = { ...BASE, documents: [{ subject: null }] }
    const before = JSON.stringify(input)
    expect(firstRunGuide(input)).toEqual(firstRunGuide(input))
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('첫 실행 안내 화면', () => {
  function render(input: FirstRunInput) {
    vi.stubGlobal('document', documentStub())
    const onImport = vi.fn()
    const onSettings = vi.fn()
    const card = renderFirstRun({ guide: firstRunGuide(input), onImport, onSettings })
    const root = card as unknown as NodeStub | null
    return { root, onImport, onSettings,
      text: () => (root?.all() ?? []).map((node) => node.textContent).join('\n'),
      by: (label: string) => (root?.all() ?? []).find((node) => node.textContent === label) }
  }

  it('남은 단계마다 그 일을 하는 화면으로 보낸다', () => {
    const h = render(BASE)
    expect(h.text()).toContain('시작하기 전에')
    h.by('＋ 보고서 불러오기')!.click()
    expect(h.onImport).toHaveBeenCalled()
    h.by('설정에서 키 등록하기')!.click()
    expect(h.onSettings).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('저장 위치를 적어 백업할 곳을 알려 준다', () => {
    const h = render(BASE)
    expect(h.text()).toContain(BASE.dataPath)
    expect(h.text()).toContain(BASE.logPath)
    vi.unstubAllGlobals()
  })

  it('다 끝냈으면 안내를 그리지 않는다', () => {
    const h = render({
      ...BASE, documents: [{ subject: '물리' }], keyStatus: 'registered', claudeState: 'ready',
    })
    expect(h.root).toBeNull()
    vi.unstubAllGlobals()
  })

  it('심층 검토 준비가 남아 있으면 안내를 계속 보여 준다', () => {
    const h = render({
      ...BASE, documents: [{ subject: '물리' }], keyStatus: 'registered', claudeState: 'not-installed',
    })
    expect(h.root).not.toBeNull()
    expect(h.text()).toContain('심층 검토 준비')
    vi.unstubAllGlobals()
  })
})
