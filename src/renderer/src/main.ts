/** 앱 화면 전환과 로컬 데이터 표시. 파일·네트워크 접근은 preload를 거친다. */
import { SUBJECT_MAX_LENGTH, type AiSettingsView, type DocumentEvent, type DocumentSummary } from '../../shared/ipc.js'
import { element, option } from './views/dom.js'
import { renderDocumentWorkspace } from './views/document-workspace.js'
import { noteSaved, openReviewPanel, refreshReviewPanel } from './views/review-panel.js'
import { forgetDocumentEditor, openRubricTab } from './views/rubric-library.js'
import { openSettings } from './views/settings.js'
import { openGrowth } from './views/growth.js'
import { openPolish } from './views/polish.js'
import { renderFirstRun } from './views/first-run.js'

type Tab = 'document' | 'review' | 'rubric' | 'growth'
const tabs: Tab[] = ['document', 'review', 'rubric', 'growth']
let activeTab: Tab = 'document'
let settingsOpen = false
/** 보조 창 모드 ([Q-44]). 켜면 검토 화면만 좁게 보인다 */
let compact = false
let documents: DocumentSummary[] = []
let selectedId: string | null = null
let workspaceSequence = 0
let listSequence = 0
/** 마지막으로 등록할 때 쓴 과목. 다음 불러오기 칸을 채워 둔다 ([Q-39]) */
let lastSubject: string | null = null
/** 최근 읽기에 실패한 문서. 이 문서에서만 다시 읽기 버튼을 보인다 ([Q-39]) */
const readFailures = new Set<string>()
const reviewPanels = new Map<string, HTMLElement>()

function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`화면 구성 요소를 찾지 못했습니다: ${id}`)
  return found as T
}
function notify(message: string): void { node('notice').textContent = message }
async function run(action: () => Promise<void>): Promise<void> {
  try { await action() } catch (cause) {
    console.error('화면 작업 실패', cause)
    notify('작업을 마치지 못했습니다. 다시 시도해 주세요.')
  }
}
function selected(): DocumentSummary | undefined { return documents.find((d) => d.documentId === selectedId) }
/**
 * 불러오기 창. 과목은 등록할 때 묻되 비워도 된다 ([Q-52]). 마지막에 쓴 과목을 채워 두어
 * 대개는 확인만 하고 넘어가게 한다 ([Q-39]).
 */
function showImport(): void {
  const subject = node<HTMLInputElement>('subject')
  subject.value = lastSubject ?? selected()?.subject ?? documents.find((d) => d.subject !== null)?.subject ?? ''
  node<HTMLDialogElement>('import-dialog').showModal()
  subject.select()
  void run(() => fillImportRubrics(true))
}

/**
 * 불러오기 창의 평가 지침 목록 ([Q-40]). 같은 과목에 쓰던 지침을 골라 둔다.
 * 과목을 고치면 사용자가 지침을 직접 고르지 않은 동안에만 다시 골라 둔다.
 */
let importRubricTouched = false
async function fillImportRubrics(reset: boolean): Promise<void> {
  if (reset) importRubricTouched = false
  const pick = node<HTMLSelectElement>('import-rubric')
  const result = await window.agent.listRubricTemplates({ subject: node<HTMLInputElement>('subject').value })
  const keep = pick.value
  pick.replaceChildren(option('', '나중에 고르기'))
  if (result.status === 'failed') { notify(result.message); return }
  for (const template of result.templates) pick.append(option(template.id, template.name))
  pick.value = importRubricTouched ? keep : result.suggestedId ?? ''
}

function empty(container: HTMLElement, tab: Tab): void {
  const box = element('div', 'empty-state')
  box.append(element('h1', undefined, documents.length === 0 ? '보고서를 불러와 주세요' : '왼쪽에서 보고서를 골라 주세요'))
  const button = element('button', 'primary-button', '＋ 보고서 불러오기')
  button.addEventListener('click', showImport)
  box.append(button)
  container.replaceChildren(box)
  // 첫 실행 안내는 늦게 와도 좋다. 빈 화면을 먼저 보여 주고 뒤에 붙인다 (9단계).
  if (tab === 'document') void run(() => showFirstRun(container))
}

/** 아직 남은 첫 실행 설정을 빈 문서 화면에 덧붙인다. 실패해도 빈 화면은 그대로 쓴다. */
async function showFirstRun(container: HTMLElement): Promise<void> {
  const guide = await window.agent.getFirstRun()
  if (!container.isConnected || documents.length > 0) return
  const card = renderFirstRun({ guide, onImport: showImport,
    onSettings: () => { void run(showSettings) } })
  if (card !== null) container.append(card)
}

function syncNavigation(): void {
  for (const tab of tabs) {
    node(tab).hidden = settingsOpen || tab !== activeTab
    const button = node<HTMLButtonElement>(`tab-${tab}`)
    button.setAttribute('aria-selected', String(!settingsOpen && tab === activeTab))
    button.tabIndex = tab === activeTab ? 0 : -1
  }
  node('settings').hidden = !settingsOpen
  node('settings-toggle').setAttribute('aria-pressed', String(settingsOpen))
  // 저장 감지는 자동이다. 손으로 다시 읽기는 읽기에 실패한 문서에서만 보인다 ([Q-39]).
  const refresh = node<HTMLButtonElement>('refresh')
  refresh.hidden = selectedId === null || !readFailures.has(selectedId) || selected()?.pathLost === true
}

function renderSidebar(): void {
  const rows = documents.map((summary) => {
    const row = element('li')
    const button = element('button', `report-item${summary.documentId === selectedId ? ' report-item--selected' : ''}`)
    button.type = 'button'
    button.setAttribute('aria-pressed', String(summary.documentId === selectedId))
    button.title = summary.path
    button.append(element('strong', 'report-name', summary.displayName.replace(/\.hwpx$/i, '')),
      element('span', 'report-item-meta', summary.subject ?? '과목 없음'))
    if (summary.pathLost) button.append(element('span', 'lost-badge', '파일 없음'))
    button.addEventListener('click', () => { void run(async () => {
      selectedId = summary.documentId
      renderSidebar()
      await showTab(activeTab)
    }) })
    row.append(button)
    return row
  })
  node('documents').replaceChildren(...rows)
  // 보조 창에서는 사이드바가 숨으므로 위쪽의 고르기 칸으로 보고서를 바꾼다.
  const pick = node<HTMLSelectElement>('compact-document')
  pick.replaceChildren(...documents.map((d) => option(d.documentId, d.displayName.replace(/\.hwpx$/i, ''))))
  pick.value = selectedId ?? ''
  if (rows.length === 0) node('documents').append(element('li', 'sidebar-empty', '＋ 로 보고서를 불러오세요.'))
  syncNavigation()
}

async function loadDocuments(): Promise<void> {
  const sequence = ++listSequence
  const result = await window.agent.listDocuments()
  if (sequence !== listSequence) return
  documents = result
  if (!documents.some((d) => d.documentId === selectedId)) selectedId = documents[0]?.documentId ?? null
  renderSidebar()
}

async function showDocument(): Promise<void> {
  const summary = selected()
  const sequence = ++workspaceSequence
  if (summary === undefined) { empty(node('document'), 'document'); return }
  node('document').replaceChildren(element('div', 'empty-inline', '불러오는 중…'))
  const result = await window.agent.getDocumentWorkspace(summary.documentId)
  if (sequence !== workspaceSequence || summary.documentId !== selectedId) return
  if (result.status === 'failed') {
    node('document').replaceChildren(element('div', 'empty-inline', result.message))
    notify(result.message)
    return
  }
  renderDocumentWorkspace({ container: node('document'), workspace: result.workspace,
    onReview: () => { void run(() => showTab('review')) },
    onReconnect: () => { void run(async () => {
      const result = await window.agent.reconnectDocument(summary.documentId)
      if (result.status === 'canceled') return
      if (result.status === 'failed') { notify(result.message); return }
      notify('새 경로에 연결했습니다.')
      await loadDocuments()
      await showDocument()
    }) },
    onCheckpoint: (label) => run(async () => {
      const result = await window.agent.markCheckpoint(summary.documentId, label)
      if (result.status === 'failed') { notify(result.message); return }
      notify(`체크포인트 '${result.checkpoint.label}' 저장됨`)
      await loadDocuments()
      if (selectedId === summary.documentId) await showDocument()
    }),
    onRestore: (checkpointId) => run(async () => {
      const result = await window.agent.restoreCheckpoint(checkpointId)
      if (result.status === 'failed') notify(result.message)
      if (result.status === 'restored') notify(`${result.path}에 새 파일로 되살렸습니다.`)
    }),
    onDeleteCheckpoint: (checkpointId) => run(async () => {
      const result = await window.agent.deleteCheckpoint(checkpointId)
      if (result.status === 'canceled') return
      if (result.status === 'failed') { notify(result.message); return }
      notify('체크포인트를 삭제했습니다.')
      await loadDocuments()
      if (selectedId === summary.documentId) await showDocument()
    }),
    onDelete: () => run(() => deleteDocument(summary)),
  })
}

/** 보고서를 이 앱에서 지운다. 확인 창은 메인 프로세스가 띄운다. 한글 원본은 그대로다. */
async function deleteDocument(summary: DocumentSummary): Promise<void> {
  const result = await window.agent.deleteDocument(summary.documentId)
  if (result.status === 'canceled') return
  if (result.status === 'failed') { notify(result.message); return }
  reviewPanels.delete(summary.documentId)
  readFailures.delete(summary.documentId)
  forgetDocumentEditor(summary.documentId)
  if (selectedId === summary.documentId) selectedId = null
  notify(`'${summary.displayName.replace(/\.hwpx$/i, '')}' 을(를) 삭제했습니다. 한글 원본은 그대로입니다.`)
  await loadDocuments()
  await showTab(activeTab)
}

async function showTab(tab: Tab): Promise<void> {
  settingsOpen = false
  activeTab = tab
  syncNavigation()
  if (tab === 'growth') { await openGrowth(node('growth'),documents,selectedId,notify); return }
  // 지침 모음은 보고서를 고르지 않아도 쓴다 ([Q-40]).
  if (tab === 'rubric') { await showRubric(); return }
  const summary = selected()
  // 보고서가 없어도 다듬기는 쓴다 ([Q-46]). 검토 자리에 다듬기만 띄운다.
  if (summary === undefined && tab === 'review') {
    await openPolish({ container: node('review'), document: undefined, notify }); return
  }
  if (summary === undefined) { empty(node(tab), tab); return }
  if (tab === 'document') { await showDocument(); return }
  let container = reviewPanels.get(summary.documentId)
  const isNew = container === undefined
  if (container === undefined) {
    container = element('div', 'review-view')
    reviewPanels.set(summary.documentId, container)
  }
  node(tab).replaceChildren(container)
  if (tab === 'review') {
    const documentId = summary.documentId
    // 검토는 평가 지침과 떨어져 있다 ([Q-48]). 지침을 확정하라고 묻지 않는다.
    if (isNew) await openReviewPanel({ container, documentId, notify, subject: summary.subject })
    else await refreshReviewPanel(container, summary.documentId)
  }
}

async function showRubric(): Promise<void> {
  await openRubricTab({ container: node('rubric'), document: selected(), documents, notify,
    onSubjectChanged: () => run(loadDocuments),
    // 확정 지침이 바뀐 보고서의 검토 화면을 다시 읽는다 (확정 여부·추천 관점이 달라진다).
    onRubricChanged: (ids) => {
      for (const id of ids) {
        const panel = reviewPanels.get(id)
        if (panel !== undefined) void run(() => refreshReviewPanel(panel, id))
      }
    } })
}

/**
 * 보조 창 모드 ([Q-44]). 한글 옆에 좁게 붙이고 늘 위에 띄운다. 사이드바·탭을 숨기고
 * 말로 하는 요청 칸과 피드백만 남긴다. 창 크기는 메인 프로세스가 바꾼다.
 */
async function setCompact(on: boolean): Promise<void> {
  const result = await window.agent.setCompactWindow(on)
  compact = result.compact
  document.body.classList.toggle('compact', compact)
  const toggle = node('compact-toggle')
  toggle.setAttribute('aria-pressed', String(compact))
  toggle.setAttribute('aria-label', compact ? '큰 창으로' : '보조 창으로')
  toggle.title = compact ? '큰 창으로 돌아가기' : '보조 창으로 (한글 옆에 좁게, 늘 위에)'
  if (compact) await showTab('review')
}

async function showSettings(): Promise<void> {
  settingsOpen = true
  syncNavigation()
  await openSettings({ container: node('ai-settings'), notify, onSettingsChanged: showConnection })
  const info = await window.agent.getAppInfo()
  node('info').replaceChildren()
  for (const [label, value] of [['앱 버전', info.appVersion], ['로컬 데이터', info.userDataPath], ['로그', info.logPath]]) {
    node('info').append(element('dt', undefined, label), element('dd', undefined, value))
  }
}

async function connection(): Promise<void> {
  const result = await window.agent.getAiSettings()
  if (result.status === 'failed') { node('connection-status').textContent = 'AI 연결 확인 필요'; return }
  showConnection(result.settings)
}

function showConnection(state: AiSettingsView): void {
  node('connection-status').textContent = !state.online ? '오프라인' :
    state.reviewAvailable ? 'AI 연결됨' : 'AI 키 필요'
}

function onDocumentEvent(event: DocumentEvent): void {
  if (event.kind === 'failed') readFailures.add(event.documentId)
  if (event.kind === 'saved') readFailures.delete(event.documentId)
  // 바뀐 글이 있는 새 버전이면 검토 화면이 "바뀐 부분 검토" 를 띄운다 ([Q-51]).
  if (event.kind === 'saved' && !event.alreadyKnown && event.changedCount > 0) {
    noteSaved(event.documentId, event.versionOrdinal)
  }
  // 요약이 도착한 것은 알리지 않는다. 목록만 조용히 다시 읽는다.
  if (event.kind !== 'summary') {
    notify(event.kind === 'saved' ? event.alreadyKnown ? '' :
      `버전 ${event.versionOrdinal} 기록 · 문단 ${event.changedCount}개 변경` : event.message)
  }
  void run(async () => {
    await loadDocuments()
    if (event.documentId !== selectedId || settingsOpen) return
    if (activeTab === 'document') await showDocument()
    if (activeTab === 'review') {
      const panel = reviewPanels.get(event.documentId)
      if (panel !== undefined) await refreshReviewPanel(panel, event.documentId)
    }
  })
}

async function start(): Promise<void> {
  for (const tab of tabs) {
    const button = node(`tab-${tab}`)
    button.addEventListener('click', () => { void run(() => showTab(tab)) })
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      const next = tabs[index]!
      node(`tab-${next}`).focus()
      void run(() => showTab(next))
    })
  }
  node('choose').addEventListener('click', showImport)
  node('import-cancel').addEventListener('click', () => node<HTMLDialogElement>('import-dialog').close())
  node<HTMLInputElement>('subject').maxLength = SUBJECT_MAX_LENGTH
  node('subject').addEventListener('change', () => { void run(() => fillImportRubrics(false)) })
  node('import-rubric').addEventListener('change', () => { importRubricTouched = true })
  node('import-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const subject = node<HTMLInputElement>('subject').value
    const templateId = node<HTMLSelectElement>('import-rubric').value
    node<HTMLDialogElement>('import-dialog').close()
    void run(async () => {
      const result = await window.agent.chooseDocument(subject)
      if (result.status === 'canceled') return
      if (result.status === 'failed') { notify(result.message); return }
      lastSubject = result.document.subject
      selectedId = result.document.documentId
      // 고른 지침을 적용한다. 고르는 것이 사용자의 확정이다 (PRD 4.1, [Q-40]).
      let applied = ''
      if (templateId !== '') {
        const done = await window.agent.applyRubricTemplate(result.document.documentId, templateId)
        applied = done.status === 'applied' ? '' : ` 평가 지침은 적용하지 못했습니다: ${done.message}`
      }
      await loadDocuments()
      // 지침 탭을 거치지 않는다. 고르지 않았으면 검토를 요청하는 자리에서 고른다 ([Q-39]).
      notify(`보고서를 불러왔습니다.${applied}`)
      await showTab('review')
    })
  })
  node('refresh').addEventListener('click', () => { void run(async () => {
    if (selectedId === null) return
    const result = await window.agent.refreshDocument(selectedId)
    if (result.status === 'failed') notify(result.message)
  }) })
  node('settings-toggle').addEventListener('click', () => { void run(settingsOpen ? () => showTab(activeTab) : showSettings) })
  node('compact-document').addEventListener('change', () => { void run(async () => {
    selectedId = node<HTMLSelectElement>('compact-document').value || null
    renderSidebar()
    await showTab('review')
  }) })
  node('compact-toggle').addEventListener('click', () => { void run(() => setCompact(!compact)) })
  node('settings-close').addEventListener('click', () => { void run(() => showTab(activeTab)) })
  window.agent.onDocumentEvent(onDocumentEvent)
  for (const event of ['online', 'offline']) window.addEventListener(event, () => { void run(connection) })
  await loadDocuments()
  await showTab('document')
  void run(connection)
}

void run(start)
