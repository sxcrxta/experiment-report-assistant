/**
 * 검토 화면 — **말로 요청하고 피드백을 받는다** ([Q-44], [Q-45]).
 *
 * 보고서 전문을 보여 주지 않는다 ([Q-45], 사용자 결정). 본문은 한글에서 보고, 여기서는
 * "고찰 부분 피드백해줘" 처럼 요청한다. 무엇이 대상인지는 `shared/review-command.ts` 가 정한다 (AI 아님).
 * 자주 쓰는 요청(전체·바뀐 부분·번호 제목)은 한 번 눌러 보낼 수 있게 늘어놓는다.
 *
 * 그대로 지키는 것
 * - 관점은 고르지 않는다 ([Q-41]). 단계는 말에 없으면 프로그램이 추천한 단계를 쓴다.
 * - **짧은 수정 예시는 여기서 열지 않는다.** 카드에서 사용자가 직접 요청할 때만 열린다 (PRD 4.2).
 * - 지침 확정만 빠졌으면 요청 자리에서 지침을 골라 확정한 뒤 요청한다 ([Q-39], [Q-40]).
 * - 오프라인이거나 키가 없으면 요청만 막고 이유를 적는다. 목록·반응은 그대로 쓴다 (PRD 5절).
 * - 상위 5개 카드만 먼저 보여 주고 나머지는 "나머지 N개 더 보기".
 *
 * 파일·네트워크에 직접 닿지 않는다. window.agent (preload 브리지)만 쓴다.
 */
import {
  type AnchorDecision,
  type FeedbackCard,
  type ParagraphChoice,
  type ReviewPanel,
  type SectionOverride,
  type StagedReviewInput,
} from '../../../shared/feedback.js'
import {
  DEFAULT_REVIEW_DEPTH,
  REVIEW_PERSPECTIVE_LABELS,
  REVIEW_PERSPECTIVES,
  REVIEW_STAGE_LABELS,
  type ReviewDepth,
  type ReviewStage,
} from '../../../shared/review.js'
import { interpretReviewCommand, outlineOf, readStageAndDepth, targetOfNode, type CommandTarget } from '../../../shared/review-command.js'
import { shortTitle, type OutlineNode } from '../../../shared/outline.js'

import { element, option, toggleButton } from './dom.js'
import { renderFeedbackCard } from './feedback-card.js'
import { renderSelfAssessment } from './reaction.js'
import { createPolishBox, isPolishRunning, setPolishDraft } from './polish.js'
import type { SelfAssessment, UserReaction } from '../../../shared/personalization.js'

export interface ReviewPanelOptions {
  container: HTMLElement
  documentId: string
  /** 다듬기에 과목을 함께 보낸다 ([Q-46]). 없으면 과목 없이 */
  subject?: string | null
  /** 화면 위쪽 안내 문구를 바꾼다 */
  notify: (message: string) => void
}

/** 문단 한 줄에 보일 글. 너무 길면 줄인다. */
function preview(paragraph: ParagraphChoice): string {
  const text = paragraph.text === '' ? '(빈 문단)' : paragraph.text
  const cut = text.length > 40 ? `${text.slice(0, 40)}…` : text
  return `문단 ${paragraph.number} — ${cut}`
}

const openPanels = new WeakMap<HTMLElement, {
  documentId: string; refresh: () => Promise<void>; dispose: () => void
}>()

/**
 * 방금 저장해 새로 생긴 버전 ([Q-51]). 보고서마다 하나. 검토 화면이 이 버전을 그리면
 * "바뀐 문단 N개 · 검토할까요?" 를 띄운다. 요청은 여전히 사용자가 누른다 — 저장만으로 AI 를 부르지 않는다.
 * 화면이 아직 열리지 않은 보고서도 기억해 두었다가 열 때 보인다.
 */
const savedVersions = new Map<string, number>()

export function noteSaved(documentId: string, versionOrdinal: number): void {
  savedVersions.set(documentId, versionOrdinal)
}

export async function refreshReviewPanel(container: HTMLElement, documentId: string): Promise<void> {
  const panel = openPanels.get(container)
  if (panel?.documentId === documentId) await panel.refresh()
}

export async function openReviewPanel(options: ReviewPanelOptions): Promise<void> {
  const { container, documentId, notify } = options
  openPanels.get(container)?.dispose()
  /** 마지막으로 그린 화면. 요청 중 상태만 바뀔 때 다시 그리는 데 쓴다 */
  let lastPanel: ReviewPanel | null = null
  /** 심층 검토가 도는 동안만 중단 버튼을 보인다 ([Q-39]) */
  let deepRunning = false
  /** 마지막으로 요청한 깊이. 카드에서 다음 단계를 요청할 때 같은 깊이를 쓴다 */
  let lastDepth: ReviewDepth = DEFAULT_REVIEW_DEPTH
  /** "나머지 N개 더 보기" 를 눌렀는가 */
  let includeAll = false
  /** 검토와 다듬기를 한 자리에서 오간다 ([Q-46]) */
  let mode: 'review' | 'polish' = 'review'
  /**
   * 다듬기 칸. 한 번 만들어 계속 쓴다 — 다듬는 사이 화면을 다시 그려도 결과가 이 칸에 도착하게.
   */
  let polishBox: HTMLElement | null = null
  /** 목차에서 고른 항목 ([Q-47]). key 는 전체 'all', 바뀐 부분 'changed', 목차는 'o/2/0' 같은 위치 */
  let picked: { key: string; target: CommandTarget | null; label: string } | null = null
  /** 목차를 AI 로 나누는 중인가, 마지막으로 실패한 까닭, 저절로 나눠 본 버전 */
  let outlineRunning = false
  let outlineMessage = ''
  let autoOutlineVersion: number | null = null
  /** 문서 종류를 고치는 중인가 ([Q-48]) */
  let editingKind = false
  /** 마지막 요청의 결과. 요청 칸 바로 밑에 보인다 */
  let outcome: { kind: 'running' | 'failed' | 'empty' | 'ok'; text: string } | null = null
  /** 말로 하는 요청 칸에 쓰던 글. 다시 그려도 남는다 */
  let commandText = ''
  const owner = { documentId, refresh, dispose: () => undefined }
  openPanels.set(container, owner)
  let refreshSequence = 0
  let personal: {reactions:UserReaction[];assessments:SelfAssessment[]} = {reactions:[],assessments:[]}
  container.replaceChildren(element('div', 'review-loading empty-inline', '검토 기록을 불러오는 중입니다…'))

  function showLoadError(message: string): void {
    container.querySelector('.review-loading')?.remove()
    container.querySelector('.review-load-error')?.remove()
    const error = element('div', 'review-load-error path-notice')
    error.setAttribute('role', 'alert')
    error.append(element('span', undefined, `${message} 표시 중인 기록은 갱신되지 않았을 수 있습니다.`))
    const retry = element('button', undefined, '다시 불러오기')
    retry.addEventListener('click', () => { void refresh() })
    error.append(retry)
    container.prepend(error)
    notify(message)
  }

  async function refresh(): Promise<void> {
    const sequence = ++refreshSequence
    let result
    try {
      const [panelResult, records] = await Promise.all([
        window.agent.getReviewPanel(documentId, includeAll),
        window.agent.getPersonalRecords(documentId),
      ])
      result = panelResult
      if (openPanels.get(container) !== owner || sequence !== refreshSequence) return
      if (records.status==='failed') { showLoadError(records.message); return }
      if (records.status==='ok') personal=records.value
    } catch (cause) {
      if (openPanels.get(container) !== owner || sequence !== refreshSequence) return
      console.error('검토 화면 읽기 실패', cause)
      showLoadError('검토 화면을 불러오지 못했습니다.')
      return
    }
    if (openPanels.get(container) !== owner || sequence !== refreshSequence) return
    if (result.status === 'failed') {
      showLoadError(result.message)
      return
    }
    render(result.panel)
  }


  async function request(input: StagedReviewInput, label = ''): Promise<void> {
    const what = label === '' ? '' : `${label} · `
    const running = input.depth === 'deep' ? `${what}심층 검토 중… (몇 분 걸릴 수 있습니다)` : `${what}검토 중…`
    notify(running)
    // 결과를 아래 상태줄에만 두지 않고 요청 칸 바로 밑에도 적는다. 실패를 놓치지 않게 한다.
    outcome = { kind: 'running', text: running }
    if (input.depth === 'deep') deepRunning = true
    if (lastPanel !== null) render(lastPanel)
    let result
    try {
      result = await window.agent.requestStagedReview(input)
    } catch (cause) {
      console.error('검토 요청 실패', cause)
      result = { status: 'failed' as const, message: '검토를 요청하지 못했습니다. 다시 시도해 주세요.' }
    } finally {
      if (input.depth === 'deep') deepRunning = false
    }
    if (openPanels.get(container) !== owner) return
    if (result.status === 'failed') {
      notify(result.message)
      outcome = { kind: 'failed', text: `${what}요청하지 못했습니다 — ${result.message}` }
      if (lastPanel !== null) render(lastPanel)
      return
    }
    const done = `${what}피드백 ${result.itemCount}개` +
      (result.droppedCount > 0 ? ` (형식 오류 ${result.droppedCount}개 제외)` : '')
    notify(done)
    outcome = result.itemCount === 0
      ? { kind: 'empty', text: `${what}AI 가 이 부분에서 짚을 점을 찾지 못했습니다 (피드백 0개). 다른 부분이나 다음 단계를 요청해 보세요.` }
      : { kind: 'ok', text: done }
    await refresh()
  }

  function decideAnchor(anchorId: string, decision: AnchorDecision): void {
    void (async () => {
      const result = await window.agent.decideSentenceAnchor(anchorId, decision)
      if (result.status === 'failed') {
        notify(result.message)
        return
      }
      notify(
        decision.choice === 'relink'
          ? '고르신 문장에 다시 연결했습니다.'
          : '찾지 못한 채로 두기로 확인했습니다.',
      )
      await refresh()
    })()
  }

  /** 피드백 하나를 지운다. 확인 창은 메인 프로세스가 띄운다. */
  async function deleteFeedback(card: FeedbackCard): Promise<void> {
    const result = await window.agent.deleteFeedback(documentId, card.itemId)
    if (openPanels.get(container) !== owner) return
    if (result.status === 'canceled') return
    if (result.status === 'failed') { notify(result.message); return }
    notify('피드백을 삭제했습니다.')
    await refresh()
  }

  /** 카드에서 다음 단계를 요청한다. 그 카드가 가리키던 대상 그대로 다시 묻는다. */
  function advance(
    panel: ReviewPanel,
    card: FeedbackCard,
    stage: ReviewStage,
    exampleRequested: boolean,
  ): void {
    const input: StagedReviewInput = {
      documentId,
      scope: card.scope,
      depth: lastDepth,
      perspectives: [card.perspective],
      stage,
      exampleRequested,
    }

    if (card.scope === 'paragraph') input.paragraphIds = [card.paragraphId]
    if (card.scope === 'sentence') {
      const index = card.anchor?.sentenceIndex ?? null
      if (index === null) {
        notify('이 피드백이 가리키는 문장을 먼저 확인해 주세요.')
        return
      }
      input.sentence = { paragraphId: card.paragraphId, sentenceIndex: index }
    }
    if (card.scope === 'section') {
      const section = panel.sections.find(
        (candidate) =>
          card.paragraphNumber !== null &&
          candidate.startIndex <= card.paragraphNumber - 1 &&
          card.paragraphNumber - 1 <= candidate.endIndex,
      )
      if (section === undefined) {
        notify('이 피드백이 속한 보고서 항목을 찾지 못했습니다. 항목 경계를 확인해 주세요.')
        return
      }
      input.sectionOrdinal = section.ordinal
    }

    void request(input)
  }

  // -------------------------------------------------------------------------
  // 그리기
  // -------------------------------------------------------------------------

  /**
   * 정한 대상으로 검토를 요청한다. 말로 하는 요청과 추천 요청이 같은 길을 지난다.
   * 단계 순서·선행 작성 확인은 메인 프로세스가 한 번 더 강제한다.
   */
  function submitTarget(panel: ReviewPanel, target: CommandTarget, stage: ReviewStage, depth: ReviewDepth, label: string): void {
    const input: StagedReviewInput = {
      documentId,
      scope: target.kind === 'document' ? 'document' : target.kind === 'section' ? 'section' : 'paragraph',
      depth,
      // 관점은 싣지 않는다. 메인 프로세스가 확정한 지침으로 정한다 ([Q-41]).
      stage,
      // 여기서는 예시를 요청하지 않는다. 예시는 카드의 요청 버튼에서만 열린다.
      exampleRequested: false,
    }
    if (target.kind === 'paragraphs') input.paragraphIds = [...target.paragraphIds]
    if (target.kind === 'section') input.sectionOrdinal = target.ordinal
    lastDepth = depth
    void request(input, label)
  }

  /** 말을 대상으로 바꿔 요청한다. 알아듣지 못하면 요청하지 않고 이유를 알린다 */
  function say(panel: ReviewPanel, text: string): boolean {
    // "다듬어줘: 온도 올리니 압력 올라감" 은 다듬기로 넘긴다. 콜론 뒤를 적은 내용으로 채운다 ([Q-46]).
    // 보고서 본문을 다듬지는 않는다 — 사용자가 적은 글만 다듬는다 ([Q-43]).
    if (/다듬|매끄럽게/.test(text)) {
      const colon = text.search(/[:：]/)
      if (colon >= 0) setPolishDraft(text.slice(colon + 1))
      // 채운 글이 보이도록 칸을 새로 만든다. 다듬는 중이면 그대로 둔다.
      if (!isPolishRunning()) polishBox = null
      mode = 'polish'
      render(panel)
      return true
    }
    const result = interpretReviewCommand(text, panel)
    if (!result.ok) { notify(result.message); return false }
    const depth = result.depth ?? DEFAULT_REVIEW_DEPTH
    const option = panel.depths.find((entry) => entry.depth === depth)
    if (option !== undefined && !option.available) { notify(option.unavailableMessage); return false }
    submitTarget(panel, result.target, result.stage ?? panel.recommended.stage, depth, result.label)
    return true
  }

  /** 목차에서 고른 것. 누르기만 해서는 요청하지 않는다 — `요청` 을 눌러야 간다 ([Q-47]) */
  function pick(key: string, target: CommandTarget | null, label: string): void {
    picked = picked?.key === key ? null : { key, target, label }
  }

  /** 고른 것(있으면)과 적은 말로 요청한다 */
  function submit(panel: ReviewPanel, text: string): boolean {
    if (picked === null || /다듬|매끄럽게/.test(text)) return say(panel, text)
    if (text.includes('예시')) { notify('짧은 수정 예시는 피드백 카드에서 직접 요청해 주세요.'); return false }
    if (picked.target === null) { notify(`'${picked.label}' 에는 바로 쓴 글이 없습니다. 아래 하위 항목을 골라 주세요.`); return false }
    // 고른 항목이 대상이고, 적은 말에서는 단계·깊이만 읽는다 ("힌트 줘", "꼼꼼하게").
    const { stage, depth } = readStageAndDepth(text)
    const chosen = depth ?? DEFAULT_REVIEW_DEPTH
    const option = panel.depths.find((entry) => entry.depth === chosen)
    if (option !== undefined && !option.available) { notify(option.unavailableMessage); return false }
    submitTarget(panel, picked.target, stage ?? panel.recommended.stage, chosen, picked.label)
    picked = null
    return true
  }

  /**
   * AI 로 목차를 나눈다 ([Q-47]). 화면을 열었는데 AI 목차가 없거나 제목이 바뀌었으면 버전마다 한 번 저절로,
   * 그 밖에는 `다시 나누기` 를 누를 때. 실패해도 번호 규칙 목차로 계속 쓴다.
   */
  async function analyzeOutline(): Promise<void> {
    if (outlineRunning) return
    outlineRunning = true
    if (lastPanel !== null) render(lastPanel)
    try {
      const result = await window.agent.analyzeOutline(documentId)
      outlineMessage = result.status === 'failed' ? result.message : ''
    } catch (cause) {
      console.error('목차 나누기 실패', cause)
      outlineMessage = '목차를 나누지 못해 번호 규칙으로 나눴습니다.'
    } finally {
      outlineRunning = false
    }
    if (openPanels.get(container) === owner) await refresh()
  }

  /** 목차 한 줄(같은 급의 항목들)을 버튼으로 */
  function outlineRow(panel: ReviewPanel, nodes: readonly OutlineNode[], path: string): HTMLElement {
    const row = element('div', 'chips command-chips')
    nodes.forEach((node, index) => {
      const key = `${path}/${index}`
      const target = targetOfNode(node, panel.paragraphs)
      const onPath = picked !== null && (picked.key === key || picked.key.startsWith(`${key}/`))
      const chip = toggleButton('chip', `${shortTitle(node.title)}${node.children.length > 0 ? ' ▸' : ''}`, onPath, () => {
        if (target === null && node.children.length === 0) { notify(`'${node.title}' 아래에 아직 쓴 내용이 없습니다.`); return }
        // 제목 바로 아래 글이 없고 하위 항목만 있으면, 고르면 하위 항목만 펼친다.
        pick(key, target?.target ?? null, target?.label ?? node.title)
        render(panel)
      })
      chip.title = node.title
      row.append(chip)
    })
    return row
  }

  /**
   * 저장하고 돌아오면 바뀐 부분을 한 번에 요청할 수 있게 한다 ([Q-51]).
   * 이 버전에 바뀐 글이 있고 지금 요청할 수 있을 때만 보인다. 누르거나 닫으면 이 버전에서는 다시 묻지 않는다.
   */
  function savePrompt(panel: ReviewPanel): HTMLElement | null {
    if (panel.versionOrdinal === null || savedVersions.get(documentId) !== panel.versionOrdinal) return null
    if (!panel.requestAvailable) return null
    const ids = panel.paragraphs.filter((p) => p.changed && p.hasContent).map((p) => p.paragraphId)
    if (ids.length === 0) return null
    const box = element('div', 'save-prompt')
    box.setAttribute('role', 'status')
    box.append(element('span', undefined, `방금 저장 · 바뀐 문단 ${ids.length}개`))
    const go = element('button', 'primary-button', '바뀐 부분 검토')
    go.type = 'button'
    go.addEventListener('click', () => {
      savedVersions.delete(documentId)
      submitTarget(panel, { kind: 'paragraphs', paragraphIds: ids }, panel.recommended.stage, DEFAULT_REVIEW_DEPTH,
        `바뀐 문단 ${ids.length}개`)
    })
    const later = element('button', 'text-button', '나중에')
    later.type = 'button'
    later.addEventListener('click', () => { savedVersions.delete(documentId); render(panel) })
    box.append(go, later)
    return box
  }

  /**
   * 요청 자리 ([Q-44], [Q-47]).
   * 위: 말로 적는 칸과 `요청`. 아래: 목차 — 누르면 **고르기만** 하고, 하위 항목(가·나…)이 펼쳐진다.
   * 고른 뒤 칸에 "힌트 줘" 처럼 적으면 그 단계로 요청한다.
   */
  function requestBar(panel: ReviewPanel): HTMLElement {
    const bar = element('div', 'review-bar')
    const usable = panel.requestAvailable || panel.readyExceptRubric
    bar.setAttribute('aria-disabled', String(!usable))

    const nodes = outlineOf(panel)
    const form = element('form', 'command-box')
    const field = element('input', 'command-input')
    field.value = commandText
    field.placeholder = picked === null
      ? '무엇을 볼까요? 예: 고찰 부분 피드백해줘 · 3번 문단 — 또는 아래에서 고르기'
      : '덧붙일 말 (선택) · 예: 힌트 줘, 설명해줘, 꼼꼼하게'
    field.setAttribute('aria-label', '무엇을 볼지 말로 요청')
    const go = element('button', 'primary-button', '요청')
    go.type = 'submit'
    const sync = (): void => {
      go.disabled = !usable || (picked === null ? field.value.trim() === '' : picked.target === null && field.value.trim() === '')
    }
    field.addEventListener('input', () => { commandText = field.value; sync() })
    sync()
    form.append(field, go)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (submit(panel, field.value)) { commandText = ''; field.value = ''; render(panel) }
    })
    bar.append(form)
    if (outcome !== null) {
      const line = element('div', `request-outcome request-outcome--${outcome.kind}${outcome.kind === 'failed' ? ' notice' : ''}`, outcome.text)
      line.setAttribute('role', outcome.kind === 'failed' ? 'alert' : 'status')
      bar.append(line)
    }

    if (picked !== null) {
      const line = element('div', 'picked-line')
      line.append(element('span', undefined, `선택: ${picked.label}`), (() => {
        const clear = element('button', 'text-button', '해제')
        clear.type = 'button'
        clear.addEventListener('click', () => { picked = null; render(panel) })
        return clear
      })())
      bar.append(line)
    }

    // 맨 윗줄: 전체 · 바뀐 부분 · 큰 제목들. 고른 항목에 하위 항목이 있으면 그 아래 줄에 펼친다.
    const top = outlineRow(panel, nodes, 'o')
    const written = panel.paragraphs.filter((p) => p.hasContent)
    const changed = written.filter((p) => p.changed)
    const special: [string, string, CommandTarget][] = []
    if (written.length > 0) special.push(['all', '전체', { kind: 'document' }])
    if (changed.length > 0) special.push(['changed', `바뀐 부분 ${changed.length}`, { kind: 'paragraphs', paragraphIds: changed.map((p) => p.paragraphId) }])
    top.prepend(...special.map(([key, label, target]) => toggleButton('chip', label, picked?.key === key, () => {
      pick(key, target, key === 'all' ? '문서 전체' : `바뀐 문단 ${changed.length}개`)
      render(panel)
    })))
    bar.append(top)
    let level: readonly OutlineNode[] = nodes
    let path = 'o'
    const steps = picked?.key.startsWith('o/') === true ? picked.key.split('/').slice(1).map(Number) : []
    for (const step of steps) {
      const node = level[step]
      if (node === undefined || node.children.length === 0) break
      path = `${path}/${step}`
      const sub = outlineRow(panel, node.children, path)
      sub.className += ' command-chips--sub'
      bar.append(sub)
      level = node.children
    }

    // 목차를 누가 나눴는지 한 줄 ([Q-47]).
    if (panel.outline !== undefined) {
      const info = element('div', 'outline-info muted')
      const source = outlineRunning ? '목차를 AI 로 나누는 중…'
        : panel.outline.source === 'ai'
          ? `목차: AI 분석 · ${panel.outline.modelId ?? ''}${panel.outline.status === 'stale' ? ' · 제목이 바뀌었습니다' : ''}`
          : `목차: 번호 규칙${outlineMessage === '' ? '' : ` · ${outlineMessage}`}`
      info.append(element('span', undefined, source))
      if (!outlineRunning) {
        const again = element('button', 'text-button', panel.outline.source === 'ai' ? '다시 나누기' : 'AI 로 나누기')
        again.type = 'button'
        again.addEventListener('click', () => { void analyzeOutline() })
        info.append(again)
      }
      bar.append(info)
    }

    // 무엇으로 보는지 한 줄로 알려 준다. 관점은 평가 지침이 정한다 ([Q-41]).
    const lenses = panel.recommended.perspectives
    const lens = lenses.length === REVIEW_PERSPECTIVES.length
      ? '모든 관점' : lenses.map(p => REVIEW_PERSPECTIVE_LABELS[p]).join(' · ')
    const summary = element('span', 'muted', `${REVIEW_STAGE_LABELS[panel.recommended.stage]} · ${lens}`)
    summary.title = `${panel.recommended.reason} 말에 "힌트·설명", "꼼꼼하게" 를 넣으면 단계·깊이가 바뀝니다.`
    bar.append(summary)

    if (deepRunning) {
      const cancel = element('button', undefined, '심층 검토 중단')
      cancel.type = 'button'
      cancel.addEventListener('click', () => {
        void (async () => {
          const result = await window.agent.cancelDeepReview()
          notify(result.status === 'canceled' ? '심층 검토를 중단했습니다.' : '지금 실행 중인 심층 검토가 없습니다.')
        })()
      })
      bar.append(cancel)
    }

    if (!usable) bar.append(element('div', 'notice', panel.unavailableMessage))
    return bar
  }

  /** 추정된 항목 경계를 보여 주고 사용자가 고친다 (PRD 4.2). */
  function sectionEditor(panel: ReviewPanel): HTMLElement {
    const box = element('details', 'section-editor')
    box.append(element('summary', undefined, `보고서 항목 (${panel.sections.length})`))
    if (panel.sectionNotice !== '') box.append(element('div', 'notice', panel.sectionNotice))

    const table = element('table', 'section-table')
    const head = element('tr')
    for (const label of ['', '이름', '시작 문단', '끝 문단', '']) {
      head.append(element('th', undefined, label))
    }
    table.append(head)

    const rows: {
      row: HTMLTableRowElement; number: HTMLTableCellElement; title: HTMLInputElement
      start: HTMLSelectElement; end: HTMLSelectElement; remove: HTMLButtonElement
    }[] = []
    function renumber(): void {
      rows.forEach((entry, index) => {
        const ordinal = index + 1
        entry.number.textContent = String(ordinal)
        entry.title.setAttribute('aria-label', `${ordinal}번 항목 이름`)
        entry.start.setAttribute('aria-label', `${ordinal}번 항목 시작 문단`)
        entry.end.setAttribute('aria-label', `${ordinal}번 항목 끝 문단`)
        entry.remove.setAttribute('aria-label', `${ordinal}번 항목 삭제`)
        entry.remove.disabled = rows.length === 1
      })
    }
    function addRow(titleText: string, startId: string, endId: string): void {
      const row = element('tr')
      const title = element('input')
      title.type = 'text'
      title.value = titleText
      const number = element('td')
      const start = paragraphSelect(panel, startId, '')
      const end = paragraphSelect(panel, endId, '')
      const remove = element('button', undefined, '삭제')
      remove.type = 'button'
      const entry = { row, number, title, start, end, remove }
      remove.addEventListener('click', () => {
        const index = rows.indexOf(entry)
        if (rows.length <= 1 || index === -1) return
        rows.splice(index, 1)
        row.remove()
        renumber()
      })

      row.append(
        number,
        cell(title),
        cell(start),
        cell(end),
        cell(remove),
      )
      table.append(row)
      rows.push(entry)
      renumber()
    }
    for (const section of panel.sections) {
      addRow(section.title, section.startParagraphUuid, section.endParagraphUuid)
    }
    box.append(table)

    const actions = element('div', 'anchor-actions')
    const add = element('button', undefined, '항목 추가')
    add.type = 'button'
    add.disabled = panel.paragraphs.length === 0
    add.addEventListener('click', () => {
      const first = panel.paragraphs[0]
      if (first === undefined) return
      addRow('새 항목', first.paragraphId, first.paragraphId)
      rows.at(-1)?.title.focus()
    })
    const save = element('button', undefined, '경계 저장')
    save.type = 'button'
    save.addEventListener('click', () => {
      const overrides: SectionOverride[] = rows.map((row, index) => ({
        ordinal: index + 1,
        title: row.title.value,
        startParagraphUuid: row.start.value,
        endParagraphUuid: row.end.value,
      }))
      void saveSections(overrides)
    })

    const reset = element('button', 'text-button', '자동으로 되돌리기')
    reset.type = 'button'
    reset.addEventListener('click', () => {
      void saveSections([])
    })

    actions.append(add, save, reset)
    box.append(actions)
    return box
  }

  function cell(child: HTMLElement): HTMLTableCellElement {
    const td = element('td')
    td.append(child)
    return td
  }

  function paragraphSelect(panel: ReviewPanel, selected: string, label: string): HTMLSelectElement {
    const select = element('select')
    select.setAttribute('aria-label', label)
    for (const paragraph of panel.paragraphs) select.append(option(paragraph.paragraphId, preview(paragraph)))
    select.value = selected
    return select
  }

  async function saveSections(overrides: SectionOverride[]): Promise<void> {
    const result = await window.agent.saveSectionBoundaries(documentId, overrides)
    if (result.status === 'failed') {
      notify(result.message)
      return
    }
    notify(overrides.length === 0 ? '항목 경계를 자동으로 되돌렸습니다.' : '항목 경계를 저장했습니다.')
    await refresh()
  }

  function cardList(panel: ReviewPanel): HTMLElement {
    const box = element('section')
    box.append(element('h3', undefined, '피드백'))

    if (panel.cards.length === 0) {
      box.append(element('p', 'muted', '아직 없습니다. 위에서 요청해 보세요.'))
      return box
    }

    const list = element('div', 'card-list')
    for (const card of panel.cards) {
      list.append(
        renderFeedbackCard({
          card,
          documentId, reaction:personal.reactions.find(r=>r.feedbackId===card.itemId), notify,
          onAdvance: (target, stage, exampleRequested) =>
            advance(panel, target, stage, exampleRequested),
          onDecideAnchor: decideAnchor,
          onDelete: target => { void deleteFeedback(target) },
        }),
      )
    }
    box.append(list)

    if (panel.hiddenCount > 0) {
      const more = element('button', 'more-button', `나머지 ${panel.hiddenCount}개 더 보기`)
      more.type = 'button'
      more.addEventListener('click', () => {
        includeAll = true
        void refresh()
      })
      box.append(more)
    }
    return box
  }

  /**
   * 문서 종류 한 줄 ([Q-48]). 검토·다듬기가 참고한다. AI 가 목차를 나누며 짐작하고, 사용자가 고친다.
   * 고친 값은 AI 가 다시 짐작해도 덮지 않는다.
   */
  function profileLine(panel: ReviewPanel): HTMLElement {
    const line = element('div', 'profile-line')
    const profile = panel.profile ?? null
    if (editingKind) {
      const form = element('form', 'inline-form')
      const field = element('input')
      field.value = profile?.kind ?? ''
      field.maxLength = 80
      field.placeholder = '예: 실험 보고서 — 기체의 몰질량 측정'
      field.setAttribute('aria-label', '문서 종류')
      const save = element('button', 'primary-button', '저장')
      save.type = 'submit'
      const cancel = element('button', 'text-button', '취소')
      cancel.type = 'button'
      cancel.addEventListener('click', () => { editingKind = false; render(panel) })
      form.append(field, save, cancel)
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        void (async () => {
          const result = await window.agent.setDocumentKind(documentId, field.value)
          if (result.status === 'failed') { notify(result.message); return }
          editingKind = false
          notify('문서 종류를 저장했습니다. 다음 검토·다듬기부터 참고합니다.')
          await refresh()
        })()
      })
      line.append(element('span', 'muted', '문서:'), form)
      return line
    }
    line.append(element('span', 'muted', '문서:'),
      element('strong', undefined, profile?.kind ?? '아직 모름'),
      element('span', 'muted', profile === null ? '· 목차를 나누면 AI 가 짐작합니다'
        : profile.source === 'ai' ? '· AI 짐작' : '· 직접 적음'))
    const edit = element('button', 'text-button', profile === null ? '직접 적기' : '고치기')
    edit.type = 'button'
    edit.addEventListener('click', () => { editingKind = true; render(panel) })
    line.append(edit)
    return line
  }

  /** 검토 | 다듬기 전환 */
  function modeSwitch(panel: ReviewPanel): HTMLElement {
    const group = element('div', 'segment mode-switch')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', '할 일')
    group.append(toggleButton('', '검토', mode === 'review', () => { mode = 'review'; render(panel) }),
      toggleButton('', '다듬기', mode === 'polish', () => { mode = 'polish'; render(panel) }))
    return group
  }

  function polishArea(panel: ReviewPanel): HTMLElement {
    if (polishBox === null) {
      const deep = panel.depths.find((entry) => entry.depth === 'deep')
      polishBox = createPolishBox({
        subject: options.subject ?? null, notify,
        // 다듬기도 문서 종류에 맞는 문체로 ([Q-48]). 칸은 한 번 만들므로 그때그때 읽는다.
        kindOf: () => lastPanel?.profile?.kind ?? null, deepAvailable: deep?.available ?? false, deepMessage: deep?.unavailableMessage ?? '',
      })
    }
    return polishBox
  }

  /** 새로 읽은 목차 위에서 고른 항목을 다시 찾는다. 없어졌으면 고른 것을 푼다 */
  function repick(panel: ReviewPanel): void {
    if (picked === null) return
    if (picked.key === 'all') return
    if (picked.key === 'changed') {
      const ids = panel.paragraphs.filter((p) => p.changed && p.hasContent).map((p) => p.paragraphId)
      picked = ids.length === 0 ? null : { key: 'changed', target: { kind: 'paragraphs', paragraphIds: ids }, label: `바뀐 문단 ${ids.length}개` }
      return
    }
    let level: readonly OutlineNode[] = outlineOf(panel)
    let node: OutlineNode | undefined
    for (const step of picked.key.split('/').slice(1).map(Number)) {
      node = level[step]
      if (node === undefined) { picked = null; return }
      level = node.children
    }
    if (node === undefined) { picked = null; return }
    const target = targetOfNode(node, panel.paragraphs)
    picked = { key: picked.key, target: target?.target ?? null, label: target?.label ?? node.title }
  }

  function render(panel: ReviewPanel): void {
    if (openPanels.get(container) !== owner) return
    repick(panel)
    // AI 목차가 없거나 제목이 바뀌었거나, 아직 문서 종류를 모르면 버전마다 한 번 저절로 나눠 본다
    // ([Q-47], [Q-48] — 문서 종류는 목차와 같은 호출에서 짐작한다). 요청은 막지 않는다.
    const needsOutline = panel.outline !== undefined && (panel.outline.status !== 'ready' || panel.profile === null)
    if (needsOutline && panel.versionOrdinal !== null
      && autoOutlineVersion !== panel.versionOrdinal && (panel.requestAvailable || panel.readyExceptRubric)) {
      autoOutlineVersion = panel.versionOrdinal
      // 그리는 도중에 다시 그리지 않게 이번 그리기가 끝난 뒤 시작한다.
      queueMicrotask(() => { void analyzeOutline() })
    }
    // 다시 그려도 읽던 자리가 튀지 않게 한다.
    const pane = container.parentElement
    const scrollTop = pane?.scrollTop ?? 0
    lastPanel = panel
    const header = element('header', 'review-heading')
    header.append(element('h2', undefined, panel.documentName.replace(/\.hwpx$/i, '')),
      element('div', 'muted', panel.versionOrdinal === null ? '저장 기록 없음' : `버전 ${panel.versionOrdinal}`))
    const content = element('div', 'review-content')
    // 자기평가 시점은 이 버전에 받은 피드백이 있는지로 정해 둔다. 바꿀 수 있다 ([Q-39]).
    const prompt = mode === 'review' ? savePrompt(panel) : null
    content.append(profileLine(panel), modeSwitch(panel), ...(prompt === null ? [] : [prompt]),
      mode === 'review' ? requestBar(panel) : polishArea(panel), cardList(panel),
      renderSelfAssessment(documentId, personal.assessments, notify, panel.cards.length > 0 ? 'after' : 'before'),
      sectionEditor(panel))
    container.replaceChildren(header, content)
    if (pane !== null) pane.scrollTop = scrollTop
  }

  await refresh()
}
