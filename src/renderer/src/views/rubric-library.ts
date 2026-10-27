/**
 * 평가 지침 탭 — 지침 모음과 적용 ([Q-40], PRD 3절 2번·4.1).
 *
 * 화면에서 하는 일
 * - **지침 모음**: 지침을 보고서와 따로 만들고 고치고 지운다.
 * - **적용**: 고른 보고서에 모음 지침을 적용한다 (= 그 내용으로 확정하고 따라가기).
 * - **이 보고서에서만 고치기**: 보고서 지침 편집기를 접어 둔다. 고쳐 확정하면 따라가기가 멈춘다.
 *
 * 지키는 것
 * - 모음 지침을 고치면 따라가는 보고서에 **함께 확정**된다 (사용자 결정). 그래서 저장 버튼에
 *   따라가는 보고서 수를 적어, 저장이 어디에 적용되는지 알고 누르게 한다.
 * - 판단(적용·따라가기·확정)은 메인 프로세스가 한다. 여기서는 그리고 요청만 보낸다.
 *
 * 색은 `styles.css` 의 토큰만 쓴다. 파일·네트워크에 직접 닿지 않는다 (window.agent 만 쓴다).
 */
import {
  RUBRIC_TEMPLATE_NAME_MAX_LENGTH,
  type DocumentRubricLinkView,
  type DocumentSummary,
  type RubricItemInput,
  type RubricTemplateView,
  type CheckItemView,
  type DocumentCheckView,
} from '../../../shared/ipc.js'
import { element, option } from './dom.js'
import { createRubricItemList, oneLine, openRubricEditor } from './rubric-editor.js'

export interface RubricTabOptions {
  container: HTMLElement
  /** 지금 고른 보고서. 없으면 지침 모음만 보인다 */
  document: DocumentSummary | undefined
  /** 따라가는 보고서 이름을 적는 데 쓴다 */
  documents: readonly DocumentSummary[]
  notify: (message: string) => void
  /** 보고서의 확정 지침이 바뀌었다. 검토 화면이 낡은 상태를 들고 있지 않게 알린다 */
  onRubricChanged: (documentIds: readonly string[]) => void
  onSubjectChanged: () => Promise<void>
}

/** 모음 편집기에서 쓰던 내용. 탭을 옮겨도 사라지지 않게 둔다 */
let editing: { templateId: string | null; name: HTMLInputElement; list: ReturnType<typeof createRubricItemList> } | null = null
/** 보고서 지침 편집기. 쓰던 내용을 잃지 않게 보고서마다 하나씩 둔다 */
const documentEditors = new Map<string, HTMLElement>()

/** 다른 화면에서 이 보고서의 지침을 확정했다. 다음에 열 때 새로 읽는다 */
export function forgetDocumentEditor(documentId: string): void {
  documentEditors.delete(documentId)
}

function button(text: string, action: () => void, className?: string): HTMLButtonElement {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

function names(ids: readonly string[], documents: readonly DocumentSummary[]): string {
  return ids.map((id) => documents.find((d) => d.documentId === id)?.displayName.replace(/\.hwpx$/i, '') ?? '보고서')
    .join(', ')
}

function linkLine(link: DocumentRubricLinkView | null, confirmedOrdinal: number | null): string {
  if (link !== null && link.following) return `'${link.templateName}' 적용 중`
  if (link !== null) return `'${link.templateName}' 을 이 보고서에서 고쳤습니다 (모음과 따로 감)`
  if (confirmedOrdinal !== null) return `이 보고서만의 지침 v${confirmedOrdinal}`
  return '아직 적용한 지침이 없습니다'
}

export async function openRubricTab(options: RubricTabOptions): Promise<void> {
  const { container, document: selected, notify } = options
  container.replaceChildren(element('div', 'empty-inline', '불러오는 중…'))
  const [library, editor] = await Promise.all([
    window.agent.listRubricTemplates(selected === undefined ? {} : { documentId: selected.documentId }),
    selected === undefined ? Promise.resolve(null) : window.agent.getRubric(selected.documentId),
  ])
  if (library.status === 'failed') { showError(library.message); return }
  if (editor !== null && editor.status === 'failed') { showError(editor.message); return }
  const { templates, link, suggestedId } = library
  const confirmedOrdinal = editor?.status === 'ok' ? editor.editor.current?.ordinal ?? null : null

  let busy = false
  async function execute(action: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true
    try { await action() } catch (cause) {
      console.error('평가 지침 작업 실패', cause)
      notify('평가 지침 작업을 마치지 못했습니다. 입력은 그대로 있으니 다시 시도해 주세요.')
    } finally { busy = false }
  }
  const reopen = (): Promise<void> => openRubricTab(options)

  function showError(message: string): void {
    notify(message)
    const box = element('div', 'empty-state')
    box.append(element('h2', undefined, '평가 지침을 불러오지 못했습니다'), element('p', undefined, message),
      button('다시 열기', () => { void reopen() }))
    container.replaceChildren(box)
  }

  const header = element('header', 'page-heading')
  const titles = element('div')
  titles.append(element('h1', undefined, '평가 지침'),
    element('p', undefined, '제출할 때 반드시 충족해야 하는 조건을 적어 두고, 보고서가 얼마나 충족하는지 점검합니다. 검토·다듬기와는 따로 씁니다.'))
  header.append(titles)
  const content = element('div', 'rubric-tab')

  // --- 고른 보고서에 적용된 지침 ---------------------------------------------------------
  if (selected !== undefined) {
    const applied = element('section', 'applied-rubric')
    const docName = selected.displayName.replace(/\.hwpx$/i, '')
    applied.append(element('h2', undefined, docName),
      element('p', 'muted', linkLine(link, confirmedOrdinal)),
      checkSection(selected.documentId, confirmedOrdinal !== null, notify))

    const row = element('div', 'applied-actions')
    if (templates.length > 0) {
      const pick = element('select')
      pick.setAttribute('aria-label', '적용할 지침')
      for (const template of templates) pick.append(option(template.id, template.name))
      pick.value = link?.templateId ?? suggestedId ?? templates[0]!.id
      const apply = button('적용', () => { void execute(async () => {
        const result = await window.agent.applyRubricTemplate(selected.documentId, pick.value)
        if (result.status === 'failed') { notify(result.message); return }
        const name = templates.find((t) => t.id === pick.value)?.name ?? '지침'
        notify(`'${name}' 적용됨`)
        forgetDocumentEditor(selected.documentId)
        options.onRubricChanged([selected.documentId])
        await reopen()
      }) }, 'primary-button')
      row.append(pick, apply)
    }
    if (link !== null && !link.following) {
      const templateId = link.templateId
      row.append(button('모음 지침 다시 따르기', () => { void execute(async () => {
        const result = await window.agent.applyRubricTemplate(selected.documentId, templateId)
        if (result.status === 'failed') { notify(result.message); return }
        notify('모음 지침을 다시 따릅니다.')
        forgetDocumentEditor(selected.documentId)
        options.onRubricChanged([selected.documentId])
        await reopen()
      }) }))
    }
    // 모음과 이어지지 않았거나 보고서에서 고친 지침은 모음에 새 지침으로 옮겨 담을 수 있다.
    if (confirmedOrdinal !== null && (link === null || !link.following)) {
      const saveForm = element('form', 'inline-form')
      const name = element('input')
      name.maxLength = RUBRIC_TEMPLATE_NAME_MAX_LENGTH
      name.placeholder = '새 지침 이름'
      name.setAttribute('aria-label', '모음에 저장할 지침 이름')
      name.value = selected.subject === null ? '' : `${selected.subject} 지침`
      const save = element('button', undefined, '이 지침을 모음에 저장')
      save.type = 'submit'
      saveForm.append(name, save)
      saveForm.addEventListener('submit', (event) => {
        event.preventDefault()
        void execute(async () => {
          const result = await window.agent.saveDocumentRubricToLibrary(selected.documentId, name.value)
          if (result.status === 'failed') { notify(result.message); return }
          notify(`'${result.template.name}' 을 모음에 저장했습니다.`)
          await reopen()
        })
      })
      row.append(saveForm)
    }
    applied.append(row)

    // 보고서에서만 고치기. 접어 두고, 펼칠 때 편집기를 연다.
    const local = element('details', 'local-rubric')
    local.append(element('summary', undefined, '이 보고서에서만 고치기'))
    const body = documentEditors.get(selected.documentId) ?? element('div', 'rubric-view')
    documentEditors.set(selected.documentId, body)
    local.append(body)
    const note = link?.following === true
      ? `여기서 고쳐 확정하면 이 보고서는 '${link.templateName}' 을 더 이상 따라가지 않습니다.`
      : undefined
    const openEditor = (): Promise<void> => openRubricEditor({
      container: body, documentId: selected.documentId, displayName: selected.displayName,
      subject: selected.subject, notify, onSubjectChanged: options.onSubjectChanged,
      ...(note === undefined ? {} : { note }),
      onConfirmed: async () => {
        options.onRubricChanged([selected.documentId])
        documentEditors.delete(selected.documentId)
        await reopen()
      },
    })
    // 쓰던 편집기가 있으면 펼친 채로 되돌려 놓는다. 없으면 펼칠 때 연다.
    if (body.childElementCount > 0) local.open = true
    local.addEventListener('toggle', () => { if (local.open && body.childElementCount === 0) void openEditor() })
    applied.append(local)
    content.append(applied)
  }

  // --- 지침 모음 --------------------------------------------------------------------------
  const shelf = element('section', 'rubric-shelf')
  const shelfHead = element('div', 'shelf-heading')
  shelfHead.append(element('h2', undefined, `지침 모음 (${templates.length})`),
    button('＋ 새 지침', () => { startEditing(null) }))
  shelf.append(shelfHead)

  const editorSlot = element('div')
  shelf.append(editorSlot)

  function startEditing(template: RubricTemplateView | null, items?: readonly RubricItemInput[]): void {
    const name = element('input', 'template-name')
    name.maxLength = RUBRIC_TEMPLATE_NAME_MAX_LENGTH
    name.placeholder = '지침 이름 (예: 일반화학실험 기본)'
    name.setAttribute('aria-label', '지침 이름')
    name.value = template?.name ?? (selected?.subject == null ? '' : `${selected.subject} 기본`)
    editing = { templateId: template?.id ?? null, name,
      list: createRubricItemList(items ?? template?.items ?? [], () => undefined) }
    drawEditor()
    name.focus()
  }

  function drawEditor(): void {
    if (editing === null) { editorSlot.replaceChildren(); return }
    const current = editing
    const template = templates.find((t) => t.id === current.templateId) ?? null
    if (current.templateId !== null && template === null) { editing = null; editorSlot.replaceChildren(); return }
    const box = element('section', 'template-editor')
    box.append(element('h3', undefined, template === null ? '새 지침' : `'${template.name}' 고치기`), current.name,
      current.list.list, current.list.add)

    const actions = element('div', 'rubric-footer-actions')
    if (selected !== undefined) {
      // 보고서 구조로 항목을 채운다 ([Q-37] 의 초안을 새 지침의 출발점으로 쓴다).
      actions.append(button('보고서 구조로 채우기', () => {
        void execute(async () => {
          const suggested = await window.agent.suggestRubricDraft(selected.documentId)
          let items: RubricItemInput[] = suggested.status === 'suggested' ? suggested.items : []
          if (items.length === 0) {
            // 연결이 없으면 등록할 때 만들어 둔 뼈대 초안을 쓴다.
            const saved = await window.agent.getRubric(selected.documentId)
            items = saved.status === 'ok' ? (saved.editor.draft?.items ?? []).map((i) => ({ ...i, itemId: null })) : []
          }
          if (items.length === 0) { notify('채울 항목을 찾지 못했습니다. 직접 적어 주세요.'); return }
          for (const item of items) current.list.append(item)
          notify(`항목 ${items.length}개를 채웠습니다.`)
        })
      }))
    }
    const applyAfter = selected !== undefined && template === null && link === null && confirmedOrdinal === null
    const following = template?.followingDocumentIds ?? []
    const saveLabel = template === null
      ? applyAfter ? '모음에 저장하고 이 보고서에 적용' : '모음에 저장'
      : following.length > 0 ? `저장 · 따라가는 보고서 ${following.length}개에도 적용` : '저장'
    actions.append(button('취소', () => { editing = null; drawEditor() }), button(saveLabel, () => {
      void execute(async () => {
        const items = current.list.collect()
        const result = template === null
          ? await window.agent.createRubricTemplate(current.name.value, items)
          : await window.agent.updateRubricTemplate(template.id, current.name.value, items)
        if (result.status === 'failed') { notify(result.message); return }
        editing = null
        let message = `'${result.template.name}' 저장됨`
        if (result.updatedDocuments > 0) message += ` · 보고서 ${result.updatedDocuments}개에 적용`
        if (applyAfter) {
          const applied = await window.agent.applyRubricTemplate(selected.documentId, result.template.id)
          if (applied.status === 'failed') message += ` · 적용하지 못했습니다: ${applied.message}`
          else message += ' · 이 보고서에 적용'
        }
        notify(message)
        const changed = [...result.template.followingDocumentIds, ...(applyAfter ? [selected.documentId] : [])]
        changed.forEach(forgetDocumentEditor)
        if (changed.length > 0) options.onRubricChanged(changed)
        await reopen()
      })
    }, 'primary-button'))
    if (following.length > 0) {
      box.append(element('p', 'muted', `저장하면 따라가는 보고서(${names(following, options.documents)})의 지침도 함께 확정됩니다.`))
    }
    box.append(actions)
    editorSlot.replaceChildren(box)
  }

  const list = element('div', 'template-list')
  for (const template of templates) {
    const card = element('article', 'template-card')
    const head = element('div', 'template-card-head')
    head.append(element('strong', undefined, template.name),
      element('span', 'muted', `조건 ${template.items.length}개`))
    // 조건은 한 줄짜리 문장이다 ([Q-50]). 한 줄에 하나씩 보여 준다.
    const conditions = element('ul', 'template-items')
    for (const item of template.items) conditions.append(element('li', undefined, oneLine(item)))
    card.append(head, conditions)
    if (template.followingDocumentIds.length > 0) {
      card.append(element('p', 'muted', `적용: ${names(template.followingDocumentIds, options.documents)}`))
    }
    const actions = element('div', 'template-card-actions')
    actions.append(button('고치기', () => { startEditing(template) }), button('삭제', () => { void execute(async () => {
      const result = await window.agent.deleteRubricTemplate(template.id)
      if (result.status === 'canceled') return
      if (result.status === 'failed') { notify(result.message); return }
      if (editing?.templateId === template.id) editing = null
      notify(result.unlinkedDocuments > 0
        ? `'${template.name}' 을 삭제했습니다. 적용했던 보고서의 지침은 그대로입니다.`
        : `'${template.name}' 을 삭제했습니다.`)
      await reopen()
    }) }, 'text-button'))
    card.append(actions)
    list.append(card)
  }
  if (templates.length === 0) {
    list.append(element('p', 'muted', '아직 지침이 없습니다. ＋ 새 지침으로 만드세요.'))
  }
  shelf.append(list)
  content.append(shelf)
  container.replaceChildren(header, content)
  drawEditor()
}

const STATUS_LABEL: Readonly<Record<CheckItemView['status'], string>> = { met: '충족', partial: '일부 충족', missing: '미충족' }

/** 점검할 때 밖으로 나가는 것 (`CLAUDE.md` §4) */
export const CHECK_OUTBOUND_NOTE = '조건 목록과 보고서의 글 전체(문단 번호와 함께)를 AI 로 보냅니다.'

/** 충족도 막대. 너비는 퍼센트, 색은 토큰만 쓴다 */
function meter(score: number): HTMLElement {
  const bar = element('div', 'check-meter')
  bar.setAttribute('role', 'meter')
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', '100')
  bar.setAttribute('aria-valuenow', String(score))
  const fill = element('div', 'check-meter-fill')
  fill.setAttribute('style', `width:${Math.max(0, Math.min(100, score))}%`)
  bar.append(fill)
  return bar
}

/**
 * 양식 점검 ([Q-48], [Q-49]). 사용자가 적은 **반드시 충족해야 하는 조건**마다 AI 가 충족도(%)와 근거를 준다.
 * 전체 충족도는 조건별 퍼센트의 평균으로 **프로그램이** 계산한다. 누를 때만 점검한다.
 * 지난 결과는 남겨 두고, 문서·조건이 바뀌었으면 낡았다고 적는다.
 */
function checkSection(documentId: string, confirmed: boolean, notify: (message: string) => void): HTMLElement {
  const box = element('section', 'check-box')
  const head = element('div', 'shelf-heading')
  const results = element('div', 'check-results')
  let running = false
  const run = button('양식 점검', () => { void go() }, 'primary-button')
  run.disabled = !confirmed
  run.title = confirmed ? CHECK_OUTBOUND_NOTE : '조건을 먼저 확정해 주세요.'
  head.append(element('h3', undefined, '양식 충족도'), run)
  box.append(head, results)
  const notConfirmed = '아래 모음에서 조건 목록을 골라 적용하면 점검할 수 있습니다.'
  if (!confirmed) results.append(element('p', 'muted', notConfirmed))

  function draw(check: DocumentCheckView | null): void {
    if (check === null) {
      results.replaceChildren(element('p', 'muted', confirmed ? '아직 점검하지 않았습니다. `양식 점검` 을 눌러 주세요.' : notConfirmed))
      return
    }
    const parts: HTMLElement[] = []
    if (check.overall !== null) {
      const total = element('div', 'check-overall')
      total.append(element('strong', 'check-overall-score', `${check.overall}%`),
        element('span', 'muted', `조건 ${check.results.length}개 평균`))
      parts.push(total, meter(check.overall))
    }
    const met = check.results.filter((item) => item.status === 'met').length
    parts.push(element('p', 'muted', `충족 ${met} / ${check.results.length} — `
      + `${new Date(check.createdAt).toLocaleString('ko-KR')} · ${check.modelId}`))
    if (check.documentChanged || check.checklistChanged) {
      parts.push(element('p', 'notice', `${check.documentChanged ? '점검한 뒤 보고서를 다시 저장했습니다. ' : ''}`
        + `${check.checklistChanged ? '점검한 뒤 조건이 바뀌었습니다. ' : ''}다시 점검하면 새로 봅니다.`))
    }
    const list = element('ul', 'check-list')
    for (const item of check.results) {
      const row = element('li', `check-item check-item--${item.status}`)
      const title = element('div', 'check-item-head')
      title.append(element('strong', undefined, item.title), element('span', 'check-score', `${item.score}%`),
        element('span', 'muted', STATUS_LABEL[item.status]))
      row.append(title, meter(item.score), element('p', undefined, item.evidence))
      if (item.paragraphNumbers.length > 0) {
        row.append(element('p', 'muted', `문단 ${item.paragraphNumbers.join(', ')}`))
      }
      list.append(row)
    }
    parts.push(list)
    results.replaceChildren(...parts)
  }

  async function go(): Promise<void> {
    if (running) return
    running = true
    run.disabled = true
    run.textContent = '점검하는 중…'
    notify('양식 점검 중… (AI 가 보고서 전체를 읽습니다)')
    try {
      const result = await window.agent.runCheck(documentId)
      if (result.status === 'failed') { notify(result.message); return }
      draw(result.check)
      notify(result.check.overall === null ? '점검했습니다.' : `양식 충족도 ${result.check.overall}%`)
    } catch (cause) {
      console.error('양식 점검 실패', cause)
      notify('점검하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      running = false
      run.disabled = !confirmed
      run.textContent = '양식 점검'
    }
  }

  if (confirmed) {
    void window.agent.getCheck(documentId).then((result) => {
      if (result.status === 'failed') { notify(result.message); return }
      if (!running) draw(result.check)
    }).catch((cause: unknown) => { console.error('점검 결과 읽기 실패', cause) })
  }
  return box
}
