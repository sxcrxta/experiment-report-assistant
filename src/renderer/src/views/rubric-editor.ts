/** Stitch 평가 지침 화면. 편집 중 내용과 확정한 버전을 분리한다. */
import { SUBJECT_MAX_LENGTH, type RubricEditorView, type RubricItemInput } from '../../../shared/ipc.js'
import {
  RUBRIC_IMPORTANCE_DEFAULT, RUBRIC_ITEM_TITLE_MAX_LENGTH, RUBRIC_MAX_ITEMS,
} from '../../../shared/rubric.js'
import { element } from './dom.js'

export interface RubricEditorOptions {
  container: HTMLElement
  documentId: string
  displayName: string
  subject?: string | null
  notify: (message: string) => void
  onSubjectChanged?: () => Promise<void>
  /** 확정한 뒤 부른다. 지침 모음 화면이 "따라가는지" 를 다시 읽는다 ([Q-40]) */
  onConfirmed?: () => Promise<void>
  /** 머리말 아래 안내. 모음 지침을 따라가는 보고서라면 여기서 고치면 따라가기가 멈춘다고 알린다 */
  note?: string
}

function button(text: string, action: () => void, className?: string): HTMLButtonElement {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

/** 지침 항목 편집 목록. 보고서 지침 편집기와 지침 모음 편집기가 함께 쓴다 ([Q-40]). */
export interface RubricItemList {
  list: HTMLOListElement
  add: HTMLButtonElement
  collect(): RubricItemInput[]
  append(item: RubricItemInput): void
}

export function createRubricItemList(initial: readonly RubricItemInput[], onChange: () => void): RubricItemList {
  const list = element('ol', 'rubric-list')
  list.setAttribute('aria-label', '반드시 충족할 조건')
  const add = button('＋ 조건 추가', () => {
    appendRow({ itemId: null, title: '', description: '', importance: RUBRIC_IMPORTANCE_DEFAULT })
    updateRows()
    onChange()
    list.lastElementChild?.querySelector<HTMLInputElement>('.rubric-title')?.focus()
  }, 'rubric-add')

  function updateRows(): void {
    add.disabled = list.children.length >= RUBRIC_MAX_ITEMS
    ;[...list.children].forEach((row, index) => {
      row.querySelector<HTMLElement>('.rubric-number')!.textContent = String(index + 1).padStart(2, '0')
      row.querySelector<HTMLButtonElement>('.move-up')!.disabled = index === 0
      row.querySelector<HTMLButtonElement>('.move-down')!.disabled = index === list.children.length - 1
      row.querySelector<HTMLInputElement>('.rubric-title')!.setAttribute('aria-label', `${index + 1}번 조건`)
    })
  }

  function appendRow(item: RubricItemInput): void {
    const row = element('li', 'rubric-item')
    row.dataset['itemId'] = item.itemId ?? ''
    // 중요도는 더 이상 쓰지 않는다 ([Q-49]). 저장소가 값을 요구하므로 보이지 않게 그대로 들고 간다.
    row.dataset['importance'] = String(item.importance)
    const order = element('div', 'rubric-order')
    const up = button('↑', () => {
      if (row.previousElementSibling !== null) list.insertBefore(row, row.previousElementSibling)
      updateRows(); onChange()
    }, 'move-up icon-button')
    up.setAttribute('aria-label', '지침 위로 이동')
    const down = button('↓', () => {
      if (row.nextElementSibling !== null) list.insertBefore(row.nextElementSibling, row)
      updateRows(); onChange()
    }, 'move-down icon-button')
    down.setAttribute('aria-label', '지침 아래로 이동')
    order.append(element('span', 'rubric-number'), up, down)
    const fields = element('div', 'rubric-fields')
    const title = element('input', 'rubric-title')
    // 조건은 한 줄이다 ([Q-50]). 예전의 "이름 + 설명" 두 칸은 한 줄로 합쳐 보여 주고, 저장하면 한 줄로 남는다.
    title.type = 'text'; title.value = oneLine(item); title.maxLength = RUBRIC_ITEM_TITLE_MAX_LENGTH
    title.placeholder = '예: 고찰 부분은 200자 이상이어야 한다.'
    fields.append(title)
    const remove = button('×', () => {
      if (title.value.trim() && !window.confirm('이 조건을 편집기에서 지울까요?')) return
      row.remove(); updateRows(); onChange()
    }, 'rubric-remove icon-button')
    remove.setAttribute('aria-label', '조건 지우기')
    row.append(order, fields, remove)
    list.append(row)
  }

  for (const item of initial.length > 0 ? initial : [
    { itemId: null, title: '', description: '', importance: RUBRIC_IMPORTANCE_DEFAULT },
  ]) appendRow(item)
  updateRows()
  list.addEventListener('input', onChange)
  return {
    list, add,
    collect: () => collect(list),
    append(item) { appendRow(item); updateRows() },
  }
}

/**
 * 예전 항목(이름 + 설명)을 조건 한 줄로 합친다. 설명이 없으면 이름 그대로.
 * 길이 제한을 넘으면 넘지 않게 자른다 — 사용자가 화면에서 보고 고친다.
 */
export function oneLine(item: Pick<RubricItemInput, 'title' | 'description'>): string {
  const title = item.title.trim()
  const description = item.description.replace(/\s+/g, ' ').trim()
  const merged = description === '' ? title : title === '' ? description : `${title} — ${description}`
  return merged.slice(0, RUBRIC_ITEM_TITLE_MAX_LENGTH)
}

function collect(list: HTMLOListElement): RubricItemInput[] {
  return [...list.querySelectorAll<HTMLLIElement>('.rubric-item')].map((row) => ({
    itemId: row.dataset['itemId'] || null,
    title: row.querySelector<HTMLInputElement>('.rubric-title')!.value,
    // 설명 칸은 없다. 합친 한 줄이 조건 전부다.
    description: '',
    importance: Number(row.dataset['importance'] ?? RUBRIC_IMPORTANCE_DEFAULT) || RUBRIC_IMPORTANCE_DEFAULT,
  }))
}

function render(options: RubricEditorOptions, view: RubricEditorView): void {
  const { container, documentId, notify } = options
  const header = element('header', 'page-heading rubric-heading')
  const titles = element('div')
  titles.append(element('h2', undefined, '이 보고서의 지침'),
    ...(options.note === undefined ? [] : [element('p', undefined, options.note)]))
  const subjectForm = element('form', 'subject-form')
  const subjectLabel = element('label', undefined, '과목')
  const subject = element('input')
  subject.value = options.subject ?? ''
  subject.placeholder = '과목 (선택)'
  subject.maxLength = SUBJECT_MAX_LENGTH
  subject.setAttribute('aria-label', '과목')
  subjectLabel.append(subject)
  const subjectSave = element('button', undefined, '과목 저장')
  subjectSave.type = 'submit'
  subjectForm.append(subjectLabel, subjectSave)
  /**
   * 문서 뼈대로 초안을 제안받는다 (PRD 4.1의 보조 기능).
   * 받은 항목은 **덧붙이기만** 한다. 이미 적어 둔 항목을 지우지 않는다.
   * 제안은 저장되지 않는다. 확인·수정하고 초안 저장이나 확정을 눌러야 남는다.
   */
  const suggestion = button('초안 제안받기', () => { void execute(async () => {
    const result = await window.agent.suggestRubricDraft(documentId)
    if (result.status === 'unavailable' || result.status === 'failed') { notify(result.message); return }
    for (const item of result.items) editor.append(item)
    showState(true)
    notify(`초안 ${result.items.length}개를 덧붙였습니다.`)
  }) })
  suggestion.title = '제목·표 설명·안내 문구만 보내 초안을 받습니다. 보고서 본문은 보내지 않습니다.'
  const headerActions = element('div', 'heading-actions')
  headerActions.append(subjectForm, suggestion)
  header.append(titles, headerActions)

  const content = element('div', 'rubric-content')
  const state = element('span', 'rubric-state')
  const explanation = element('span', 'muted')
  function showState(dirty: boolean): void {
    state.textContent = dirty ? '변경 내용 미확정' : view.draft !== null ? '저장된 초안' :
      view.current === null ? '확정 전' : `v${view.current.ordinal} 확정됨`
    explanation.textContent = view.current === null ? '확정해야 제출 점검에 쓰입니다.' : ''
  }
  showState(false)
  const editor = createRubricItemList(view.draft?.items ?? view.current?.items ?? [], () => showState(true))
  const { list, add } = editor
  content.append(list, add)
  if (view.history.length > 0) {
    const history = element('details', 'rubric-history')
    history.append(element('summary', undefined, `확정한 버전 ${view.history.length}개`))
    for (const version of view.history) {
      const entry = element('div', 'history-version')
      entry.append(element('h3', undefined, `v${version.ordinal} · ${new Date(version.confirmedAt).toLocaleString('ko-KR')}`))
      for (const item of version.items) entry.append(element('p', undefined,
        `${item.title}${item.description ? ` — ${item.description}` : ''}`))
      history.append(entry)
    }
    content.append(history)
  }

  let busy = false
  async function execute(action: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true
    const controls = [...container.querySelectorAll<HTMLInputElement>('input, textarea, button')]
      .map((control) => ({ control, disabled: control.disabled }))
    controls.forEach(({ control }) => { control.disabled = true })
    try { await action() } catch (cause) {
      console.error('평가 지침 저장 실패', cause)
      notify('평가 지침을 저장하지 못했습니다. 입력 내용은 그대로 있으니 다시 시도해 주세요.')
    } finally {
      busy = false
      controls.forEach(({ control, disabled }) => { control.disabled = disabled })
    }
  }
  subjectForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void execute(async () => {
      const result = await window.agent.setSubject(documentId, subject.value)
      if (result.status === 'failed') { notify(result.message); return }
      options.subject = result.document.subject
      subject.value = result.document.subject ?? ''
      notify('과목을 저장했습니다.')
      await options.onSubjectChanged?.()
    })
  })
  const save = button('초안 저장', () => { void execute(async () => {
    const result = await window.agent.saveRubricDraft(documentId, collect(list))
    if (result.status === 'failed') { notify(result.message); return }
    notify('초안을 저장했습니다.')
    render(options, result.editor)
  }) })
  const confirm = button('확정하기', () => { void execute(async () => {
    const result = await window.agent.confirmRubric(documentId, collect(list))
    if (result.status === 'failed') { notify(result.message); return }
    notify(`평가 지침 v${result.ordinal} 적용을 확정했습니다.`)
    render(options, result.editor)
    await options.onConfirmed?.()
  }) }, 'primary-button')
  const footer = element('footer', 'rubric-footer')
  const status = element('div', 'rubric-footer-status')
  status.append(state, explanation)
  const actions = element('div', 'rubric-footer-actions')
  if (view.draft !== null) actions.append(button('초안 버리기', () => { void execute(async () => {
    const result = await window.agent.discardRubricDraft(documentId)
    if (result.status === 'canceled') return
    if (result.status === 'failed') { notify(result.message); return }
    notify('초안을 버렸습니다.')
    render(options, result.editor)
  }) }))
  actions.append(save, confirm)
  footer.append(status, actions)
  container.replaceChildren(header, content, footer)
}

export async function openRubricEditor(options: RubricEditorOptions): Promise<void> {
  const { container, notify } = options
  container.replaceChildren(element('div', 'empty-inline', '평가 지침을 불러오는 중입니다…'))
  try {
    const result = await window.agent.getRubric(options.documentId)
    if (result.status === 'failed') throw new Error(result.message)
    render(options, result.editor)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '평가 지침을 열지 못했습니다.'
    notify(message)
    const retry = button('다시 열기', () => { void openRubricEditor(options) })
    const error = element('div', 'empty-state')
    error.append(element('h2', undefined, '평가 지침을 불러오지 못했습니다'), element('p', undefined, message), retry)
    container.replaceChildren(error)
  }
}
