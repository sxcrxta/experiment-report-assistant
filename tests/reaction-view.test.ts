/**
 * 반응 카드의 심층 재검토 버튼 (`src/renderer/src/views/reaction.ts`, 7단계).
 *
 * 여기서 지키는 것
 * - 재검토를 요청해도 **내가 저장한 판단을 화면에서 지우지 않는다** (`CLAUDE.md` §1).
 * - 요청 중에는 버튼이 잠기고, 끝나면 다시 열린다. 실패해도 잠긴 채로 남지 않는다.
 * - 실패하면 이유를 그대로 보여 준다. 조용히 삼키지 않는다 (`CLAUDE.md` §7).
 *
 * 브라우저 대역으로 이벤트 연결만 본다. 실제 Electron 배치 검증은 따로다.
 */
import { afterEach, expect, it, vi } from 'vitest'

import { renderReaction, renderSelfAssessment } from '../src/renderer/src/views/reaction.js'
import type { UserReaction } from '../src/shared/personalization.js'

import { documentStub, NodeStub } from './helpers/dom-stub.js'

const SAVED: UserReaction = {
  feedbackId: 'item-1',
  documentId: 'doc-1',
  kind: 'rebuttal',
  reason: '표 2에 측정값을 적어 두었습니다.',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

/** 화면이 보는 재검토 결과. 실제 IPC 결과와 같은 모양이면 된다. */
type ReReviewReply = { status: 'reviewed'; itemCount: number; droppedCount: number; panel: unknown }
  | { status: 'failed'; message: string }

function harness(
  requestReReview: () => Promise<ReReviewReply> = vi.fn(
    (): Promise<ReReviewReply> =>
      Promise.resolve({ status: 'reviewed', itemCount: 2, droppedCount: 0, panel: {} }),
  ),
) {
  vi.stubGlobal('document', documentStub())
  vi.stubGlobal('window', { agent: { requestReReview, savePersonalRecord: vi.fn() } })
  const notify = vi.fn()
  const onSaved = vi.fn(() => Promise.resolve())
  const box = renderReaction('doc-1', 'item-1', SAVED, notify, onSaved) as unknown as NodeStub
  const byText = (text: string): NodeStub => box.all().find((node) => node.textContent === text)!
  return { box, notify, onSaved, requestReReview, byText }
}

afterEach(() => vi.unstubAllGlobals())

it('심층 재검토를 요청하고, 끝나면 화면을 다시 읽는다', async () => {
  const h = harness()
  h.byText('심층 재검토 요청').click()
  await Promise.resolve()
  await Promise.resolve()

  expect(h.requestReReview).toHaveBeenCalledWith('doc-1', 'item-1')
  expect(h.onSaved).toHaveBeenCalled()
  expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('피드백 2개'))
})

it('내 판단은 그대로 남는다고 화면에 적는다 (`CLAUDE.md` §1)', () => {
  const h = harness()
  const texts = h.box.all().map((node) => node.textContent).join('\n')

  expect(texts).toContain('저장됨 · 반박')
  expect(texts).toContain('내 판단을 지우지 않습니다')
  // 이제는 잠긴 안내가 아니다.
  expect(texts).not.toContain('준비 중')
  expect(texts).not.toContain('1차 범위 밖')
})

it('실패하면 이유를 보여 주고 버튼을 다시 연다', async () => {
  const h = harness(vi.fn(
    (): Promise<ReReviewReply> =>
      Promise.resolve({ status: 'failed', message: 'Claude Code 에 로그인되어 있지 않습니다.' }),
  ))
  const button = h.byText('심층 재검토 요청')

  button.click()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  expect(h.notify).toHaveBeenLastCalledWith('Claude Code 에 로그인되어 있지 않습니다.')
  expect(button.disabled).toBe(false)
  expect(button.textContent).toBe('심층 재검토 요청')
  // 실패했으므로 화면을 다시 읽지 않는다.
  expect(h.onSaved).not.toHaveBeenCalled()
})

/**
 * 반응은 누르면 바로 저장한다 ([Q-39]). 반박만 사유를 받은 뒤 저장한다 (PRD 4.4).
 */
function fresh(saved: UserReaction | undefined = undefined) {
  vi.stubGlobal('document', documentStub())
  const savePersonalRecord = vi.fn(() => Promise.resolve({ status: 'ok', value: null }))
  vi.stubGlobal('window', { agent: { requestReReview: vi.fn(), savePersonalRecord } })
  const notify = vi.fn()
  const box = renderReaction('doc-1', `item-${Math.random()}`, saved, notify) as unknown as NodeStub
  const byText = (text: string): NodeStub | undefined => box.all().find((node) => node.textContent === text)
  const byLabel = (label: string): NodeStub => box.all().find((node) => node.attributes.get('aria-label') === label)!
  return { box, notify, savePersonalRecord, byText, byLabel }
}

it('동의는 누르는 순간 저장된다', async () => {
  const h = fresh()
  h.byText('동의')!.click()
  await vi.waitFor(() => expect(h.savePersonalRecord).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'reaction', reaction: 'agree', reason: '' })))
  await vi.waitFor(() => expect(h.byText('저장됨 · 동의')).toBeDefined())
  // 동의한 피드백에는 재검토를 권하지 않는다.
  expect(h.byText('심층 재검토 요청')!.hidden).toBe(true)
})

it('반박은 사유 없이 저장하지 않고, 사유를 적어 저장하면 재검토를 고를 수 있다', async () => {
  const h = fresh()
  h.byText('반박')!.click()
  expect(h.savePersonalRecord).not.toHaveBeenCalled()
  expect(h.byLabel('판단·반박 사유').parent!.hidden).toBe(false)

  h.byLabel('판단·반박 사유').value = '표 2에 적어 두었습니다.'
  h.byText('반박 저장')!.click()
  await vi.waitFor(() => expect(h.savePersonalRecord).toHaveBeenCalledWith(
    expect.objectContaining({ reaction: 'rebuttal', reason: '표 2에 적어 두었습니다.' })))
  await vi.waitFor(() => expect(h.byText('심층 재검토 요청')!.hidden).toBe(false))
})

it('사유 칸은 접혀 있다가 원할 때만 연다', () => {
  const h = fresh()
  expect(h.byLabel('판단·반박 사유').parent!.hidden).toBe(true)
  h.byText('사유 덧붙이기')!.click()
  expect(h.byLabel('판단·반박 사유').parent!.hidden).toBe(false)
})

it('자기평가 시점은 부르는 쪽이 정한 값으로 시작하고 바꿀 수 있다', async () => {
  vi.stubGlobal('document', documentStub())
  const savePersonalRecord = vi.fn(() => Promise.resolve({ status: 'ok', value: null }))
  vi.stubGlobal('window', { agent: { savePersonalRecord } })
  const box = renderSelfAssessment(`doc-${Math.random()}`, [], vi.fn(), 'after') as unknown as NodeStub
  const all = () => box.all()
  expect(all().some(n => n.textContent === 'AI 피드백 후 기록으로 저장합니다.')).toBe(true)
  const memo = all().find(n => n.attributes.get('aria-label') === '자기평가 내용')!
  memo.value = '고찰이 짧다.'
  all().find(n => n.tag === 'form')!.submit()
  await vi.waitFor(() => expect(savePersonalRecord).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'assessment', phase: 'after', text: '고찰이 짧다.' })))

  all().find(n => n.attributes.get('aria-label') === '자기평가 시점 바꾸기')!.click()
  expect(all().some(n => n.textContent === 'AI 피드백 전 기록으로 저장합니다.')).toBe(true)
})
