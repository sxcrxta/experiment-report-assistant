/**
 * 글 다듬기 ([Q-43], 사용자 결정 2026-09-28 — PRD 밖의 기능).
 *
 * 지키는 것
 * - 빈 글·오프라인·연결 없음이면 모델을 부르지 않는다
 * - 나가는 것은 적은 글·요청·과목뿐이다 (`CLAUDE.md` §4)
 * - 깊이는 `modelFor` 로만 고른다 (`CLAUDE.md` §5)
 * - 형식을 어긴 응답은 정해진 횟수만 다시 묻고, 원문을 결과인 척 보여 주지 않는다
 * - 결과는 화면에만 보인다 (HWPX 에 쓰는 통로가 없다)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelCallResult, ReviewModel, ReviewModelSet } from '../src/adapters/model/index.js'
import { parsePolish, polishLimit } from '../src/adapters/model/prompts/polish.v1.js'
import { renderPolishPrompt } from '../src/adapters/model/prompts/polish.v2.js'
import { createPolishService, toPolishPayload, type PolishInput } from '../src/app/polish.js'
import { createPolishHandler, parsePolishRequest } from '../src/main/polish-ipc.js'
import { openPolish, resetPolishState, POLISH_OUTBOUND_NOTE } from '../src/renderer/src/views/polish.js'
import { POLISH_DRAFT_MAX_LENGTH } from '../src/shared/ipc.js'

import { documentStub, NodeStub } from './helpers/dom-stub.js'

function fakeModel(modelId: string, replies: ModelCallResult[], available = true): ReviewModel & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    modelId, promptVersion: 'x', calls,
    checkAvailability: () => Promise.resolve(available ? { available: true }
      : { available: false, reason: 'no-key', message: '키를 등록해 주세요.' }),
    review: () => Promise.reject(new Error('검토를 부르면 안 됩니다')),
    polishText: (payload) => {
      calls.push(payload)
      return Promise.resolve(replies.shift() ?? { ok: false, reason: 'server-error', message: '더 이상 답이 없습니다.' })
    },
  }
}

const INPUT: PolishInput = { draft: '온도 올리니 압력 올라감. 기울기 일정', note: '고찰', subject: '화학', depth: 'quick' }
const ok = (text: string): ModelCallResult => ({ ok: true, text: JSON.stringify({ text }) })

function service(quick: ReviewModel, deep: ReviewModel = fakeModel('deep', []), online = true) {
  const models: ReviewModelSet = { quick, deep }
  return createPolishService({ models, online: { isOnline: () => online } })
}

describe('프롬프트와 응답 읽기', () => {
  it('문서 종류가 있으면 그 문서의 문체로 다듬으라고 적는다 (2판, [Q-48])', () => {
    const prompt = renderPolishPrompt({ ...toPolishPayload(INPUT), kind: '대회 참가 신청서' })
    expect(prompt).toContain('"대회 참가 신청서" 에 들어갈 글입니다')
    expect(renderPolishPrompt(toPolishPayload(INPUT))).not.toContain('들어갈 글입니다')
  })

  it('적은 내용·요청·과목을 싣고, 지어내지 말라는 규칙을 담는다', () => {
    const prompt = renderPolishPrompt(toPolishPayload(INPUT))
    expect(prompt).toContain(INPUT.draft)
    expect(prompt).toContain('고찰')
    expect(prompt).toContain('화학')
    expect(prompt).toContain('더하지 마세요')
  })

  it('JSON 의 text 만 꺼내고, 형식을 어기면 null 이다', () => {
    expect(parsePolish('앞말 {"text":"온도가 오르면 압력도 올랐다."} 뒷말', 'x')).toBe('온도가 오르면 압력도 올랐다.')
    expect(parsePolish('그냥 글', 'x')).toBeNull()
    expect(parsePolish('{"text":""}', 'x')).toBeNull()
    expect(parsePolish('{"text":3}', 'x')).toBeNull()
  })

  it('적은 글보다 지나치게 긴 결과는 지어낸 것으로 보고 받지 않는다', () => {
    const draft = '짧은 메모'
    expect(parsePolish(JSON.stringify({ text: '가'.repeat(polishLimit(draft) + 1) }), draft)).toBeNull()
  })
})

describe('다듬기 서비스', () => {
  it('다듬은 글과 모델 이름을 돌려주고, 나가는 것은 적은 글·요청·과목뿐이다', async () => {
    const quick = fakeModel('gemma', [ok('온도가 오르자 압력도 올랐다.')])
    const result = await service(quick).polish(INPUT)
    expect(result).toEqual({ ok: true, text: '온도가 오르자 압력도 올랐다.', modelId: 'gemma' })
    expect(quick.calls).toEqual([{ subject: '화학', note: '고찰', draft: INPUT.draft, kind: '' }])
  })

  it('빈 글·너무 긴 글·오프라인이면 모델을 부르지 않는다', async () => {
    const quick = fakeModel('gemma', [ok('x')])
    expect((await service(quick).polish({ ...INPUT, draft: '   ' })).ok).toBe(false)
    expect((await service(quick).polish({ ...INPUT, draft: '가'.repeat(POLISH_DRAFT_MAX_LENGTH + 1) })).ok).toBe(false)
    expect((await service(quick, undefined, false).polish(INPUT)).ok).toBe(false)
    expect(quick.calls).toEqual([])
  })

  it('연결할 수 없으면 그 이유를 그대로 알린다', async () => {
    const quick = fakeModel('gemma', [], false)
    expect(await service(quick).polish(INPUT)).toEqual({ ok: false, message: '키를 등록해 주세요.' })
    expect(quick.calls).toEqual([])
  })

  it('형식을 어긴 응답은 한 번 더 묻고, 그래도 어기면 원문을 보여 주지 않고 실패를 알린다', async () => {
    const quick = fakeModel('gemma', [{ ok: true, text: '형식 없는 글' }, { ok: true, text: '또 형식 없는 글' }])
    const result = await service(quick).polish(INPUT)
    expect(quick.calls).toHaveLength(2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).not.toContain('형식 없는 글')
  })

  it('키·네트워크 실패는 다시 묻지 않는다', async () => {
    const quick = fakeModel('gemma', [{ ok: false, reason: 'network', message: '연결 실패' }])
    expect(await service(quick).polish(INPUT)).toEqual({ ok: false, message: '연결 실패' })
    expect(quick.calls).toHaveLength(1)
  })

  it('꼼꼼하게(심층)는 심층 어댑터로 간다', async () => {
    const quick = fakeModel('gemma', [])
    const deep = fakeModel('opus', [ok('다듬은 글')])
    expect(await service(quick, deep).polish({ ...INPUT, depth: 'deep' })).toMatchObject({ ok: true, modelId: 'opus' })
    expect(quick.calls).toEqual([])
  })
})

describe('IPC 입력 확인', () => {
  it('형태가 틀린 값은 받지 않는다', () => {
    expect(parsePolishRequest(INPUT)).toEqual({ ...INPUT, kind: '' })
    expect(parsePolishRequest({ ...INPUT, kind: '실험 보고서' })).toEqual({ ...INPUT, kind: '실험 보고서' })
    expect(parsePolishRequest({ ...INPUT, subject: null })).not.toBeNull()
    expect(parsePolishRequest({ ...INPUT, depth: 'turbo' })).toBeNull()
    expect(parsePolishRequest({ ...INPUT, draft: 1 })).toBeNull()
    expect(parsePolishRequest('글')).toBeNull()
  })

  it('실패는 문구로 돌아온다', async () => {
    const handle = createPolishHandler(service(fakeModel('gemma', [])))
    expect(await handle({ nope: true })).toMatchObject({ status: 'failed' })
  })
})

describe('다듬기 화면', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetPolishState() })

  async function open(polishText: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('document', documentStub())
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('window', { agent: {
      polishText,
      cancelDeepReview: vi.fn(),
      getAiSettings: () => Promise.resolve({ status: 'ok', settings: { claude: { deepAvailable: false, deepUnavailableMessage: '없음' } } }),
    } })
    const root = new NodeStub('main')
    const notify = vi.fn()
    await openPolish({ container: root as unknown as HTMLElement, notify,
      document: { subject: '화학' } as never })
    const byText = (text: string) => root.all().find(n => n.textContent === text)
    const byLabel = (label: string) => root.all().find(n => n.attributes.get('aria-label') === label)
    return { root, notify, byText, byLabel, writeText }
  }

  it('적기 전에는 누를 수 없고, 적어서 누르면 과목과 함께 보낸 뒤 결과와 복사 버튼을 보여 준다', async () => {
    const polishText = vi.fn(() => Promise.resolve({ status: 'polished', text: '온도가 오르자 압력도 올랐다.', modelId: 'gemma' }))
    const h = await open(polishText)
    expect(h.byText('다듬기')!.disabled).toBe(true)
    expect((h.byText('다듬기') as unknown as { title: string }).title).toBe(POLISH_OUTBOUND_NOTE)

    const draft = h.byLabel('전하고 싶은 내용')!
    draft.value = '온도 올리니 압력 올라감'
    draft.fire('input')
    h.byText('다듬기')!.click()
    await vi.waitFor(() => expect(h.byText('온도가 오르자 압력도 올랐다.')).toBeDefined())
    expect(polishText).toHaveBeenCalledWith({ draft: '온도 올리니 압력 올라감', note: '', subject: '화학', depth: 'quick', kind: null })

    h.byText('복사')!.click()
    await vi.waitFor(() => expect(h.writeText).toHaveBeenCalledWith('온도가 오르자 압력도 올랐다.'))
  })

  it('실패하면 이유만 알리고 결과 자리를 만들지 않는다', async () => {
    const polishText = vi.fn(() => Promise.resolve({ status: 'failed', message: '오프라인입니다.' }))
    const h = await open(polishText)
    const draft = h.byLabel('전하고 싶은 내용')!
    draft.value = '메모'
    draft.fire('input')
    h.byText('다듬기')!.click()
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith('오프라인입니다.'))
    expect(h.byLabel('다듬은 글')).toBeUndefined()
  })

  it('심층을 쓸 수 없으면 꼼꼼하게를 눌러도 이유만 알린다', async () => {
    const h = await open(vi.fn())
    h.byText('꼼꼼하게')!.click()
    expect(h.notify).toHaveBeenCalledWith('없음')
    expect(h.byText('빠르게')!.attributes.get('aria-pressed')).toBe('true')
  })
})

describe('보조 창 위치 ([Q-44])', () => {
  it('작업 영역 오른쪽 끝에 위아래로 꽉 차게 붙이고, 좁은 화면에서는 넘치지 않는다', async () => {
    const { compactBounds, COMPACT_WIDTH } = await import('../src/main/window-mode.js')
    expect(compactBounds({ x: 0, y: 25, width: 1440, height: 875 }))
      .toEqual({ x: 1440 - COMPACT_WIDTH, y: 25, width: COMPACT_WIDTH, height: 875 })
    expect(compactBounds({ x: 100, y: 0, width: 300, height: 600 })).toEqual({ x: 100, y: 0, width: 300, height: 600 })
  })
})
