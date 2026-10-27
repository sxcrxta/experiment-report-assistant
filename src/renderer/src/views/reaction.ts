/**
 * 피드백에 대한 내 판단과 자기평가 (PRD 4.4, 8단계).
 *
 * 손길을 줄인 방식 ([Q-39])
 * - 반응 버튼은 **누르면 바로 저장**한다. 따로 저장 버튼을 누르지 않는다.
 * - **반박만** 사유를 받은 뒤 저장한다 (사유 없는 반박은 받지 않는다). 다른 판단의 사유는 선택이다.
 * - 심층 재검토는 반박·이해되지 않음을 **저장한 뒤에만** 보인다. 도는 동안에는 중단할 수 있다.
 * - 자기평가 시점(피드백 전/후)은 부르는 쪽이 정해 준 값으로 시작하고, 사용자가 바꿀 수 있다.
 *
 * 저장은 모두 사용자가 누른 버튼에서만 일어난다. AI 판단이 내 판단을 덮지 않는다 (`CLAUDE.md` §1).
 */
import { PERSONAL_TEXT_MAX, REACTIONS, REACTION_LABELS, type ReactionKind, type SelfAssessment,
  type UserReaction } from '../../../shared/personalization.js'
import { element } from './dom.js'

const drafts = new Map<string,{kind:ReactionKind|null;reason:string;open:boolean}>()
const assessments = new Map<string,{phase:'before'|'after';text:string}>()

/** 재검토를 권할 만한 판단. 동의했거나 이미 고친 피드백을 다시 볼 까닭은 적다 */
const RE_REVIEW_KINDS: readonly ReactionKind[] = ['rebuttal', 'unclear']

export function renderReaction(documentId: string, feedbackId: string, saved: UserReaction | undefined,
  notify: (message:string)=>void, onSaved?:()=>Promise<void>): HTMLElement {
  const box = element('div','card-block reaction-editor')
  const draft = drafts.get(feedbackId)
  /** 화면에서 고른 판단. 반박은 사유를 받기 전까지 저장되지 않은 채 고른 상태로 있다 */
  let kind: ReactionKind | null = draft?.kind ?? saved?.kind ?? null
  let savedKind: ReactionKind | null = saved?.kind ?? null
  box.append(element('div','card-block-title','내 판단'))
  const grid = element('div','reaction-grid')

  const reasonArea = element('div','reaction-reason')
  const reason = element('textarea')
  reason.rows=2; reason.maxLength=PERSONAL_TEXT_MAX
  reason.value=draft?.reason??saved?.reason??''
  reason.setAttribute('aria-label','판단·반박 사유')
  const reasonSave = element('button',undefined,'사유 저장')
  reasonSave.type='button'
  reasonArea.append(reason,reasonSave)
  const reasonToggle = element('button','text-button','사유 덧붙이기')
  reasonToggle.type='button'
  let reasonOpen = draft?.open ?? (saved?.reason ?? '') !== ''

  const status = element('p','muted')
  const remember = () => drafts.set(feedbackId,{kind,reason:reason.value,open:reasonOpen})
  reason.addEventListener('input',remember)

  const choices: HTMLButtonElement[] = []
  const deep = element('button',undefined,'심층 재검토 요청')
  deep.type='button'
  // 재검토가 판단을 덮는다고 오해하지 않게, 재검토 버튼 옆에만 한 줄 적는다 (`CLAUDE.md` §1).
  const deepNote = element('p','muted','재검토해도 원 피드백과 내 판단을 지우지 않습니다.')
  const stop = element('button',undefined,'심층 재검토 중단')
  stop.type='button'
  stop.hidden=true

  function sync(): void {
    choices.forEach((b,i)=>b.setAttribute('aria-pressed',String(REACTIONS[i]===kind)))
    const rebutting = kind==='rebuttal'
    reasonArea.hidden = !(reasonOpen || rebutting)
    reasonToggle.hidden = !reasonArea.hidden
    reason.placeholder = rebutting ? '반박 사유 (필수)' : '사유 (선택)'
    reasonSave.textContent = rebutting && savedKind!=='rebuttal' ? '반박 저장' : '사유 저장'
    status.textContent = savedKind===null
      ? rebutting ? '반박 사유를 적고 저장해 주세요.' : ''
      : `저장됨 · ${REACTION_LABELS[savedKind]}`
    deep.hidden = savedKind===null || !RE_REVIEW_KINDS.includes(savedKind)
    deepNote.hidden = deep.hidden
  }

  function lock(locked: boolean): void {
    reason.disabled=locked; reasonSave.disabled=locked; choices.forEach(b=>{b.disabled=locked})
  }

  async function save(target: ReactionKind): Promise<void> {
    if (target==='rebuttal' && !reason.value.trim()) { notify('반박 사유를 적어 주세요.'); reason.focus(); return }
    lock(true)
    try {
      const result = await window.agent.savePersonalRecord({kind:'reaction',documentId,feedbackId,reaction:target,reason:reason.value})
      if (result.status==='failed') { notify(result.message); return }
      if (result.status==='canceled') return
      drafts.delete(feedbackId)
      savedKind=target
      sync()
      notify(`내 판단 저장 · ${REACTION_LABELS[target]}`)
      await onSaved?.()
    } catch { notify('판단을 저장하지 못했습니다. 입력은 그대로 있으니 다시 시도해 주세요.') }
    finally { lock(false) }
  }

  for (const value of REACTIONS) {
    const button = element('button','reaction-button',REACTION_LABELS[value])
    button.type='button'
    button.addEventListener('click',()=>{
      kind=value; remember(); sync()
      // 반박은 사유가 있어야 저장한다. 사유 칸만 열고 기다린다.
      if (value==='rebuttal' && !reason.value.trim()) { reason.focus(); return }
      void save(value)
    })
    choices.push(button); grid.append(button)
  }
  reasonToggle.addEventListener('click',()=>{ reasonOpen=true; remember(); sync(); reason.focus() })
  reasonSave.addEventListener('click',()=>{
    if (kind===null) { notify('먼저 판단 버튼을 골라 주세요.'); return }
    void save(kind)
  })

  // 심층 재검토 (PRD 4.3·4.4). 원 피드백과 내 판단을 함께 보내 다시 본다.
  // 새 단계를 여는 것이 아니라 이미 받은 피드백을 다시 보는 것이라, 단계 선택이 따로 없다.
  deep.addEventListener('click',()=>{ void (async()=>{
    deep.disabled=true
    const before = deep.textContent
    deep.textContent='심층 재검토 중…'
    stop.hidden=false
    notify('심층 재검토 중… (원 피드백과 내 판단을 함께 보냅니다)')
    try {
      const result = await window.agent.requestReReview(documentId,feedbackId)
      if (result.status==='failed') { notify(result.message); return }
      notify(`심층 재검토 피드백 ${result.itemCount}개`)
      await onSaved?.()
    } catch { notify('심층 재검토를 요청하지 못했습니다. 잠시 뒤 다시 시도해 주세요.') }
    finally { deep.disabled=false; deep.textContent=before; stop.hidden=true }
  })() })
  stop.addEventListener('click',()=>{ void (async()=>{
    const result = await window.agent.cancelDeepReview()
    notify(result.status==='canceled' ? '심층 재검토를 중단했습니다. 원 피드백과 내 판단은 그대로입니다.'
      : '지금 실행 중인 심층 재검토가 없습니다.')
  })() })

  sync()
  box.append(grid,reasonToggle,reasonArea,status,deep,stop,deepNote)
  return box
}

export function renderSelfAssessment(documentId: string, records: SelfAssessment[], notify:(message:string)=>void,
  suggestedPhase: 'before'|'after' = 'before'): HTMLElement {
  const box = element('details','self-assessment card-block')
  box.append(element('summary',undefined,`자기평가 (${records.length})`))
  const form = element('form','personal-form')
  const draft = assessments.get(documentId)
  let phase: 'before'|'after' = draft?.phase ?? suggestedPhase
  const phaseLine = element('p','muted')
  const phaseSwitch = element('button','text-button')
  phaseSwitch.type='button'
  function showPhase(): void {
    phaseLine.textContent = `${phase==='before'?'AI 피드백 전':'AI 피드백 후'} 기록으로 저장합니다.`
    phaseSwitch.textContent = phase==='before' ? '피드백 후 기록으로 바꾸기' : '피드백 전 기록으로 바꾸기'
    phaseSwitch.setAttribute('aria-label','자기평가 시점 바꾸기')
  }
  const memo = element('textarea')
  memo.rows=3;memo.maxLength=PERSONAL_TEXT_MAX;memo.required=true
  memo.placeholder='직접 발견한 문제나 판단';memo.setAttribute('aria-label','자기평가 내용')
  if (draft!==undefined) memo.value=draft.text
  const remember = () => assessments.set(documentId,{phase,text:memo.value})
  phaseSwitch.addEventListener('click',()=>{ phase = phase==='before' ? 'after' : 'before'; remember(); showPhase() })
  memo.addEventListener('input',remember)
  showPhase()
  const save = element('button',undefined,'자기평가 저장');save.type='submit'
  const list = element('div')
  records.slice(0,3).forEach(r=>list.append(element('p','muted',`v${r.versionOrdinal} · ${r.phase==='before'?'피드백 전':'피드백 후'} · ${r.text}`)))
  const phaseRow = element('div','phase-row')
  phaseRow.append(phaseLine,phaseSwitch)
  form.append(phaseRow,memo,save)
  form.addEventListener('submit',event=>{event.preventDefault();void(async()=>{
    save.disabled=true;memo.disabled=true;phaseSwitch.disabled=true
    try {
      const result = await window.agent.savePersonalRecord({kind:'assessment',documentId,phase,text:memo.value})
      if (result.status==='failed') {notify(result.message);return}
      if (result.status==='canceled') return
      list.prepend(element('p','muted',`${phase==='before'?'피드백 전':'피드백 후'} · ${memo.value}`))
      memo.value='';assessments.delete(documentId)
      notify('자기평가를 저장했습니다.')
    } catch {notify('자기평가를 저장하지 못했습니다. 다시 시도해 주세요.')}
    finally {save.disabled=false;memo.disabled=false;phaseSwitch.disabled=false}
  })()})
  box.append(form,list)
  return box
}
