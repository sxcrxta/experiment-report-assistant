/**
 * 글 다듬기 ([Q-43], 사용자 결정 — PRD 밖의 기능). 검토 화면 안의 `다듬기` 로 들어간다 ([Q-46]).
 *
 * 전하고 싶은 내용을 적으면 AI 가 보고서 문체로 다듬어 준다. 결과는 **화면에만** 보이고,
 * 한글로 옮기는 것은 사용자다 (프로그램은 HWPX 에 쓰지 않는다).
 *
 * 쓰던 글과 결과는 탭을 옮겨도 남는다. 저장하지는 않는다.
 * 파일·네트워크에 직접 닿지 않는다. window.agent (preload 브리지)만 쓴다.
 */
import { POLISH_DRAFT_MAX_LENGTH, POLISH_NOTE_MAX_LENGTH, type DocumentSummary } from '../../../shared/ipc.js'
import type { ReviewDepth } from '../../../shared/review.js'
import { element, toggleButton } from './dom.js'

export interface PolishViewOptions {
  container: HTMLElement
  /** 고른 보고서. 과목을 함께 보낸다. 없어도 쓸 수 있다 */
  document: DocumentSummary | undefined
  notify: (message: string) => void
}

/** 탭을 옮겨도 남는 상태 */
const state: {
  draft: string
  note: string
  depth: ReviewDepth
  result: { text: string; modelId: string } | null
  running: boolean
} = { draft: '', note: '', depth: 'quick', result: null, running: false }

export const POLISH_OUTBOUND_NOTE = '적은 내용·요청·과목·문서 종류만 보냅니다. 보고서 본문은 보내지 않습니다.'

function button(text: string, action: () => void, className?: string): HTMLButtonElement {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

export interface PolishBoxOptions {
  /** 고른 보고서의 과목. 함께 보낸다. 없으면 null */
  subject: string | null
  /** 문서 종류 ([Q-48]). 다듬을 때마다 읽는다. 없으면 null */
  kindOf?: () => string | null
  notify: (message: string) => void
  /** 꼼꼼하게(심층)를 지금 쓸 수 있는가. 못 쓰면 그 이유 */
  deepAvailable: boolean
  deepMessage: string
}

/** 다듬는 중인가. 도는 동안에는 칸을 새로 만들지 않는다 (결과가 옛 칸에 도착하지 않게) */
export function isPolishRunning(): boolean {
  return state.running
}

/** 검토 화면의 요청 칸에서 "다듬어줘: …" 로 넘어올 때 적은 내용을 채워 둔다 */
export function setPolishDraft(text: string): void {
  if (text.trim() !== '') state.draft = text.trim()
}

/**
 * 다듬기 칸 하나. 검토 화면 안에 끼워 쓰고([Q-46]), 보고서가 없을 때는 `openPolish` 가 홀로 띄운다.
 * 스스로 다시 그린다. 쓰던 글과 결과는 화면을 옮겨도 남는다.
 */
export function createPolishBox(options: PolishBoxOptions): HTMLElement {
  const { notify, deepAvailable, deepMessage } = options
  const box = element('div', 'polish-content')
  if (!deepAvailable) state.depth = 'quick'

  function render(): void {
    const draft = element('textarea', 'polish-draft')
    draft.rows = 6
    draft.maxLength = POLISH_DRAFT_MAX_LENGTH
    draft.value = state.draft
    draft.placeholder = '전하고 싶은 내용을 적으세요. 예: 온도 올리니까 압력도 올라감. 기울기 일정 → 비례하는 듯'
    draft.setAttribute('aria-label', '전하고 싶은 내용')
    const count = element('span', 'muted', `${state.draft.length} / ${POLISH_DRAFT_MAX_LENGTH}`)

    const note = element('input')
    note.maxLength = POLISH_NOTE_MAX_LENGTH
    note.value = state.note
    note.placeholder = '요청 (선택) · 예: 고찰 첫 문단, 짧게'
    note.setAttribute('aria-label', '요청')

    const submit = button(state.running ? '다듬는 중…' : '다듬기', () => { void polish() }, 'primary-button')
    submit.title = POLISH_OUTBOUND_NOTE
    const sync = (): void => {
      state.draft = draft.value
      state.note = note.value
      count.textContent = `${draft.value.length} / ${POLISH_DRAFT_MAX_LENGTH}`
      submit.disabled = state.running || draft.value.trim() === ''
    }
    draft.addEventListener('input', sync)
    note.addEventListener('input', sync)

    const depth = element('div', 'segment')
    depth.setAttribute('role', 'group')
    depth.setAttribute('aria-label', '다듬기 깊이')
    depth.append(toggleButton('', '빠르게', state.depth === 'quick', () => { state.depth = 'quick'; render() }))
    const deep = toggleButton('', '꼼꼼하게', state.depth === 'deep', () => {
      if (!deepAvailable) { notify(deepMessage || '심층 검토(Claude Code)를 쓸 수 없습니다.'); return }
      state.depth = 'deep'; render()
    })
    if (!deepAvailable) { deep.setAttribute('aria-disabled', 'true'); deep.title = deepMessage }
    depth.append(deep)

    const actions = element('div', 'polish-actions')
    actions.append(depth, count, submit)
    if (state.running && state.depth === 'deep') {
      actions.append(button('중단', () => { void window.agent.cancelDeepReview() }))
    }
    const parts: HTMLElement[] = [draft, note, actions]

    if (state.result !== null) {
      const result = state.result
      const out = element('section', 'polish-result')
      out.setAttribute('aria-label', '다듬은 글')
      out.append(element('p', 'polish-text', result.text))
      const foot = element('div', 'polish-actions')
      foot.append(element('span', 'muted', `AI 가 쓴 글 · ${result.modelId} · 사실과 수치를 확인하고 옮기세요`),
        button('복사', () => { void copy(result.text) }))
      out.append(foot)
      parts.push(out)
    }

    box.replaceChildren(...parts)
    sync()
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      notify('복사했습니다. 한글에 붙여 넣으세요.')
    } catch (cause) {
      console.error('복사 실패', cause)
      notify('복사하지 못했습니다. 글을 직접 선택해 복사해 주세요.')
    }
  }

  async function polish(): Promise<void> {
    if (state.running || state.draft.trim() === '') return
    state.running = true
    render()
    notify(state.depth === 'deep' ? '꼼꼼하게 다듬는 중… (몇 분 걸릴 수 있습니다)' : '다듬는 중…')
    try {
      const result = await window.agent.polishText({ draft: state.draft, note: state.note,
        subject: options.subject, depth: state.depth, kind: options.kindOf?.() ?? null })
      if (result.status === 'failed') { notify(result.message); return }
      state.result = { text: result.text, modelId: result.modelId }
      notify('다듬었습니다.')
    } catch (cause) {
      console.error('다듬기 실패', cause)
      notify('글을 다듬지 못했습니다. 다시 시도해 주세요.')
    } finally {
      state.running = false
      render()
    }
  }

  render()
  return box
}

/** 보고서를 고르지 않았을 때 검토 자리에 다듬기만 띄운다. 심층을 쓸 수 있는지는 설정에서 읽는다 */
export async function openPolish(options: PolishViewOptions): Promise<void> {
  const { container, notify } = options
  let deepAvailable = false
  let deepMessage = ''
  try {
    const settings = await window.agent.getAiSettings()
    if (settings.status === 'ok') {
      deepAvailable = settings.settings.claude.deepAvailable
      deepMessage = settings.settings.claude.deepUnavailableMessage
    }
  } catch (cause) {
    console.error('AI 설정 확인 실패', cause)
  }
  const header = element('header', 'page-heading')
  const titles = element('div')
  titles.append(element('h1', undefined, '글 다듬기'),
    element('p', undefined, '보고서를 고르면 이 자리에서 검토도 요청할 수 있습니다.'))
  header.append(titles)
  container.replaceChildren(header,
    createPolishBox({ subject: options.document?.subject ?? null, notify, deepAvailable, deepMessage }))
}

/** 테스트에서만 쓴다. 탭 사이에 남는 상태를 비운다 */
export function resetPolishState(): void {
  Object.assign(state, { draft: '', note: '', depth: 'quick', result: null, running: false })
}
