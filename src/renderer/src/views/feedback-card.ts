/**
 * 피드백 카드 — 접힌 요약 한 줄과 펼친 상세 (PRD 4.2, docs/UI-개편.md "피드백 카드").
 *
 * 펼치면 보이는 것: 단계 표시기 · 적용된 지침 · 근거 · 전체 피드백 · 수정 전후 · 사용자 반응 · 자기평가 메모.
 *
 * 화면 규칙 (docs/UI-개편.md "구현 스펙")
 * - 색은 `styles.css` 의 토큰(var(--…))만 쓴다. 이 파일에 색 값을 적지 않는다.
 * - 아이콘은 내려받지 않고 인라인 SVG 로 그린다. 외부 글꼴·CDN 을 부르지 않는다.
 * - **반응 버튼 4개는 같은 크기·색·테두리다.** 같은 클래스(`reaction-button`) 하나만 쓴다.
 *   '반박' 을 경고색으로 칠하지 않는다. 반박은 권장되는 행동이다.
 * - **'짧은 수정 예시' 단계는 더 흐리게** 하고 "직접 요청해야 열립니다" 를 붙인다.
 *   예시는 이 카드의 예시 요청 버튼을 눌렀을 때만 열린다. 다른 버튼은 예시를 요청하지 않는다.
 *
 * 파일·네트워크에 직접 닿지 않는다. window.agent (preload 브리지)만 쓴다.
 */
import type { AnchorDecision, FeedbackCard } from '../../../shared/feedback.js'
import {
  REVIEW_PERSPECTIVE_LABELS,
  REVIEW_STAGE_LABELS,
  REVIEW_STAGES,
  type ReviewStage,
} from '../../../shared/review.js'

import { element, option } from './dom.js'
import { renderReaction } from './reaction.js'
import type { UserReaction } from '../../../shared/personalization.js'

/** 사용자 반응 네 가지 (PRD 4.4). 네 개가 대등한 무게를 갖는다. */
export const REACTION_CHOICES = ['동의', '부분 동의', '반박', '이해되지 않음'] as const

export const EXAMPLE_LOCK_NOTICE = '직접 요청해야 열립니다'

export interface FeedbackCardOptions {
  documentId: string
  reaction: UserReaction | undefined
  notify: (message:string)=>void
  card: FeedbackCard
  /** 다음 단계를 요청한다. 예시는 `exampleRequested` 가 true 일 때만 */
  onAdvance: (card: FeedbackCard, stage: ReviewStage, exampleRequested: boolean) => void
  /** 찾지 못한 문장에 대한 사용자 확인 */
  onDecideAnchor: (anchorId: string, decision: AnchorDecision) => void
  /** 이 피드백을 지운다. 확인 창은 메인 프로세스가 띄운다 */
  onDelete?: (card: FeedbackCard) => void
}

/** 펼침 표시 화살표. 외부 아이콘 글꼴을 받지 않고 직접 그린다. */
function chevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M4 6l4 4 4-4')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}

/** 단계 표시기. 연 단계만 채워지고 나머지는 잠긴 모습이다. */
function stageTrack(card: FeedbackCard): HTMLElement {
  const track = element('div', 'stage-track')
  track.setAttribute('aria-label', '피드백 단계')

  REVIEW_STAGES.forEach((stage, i) => {
    if (i > 0) track.append(element('span', 'stage-arrow', '›'))

    const done = card.grantedStages.includes(stage)
    const classes = ['stage-step']
    if (done) classes.push('stage-step--done')
    else classes.push('stage-step--locked')
    // 예시는 다른 잠긴 단계보다 더 흐리게 둔다 (docs/UI-개편.md).
    if (stage === 'example' && !done) classes.push('stage-step--example')

    // 잠긴 단계는 흐린 모양으로만 보인다. 예시에만 "직접 요청해야 열립니다" 를 붙인다.
    const step = element('span', classes.join(' '),
      stage === 'example' && !done ? `${REVIEW_STAGE_LABELS[stage]} · ${EXAMPLE_LOCK_NOTICE}` : REVIEW_STAGE_LABELS[stage])
    if (!done) step.title = '아직 열지 않은 단계'
    track.append(step)
  })

  return track
}

function block(title: string, body: string): HTMLElement {
  const box = element('div', 'card-block')
  box.append(element('div', 'card-block-title', title), element('div', undefined, body))
  return box
}

/** 적용된 지침. 회색 배지로 제목만 보여 준다. 연결된 항목이 없으면 칸을 두지 않는다. */
function appliedRubric(card: FeedbackCard): HTMLElement | null {
  if (card.appliedRubric.length === 0) return null
  const box = element('div', 'card-block')
  box.append(element('div', 'card-block-title', '평가 지침'))
  for (const item of card.appliedRubric) {
    box.append(element('span', 'badge', item.title), document.createTextNode(' '))
  }
  return box
}

export const REPEATED_NONE_TEXT = '다른 버전에서 관찰된 적 없음'

/**
 * 반복 관찰 근거 (`CLAUDE.md` §1, T-8). **모든 카드에 항상 붙는다.**
 *
 * 능력을 단정하지 않는다. 관찰된 문서 버전을 그대로 적고, 2개 이상일 때만 '후보'라고 부른다.
 * 근거가 없으면 없다고 적는다. 근거 없는 취약점 표현을 만들지 않는다.
 */
function repeatedObservation(card: FeedbackCard): HTMLElement {
  const box = element('div', 'card-block repeated-observation')
  box.append(element('div', 'card-block-title', '반복 관찰 근거'))

  const { count, versions } = card.repeatedObservation
  if (count === 0) {
    box.append(element('div', 'muted', REPEATED_NONE_TEXT))
    return box
  }
  box.append(element('div', undefined, count >= 2
    ? `문서 버전 ${count}개에서 관찰 · 반복 취약점 후보 (단정 아님)`
    : '문서 버전 1개에서 관찰'))
  for (const version of versions) {
    box.append(
      element('span', 'badge', `${version.documentName} · 버전 ${version.versionOrdinal}`),
      document.createTextNode(' '),
    )
  }
  return box
}

/** 수정 전후. 접힌 행으로 두고 사용자가 펼칠 때만 보여 준다. */
function revision(card: FeedbackCard): HTMLElement | null {
  if (card.revision === null) return null

  const details = element('details', 'card-block')
  const summary = element('summary', undefined, '수정 전후')
  const rows = element('div', 'revision')
  rows.append(
    element('span', 'muted', '수정 전'),
    element('span', undefined, card.revision.before),
    element('span', 'muted', '수정 후'),
    element('span', undefined, card.revision.after),
  )
  details.append(summary, rows)
  return details
}

/**
 * 문장 앵커 상태.
 * 다시 찾지 못했으면 임의로 다른 문장에 붙이지 않고, 사용자가 고르거나 그대로 두겠다고 확인한다.
 */
function anchorBlock(card: FeedbackCard, options: FeedbackCardOptions): HTMLElement | null {
  const anchor = card.anchor
  if (anchor === null) return null

  if (!anchor.needsConfirmation) {
    const linked = element('div', 'card-block')
    linked.append(
      element('div', 'card-block-title', '가리키는 문장'),
      element('div', undefined, anchor.text),
    )
    if (anchor.message !== '') linked.append(element('div', 'muted', anchor.message))
    return linked
  }

  const box = element('div', 'anchor-alert')
  box.append(
    element('div', undefined, anchor.message),
    element('div', 'muted', `찾던 문장: ${anchor.text}`),
  )

  const actions = element('div', 'anchor-actions')
  const select = element('select')
  select.setAttribute('aria-label', '이 피드백이 가리키는 문장')
  select.append(option('', '문장을 고르세요'))
  for (const sentence of anchor.candidates) {
    select.append(option(String(sentence.index), sentence.text))
  }

  const relink = element('button', undefined, '이 문장에 연결')
  relink.type = 'button'
  relink.addEventListener('click', () => {
    if (select.value === '') return
    options.onDecideAnchor(anchor.anchorId, { choice: 'relink', sentenceIndex: Number(select.value) })
  })

  const keep = element('button', undefined, '찾지 못한 채로 두기')
  keep.type = 'button'
  keep.addEventListener('click', () => {
    options.onDecideAnchor(anchor.anchorId, { choice: 'keep-lost' })
  })

  actions.append(select, relink, keep)
  box.append(actions)
  if (anchor.candidates.length === 0) {
    box.append(element('div', 'muted', '이 문단이 지금 문서에 없어 고를 문장이 없습니다.'))
  }
  return box
}

/** 다음 단계 버튼. 예시는 이 버튼을 눌렀을 때만 요청된다. */
function advance(card: FeedbackCard, options: FeedbackCardOptions): HTMLElement {
  const row = element('div', 'anchor-actions')
  const next = card.nextStage

  if (next === null) return row

  const blockedByAnchor = card.anchor !== null && card.anchor.needsConfirmation
  const button = element('button', undefined, `${REVIEW_STAGE_LABELS[next]} 요청`)
  button.type = 'button'
  button.disabled = blockedByAnchor
  button.addEventListener('click', () => {
    // 예시 단계는 이 버튼(사용자의 직접 요청)에서만 true 가 된다.
    options.onAdvance(card, next, next === 'example')
  })
  row.append(button)

  if (card.nextStageNeedsRequest) button.title = `짧은 수정 예시는 ${EXAMPLE_LOCK_NOTICE}.`
  if (blockedByAnchor) row.append(element('span', 'muted', '가리키는 문장을 먼저 확인해 주세요.'))
  return row
}

/** 카드 하나를 그린다. 펼침 상태는 <details> 가 들고 있다. */
export function renderFeedbackCard(options: FeedbackCardOptions): HTMLElement {
  const { card } = options

  const root = element('details', 'card')
  const head = element('summary', 'card-head')
  head.append(
    element('span', 'badge', card.paragraphNumber === null ? '문단 없음' : `문단 ${card.paragraphNumber}`),
    element('span', 'card-perspective', REVIEW_PERSPECTIVE_LABELS[card.perspective]),
    element('span', 'card-summary', card.summary),
    element('span', 'muted', REVIEW_STAGE_LABELS[card.stage]),
    chevron(),
  )

  const body = element('div', 'card-body')
  body.append(stageTrack(card))

  const anchor = anchorBlock(card, options)
  if (anchor !== null) body.append(anchor)

  const rubric = appliedRubric(card)
  body.append(block('피드백', card.body), block('근거', card.rationale))
  if (rubric !== null) body.append(rubric)
  body.append(repeatedObservation(card))

  // 예시는 예시 단계의 카드에만 존재한다. 다른 카드에서는 이 값이 언제나 null 이다.
  if (card.example !== null) body.append(block('짧은 수정 예시', card.example))

  const changed = revision(card)
  if (changed !== null) body.append(changed)

  const actions = advance(card, options)
  if (options.onDelete !== undefined) {
    const onDelete = options.onDelete
    const remove = element('button', 'text-button card-delete', '삭제')
    remove.type = 'button'
    remove.setAttribute('aria-label', '이 피드백 삭제')
    remove.addEventListener('click', () => { onDelete(card) })
    actions.append(remove)
  }
  body.append(renderReaction(options.documentId,card.itemId,options.reaction,options.notify), actions)
  root.append(head, body)
  return root
}
