/**
 * 개요 화면 ([Q-36], 2026-09-17 개정 · 2026-09-27 덜어냄).
 *
 * 본문은 한글에서 본다 ([Q-45] — 앱은 전문을 보여 주지 않는다). 여기서는 **AI 가 쓴 한 문단 요약**으로
 * 어느 보고서인지만 알려 주고, 체크포인트와 삭제를 둔다.
 *
 * 지키는 것
 * - 요약은 **피드백이 아니다.** 고칠 점을 말하지 않는다 (프롬프트가 막고, 여기서는 그대로 보여 준다).
 * - **어느 모델이 썼는지 함께 적는다.** 사용자가 알아야 할 정보이고, 화면이 그 값으로 갈라지지 않는다.
 * - 요약이 없거나 오래되었어도 **막지 않는다.** 그 사실만 적는다.
 * - 삭제는 확인 창을 거친다. 창은 메인 프로세스가 띄운다 (`CLAUDE.md` §3).
 */
import { CHECKPOINT_LABEL_MAX_LENGTH, type DocumentWorkspace } from '../../../shared/ipc.js'
import { element } from './dom.js'

export interface DocumentWorkspaceOptions {
  container: HTMLElement
  workspace: DocumentWorkspace
  onReview: () => void
  onReconnect: () => void
  onCheckpoint: (label: string) => Promise<void>
  onRestore: (checkpointId: string) => Promise<void>
  /** 사용자가 남긴 체크포인트를 지운다. 최초본에는 버튼을 두지 않는다 */
  onDeleteCheckpoint?: (checkpointId: string) => Promise<void>
  /** 보고서를 이 앱에서 지운다 (기록 전부) */
  onDelete?: () => Promise<void>
}

function time(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function button(text: string, action: () => void, className?: string): HTMLButtonElement {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

/** 요약이 아직 없을 때 적는 말. 왜 없는지 짐작하지 않고 할 수 있는 일을 알려 준다. */
export const NO_SUMMARY_TEXT = '아직 요약이 없습니다. 한글에서 저장하면 만들어집니다 (AI 키 필요).'

export const STALE_SUMMARY_TEXT = '최근 저장 전의 요약입니다.'

export function renderDocumentWorkspace(options: DocumentWorkspaceOptions): void {
  const { container, workspace, onReview, onReconnect } = options
  const { document, versions } = workspace
  const latest = versions[0]
  const layout = element('div', 'document-layout')
  const center = element('section', 'document-center')

  const heading = element('header', 'page-heading')
  const title = element('div')
  title.append(element('h1', undefined, document.displayName.replace(/\.hwpx$/i, '')),
    element('p', undefined, [document.subject ?? '과목 없음',
      latest === undefined ? '저장 기록 없음' : `버전 ${latest.ordinal} · ${time(latest.detectedAt)}`].join(' · ')))
  const actions = element('div', 'heading-actions')
  actions.append(button('검토하기', onReview, 'primary-button'))
  if (options.onDelete !== undefined) {
    const remove = options.onDelete
    actions.append(button('보고서 삭제', () => { void remove() }))
  }
  heading.append(title, actions)
  center.append(heading)

  if (document.pathLost) {
    const alert = element('div', 'path-notice')
    alert.append(element('span', undefined, '원본 파일을 찾을 수 없습니다.'), button('새 위치 선택', onReconnect))
    center.append(alert)
  }

  const card = element('section', 'summary-card')
  card.setAttribute('aria-label', '보고서 요약')
  if (document.summary === null) {
    card.append(element('p', 'summary-empty', NO_SUMMARY_TEXT))
  } else {
    card.append(element('p', 'summary-text', document.summary.text))
    if (document.summary.stale) card.append(element('p', 'notice', STALE_SUMMARY_TEXT))
    // 어느 모델이 썼는지 감추지 않는다. 사용자가 판단할 근거다.
    card.append(element('p', 'summary-caveat', `AI 요약 · ${document.summary.modelId} · ${time(document.summary.createdAt)}`))
  }
  center.append(card)

  const checkpoints = element('aside', 'checkpoint-sidebar')
  checkpoints.setAttribute('aria-label', '체크포인트')
  checkpoints.append(element('strong', 'version-heading', '체크포인트'))
  const saved = element('ol', 'checkpoint-list')
  for (const checkpoint of document.checkpoints) {
    const entry = element('li', 'checkpoint-entry')
    entry.append(element('span', undefined, checkpoint.label), element('time', 'muted', time(checkpoint.createdAt)))
    const row = element('span', 'checkpoint-actions')
    row.append(button('되살리기', () => { void options.onRestore(checkpoint.checkpointId) }, 'text-button'))
    // 최초본은 복구용으로 늘 보관한다 (PRD 4.5). 지우는 버튼을 두지 않는다.
    if (checkpoint.kind === 'user' && options.onDeleteCheckpoint !== undefined) {
      const remove = options.onDeleteCheckpoint
      row.append(button('삭제', () => { void remove(checkpoint.checkpointId) }, 'text-button'))
    }
    entry.append(row)
    saved.append(entry)
  }

  const checkpointForm = element('form', 'checkpoint-form')
  const label = element('input')
  // 이름은 선택이다. 비우면 메인 프로세스가 버전 번호로 이름을 붙인다 ([Q-39]).
  label.placeholder = '이름 (선택)'
  label.setAttribute('aria-label', '체크포인트 이름 (선택)')
  label.maxLength = CHECKPOINT_LABEL_MAX_LENGTH
  const mark = element('button', undefined, '지금 저장')
  mark.type = 'submit'
  mark.disabled = document.pathLost || latest === undefined
  label.disabled = mark.disabled
  checkpointForm.append(label, mark)
  checkpointForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void options.onCheckpoint(label.value)
  })
  checkpoints.append(saved, checkpointForm)

  layout.append(center, checkpoints)
  container.replaceChildren(layout)
}
