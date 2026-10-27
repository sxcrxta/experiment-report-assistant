import type { DocumentSummary } from '../../../shared/ipc.js'
import { PERSONAL_TEXT_MAX, REACTION_LABELS, type GrowthView, type PersonalDelete,
  type PersonalResult } from '../../../shared/personalization.js'
import { REVIEW_PERSPECTIVE_LABELS } from '../../../shared/review.js'
import { element, option } from './dom.js'
import { renderReaction } from './reaction.js'

const IMPROVEMENT = { 'confirmed-change':'실제 변경 + 사용자 수정 완료',changed:'실제 변경 · 개선 판단 미확정',
  unconfirmed:'실제 변경 미확인',unresolved:'문단 연결 미확인 · 삭제/분할을 개선으로 판단하지 않음' }
const sequences = new WeakMap<HTMLElement,number>()
// 탭 전환/다른 기록 저장 때문에 아직 저장하지 않은 입력이 사라지지 않게 한다.
const drafts = new Map<string,string>()
let guidelineEditingId:string|undefined
/**
 * 사용자가 펼쳐 둔 접힘 영역. 저장 뒤 다시 그려도 펼친 채로 둔다.
 * 요약만 늘 펼쳐 두고 나머지는 접어서 시작한다 ([Q-39]).
 */
const openSections = new Set<string>()

export async function openGrowth(container: HTMLElement, documents: DocumentSummary[], selectedId:string|null,
  notify:(message:string)=>void): Promise<void> {
  const sequence=(sequences.get(container)??0)+1;sequences.set(container,sequence)
  container.replaceChildren(element('div','empty-inline','불러오는 중…'))
  try {
    const result = await window.agent.getGrowth()
    if (sequences.get(container)!==sequence) return
    if (result.status!=='ok') throw new Error(result.status==='failed'?result.message:'불러오기를 취소했습니다.')
    render(result.value)
  } catch (cause) {
    if (sequences.get(container)!==sequence) return
    const error = element('div','empty-state')
    error.append(element('p',undefined,cause instanceof Error?cause.message:'기록을 불러오지 못했습니다.'))
    const retry=element('button',undefined,'다시 불러오기')
    retry.addEventListener('click',()=>{void openGrowth(container,documents,selectedId,notify)})
    error.append(retry);container.replaceChildren(error)
  }

  function render(view:GrowthView):void {
    let busy=false
    async function execute(action:()=>Promise<PersonalResult<unknown>>, onSaved?:()=>void):Promise<void> {
      if(busy) return
      busy=true
      const controls=[...container.querySelectorAll<HTMLInputElement>('button,input,textarea,select')]
        .map(control=>({control,disabled:control.disabled}))
      controls.forEach(({control})=>{control.disabled=true})
      try {
        const result=await action()
        if(result.status==='failed') {notify(result.message);return}
        if(result.status==='canceled') return
        onSaved?.()
        notify('저장했습니다.')
        await openGrowth(container,documents,selectedId,notify)
      } catch {notify('작업을 마치지 못했습니다. 입력은 그대로 있으니 다시 시도해 주세요.')}
      finally {busy=false;controls.forEach(({control,disabled})=>{control.disabled=disabled})}
    }
    function action(label:string,run:()=>Promise<PersonalResult<unknown>>,onSaved?:()=>void):HTMLButtonElement {
      const button=element('button',undefined,label);button.type='button'
      button.addEventListener('click',()=>{void execute(run,onSaved)})
      return button
    }
    function remove(input:PersonalDelete):HTMLButtonElement {
      return action('삭제',()=>window.agent.deletePersonalRecord(input))
    }
    function textarea(label:string,value='',key=label):HTMLTextAreaElement {
      const field=element('textarea');field.rows=3;field.value=drafts.get(key)??value;field.maxLength=PERSONAL_TEXT_MAX
      field.addEventListener('input',()=>drafts.set(key,field.value))
      field.setAttribute('aria-label',label);field.placeholder=label
      return field
    }
    function section(title:string):HTMLElement {
      const box=element('section','growth-section');box.append(element('h2',undefined,title));return box
    }
    /** 접어 두는 영역. 제목에 개수를 붙여 펼치지 않아도 무엇이 있는지 보이게 한다 */
    function folded(key:string,title:string):HTMLDetailsElement {
      const box=element('details','growth-section growth-fold')
      box.open=openSections.has(key)
      box.addEventListener('toggle',()=>{ if(box.open) openSections.add(key); else openSections.delete(key) })
      box.append(element('summary',undefined,title));return box
    }
    const header=element('header','page-heading')
    const title=element('div');title.append(element('h1',undefined,'성장 기록'))
    header.append(title)
    const content=element('div','growth-content')

    const summary=section('성장 요약')
    const summarize=action('요약 만들기',()=>window.agent.summarizeGrowth('quick'))
    // 무엇이 나가는지 버튼에 붙여 둔다 (`CLAUDE.md` §4).
    summarize.title='관점별 집계만 보냅니다. 보고서 본문·파일명·자기평가·반박 원문은 보내지 않습니다.'
    summarize.disabled=!view.summaryAvailable
    // 심층 분석은 Claude 모드를 쓸 수 있을 때만 (PRD 4.6). 없어도 위의 짧은 요약은 그대로 쓴다.
    const deepSummarize=action('심층 분석',()=>window.agent.summarizeGrowth('deep'))
    deepSummarize.disabled=!view.deepSummaryAvailable
    deepSummarize.title=view.deepSummaryAvailable?summarize.title:view.deepUnavailableMessage
    const buttons=element('div','chips');buttons.append(summarize,deepSummarize)
    summary.append(buttons)
    if(view.unavailableMessage!=='') summary.append(element('p','muted',view.unavailableMessage))
    if(view.summary!==null) {
      const saved=view.summary
      for(const sentence of saved.sentences) {
        const row=element('div','growth-summary-sentence');row.append(element('p',undefined,sentence.text))
        for(const id of sentence.evidenceIds) {
          const source=view.observations.find(o=>o.id===id)
          if(source===undefined) continue
          const link=element('a',undefined,`${source.documentName} · v${source.versionOrdinal} → v${source.afterVersionOrdinal}`)
          link.href=`#growth-evidence-${id}`
          link.addEventListener('click',()=>{
            // 근거 영역이 접혀 있어도 따라갈 수 있게 바깥부터 편다.
            evidence.open=true
            const target=document.getElementById(`growth-evidence-${id}`)
            if(target instanceof HTMLDetailsElement) target.open=true
          })
          row.append(link,document.createTextNode(' '))
        }
        summary.append(row)
      }
      summary.append(element('p','muted',`${new Date(saved.createdAt).toLocaleString('ko-KR')} · ${saved.modelId}`),remove({kind:'summary',id:saved.id}))
    } else summary.append(element('p','muted','아직 요약이 없습니다.'))

    const stats=folded('stats',`관점별 집계 (${view.groups.length})`)
    stats.append(element('p','muted','서로 다른 문서 버전에서 관찰된 수입니다. 2개 이상이면 반복 관찰 후보이며 단정이 아닙니다.'))
    const table=element('table','section-table')
    const heading=element('tr')
    for(const label of ['관점 / 분류','관찰 버전','근거 문서 버전','실제 변경','변경 + 수정 완료','반박']) heading.append(element('th',undefined,label))
    const thead=element('thead');thead.append(heading);table.append(thead)
    const tbody=element('tbody')
    for(const group of view.groups) {
      const row=element('tr')
      row.append(element('td',undefined,
        `${REVIEW_PERSPECTIVE_LABELS[group.perspective]}${group.repeatCount>=2?' · 반복 관찰 후보':''}`),
        element('td',undefined,String(group.repeatCount)))
      // 반복 관찰은 근거 없이 말하지 않는다. 어떤 문서의 몇 번째 버전에서 봤는지 함께 적는다.
      const evidence=element('td')
      if(group.versions.length===0) evidence.append(element('span','muted','근거 버전 없음'))
      for(const v of group.versions)
        evidence.append(element('span','badge',`${v.documentName} · 버전 ${v.versionOrdinal}`),document.createTextNode(' '))
      row.append(evidence)
      for(const value of [group.changedCount,group.improvedCount,group.rebuttalCount])
        row.append(element('td',undefined,String(value)))
      tbody.append(row)
    }
    table.append(tbody);stats.append(table)
    if(view.groups.length===0) stats.append(element('p','muted','아직 없습니다.'))

    const guidelines=section('개인화 지침')
    guidelines.append(element('p','muted','자동으로 지침을 만들지 않습니다. 승인한 것만 다음 검토에 쓰입니다.'))
    // 새 지침 입력은 접어 둔다. 고치기·판단에서 옮기기를 누르면 펼친다.
    const writer=folded('guideline-form','＋ 새 지침')
    const form=element('form','personal-form')
    const doc=element('select');doc.setAttribute('aria-label','개인화 기준 보고서')
    documents.forEach(d=>doc.append(option(d.documentId,d.displayName)))
    if(selectedId!==null) doc.value=selectedId
    if(documents.some(d=>d.documentId===drafts.get('guideline-document'))) doc.value=drafts.get('guideline-document')!
    doc.addEventListener('change',()=>drafts.set('guideline-document',doc.value))
    const scope=element('select');scope.setAttribute('aria-label','개인화 적용 범위')
    scope.append(option('document','이번 문서'),option('subject','선택한 문서의 과목'),option('global','전체 보고서'))
    scope.value=drafts.get('guideline-scope')??'document'
    scope.addEventListener('change',()=>drafts.set('guideline-scope',scope.value))
    const instruction=textarea('승인할 개인화 지침')
    instruction.required=true
    const save=element('button','primary-button','내용·범위 확인 후 승인');save.type='submit';save.disabled=documents.length===0
    if(guidelineEditingId!==undefined) save.textContent='변경 내용·범위 재승인'
    form.append(doc,scope,instruction,save)
    const reset=element('button',undefined,'새 지침 작성');reset.type='button'
    reset.addEventListener('click',()=>{
      guidelineEditingId=undefined;instruction.value='';drafts.delete('승인할 개인화 지침')
      save.textContent='내용·범위 확인 후 승인';instruction.focus()
    })
    form.append(reset)
    form.addEventListener('submit',event=>{event.preventDefault();void execute(()=>window.agent.savePersonalRecord({
      kind:'guideline',...(guidelineEditingId===undefined?{}:{id:guidelineEditingId}),documentId:doc.value,
      scope:scope.value as 'document'|'subject'|'global',text:instruction.value,
    }),()=>{guidelineEditingId=undefined;drafts.delete('승인할 개인화 지침')})})
    writer.append(form)
    guidelines.append(writer)
    if(view.guidelines.length===0) guidelines.append(element('p','muted','아직 없습니다.'))
    for(const g of view.guidelines) {
      const row=element('article','growth-entry')
      const label=g.scope==='global'?'전체 보고서':g.scope==='subject'?`과목: ${g.subject}`:
        `문서: ${documents.find(d=>d.documentId===g.documentId)?.displayName??'기록된 문서'}`
      row.append(element('span','badge',`${label} · 수정판 ${g.revision}`),element('p',undefined,g.text))
      const edit=element('button',undefined,'수정');edit.type='button'
      edit.addEventListener('click',()=>{
        guidelineEditingId=g.id;scope.value=g.scope;instruction.value=g.text
        doc.value=g.documentId??documents.find(d=>d.subject===g.subject)?.documentId??selectedId??documents[0]?.documentId??''
        drafts.set('승인할 개인화 지침',g.text);drafts.set('guideline-scope',g.scope);drafts.set('guideline-document',doc.value)
        save.textContent='변경 내용·범위 재승인';writer.open=true;instruction.focus()
      })
      row.append(edit,remove({kind:'guideline',id:g.id}));guidelines.append(row)
    }

    const assessments=folded('assessments',`자기평가 (${view.assessments.length})`)
    for(const a of view.assessments) {
      const row=element('details','growth-entry')
      row.append(element('summary',undefined,`${documents.find(d=>d.documentId===a.documentId)?.displayName??'보고서'} · v${a.versionOrdinal} · ${a.phase==='before'?'피드백 전':'피드백 후'}`))
      const field=textarea('자기평가 수정',a.text,`assessment-${a.id}`)
      row.append(field,action('저장',()=>window.agent.savePersonalRecord({kind:'assessment',id:a.id,
        documentId:a.documentId,phase:a.phase,text:field.value}),()=>drafts.delete(`assessment-${a.id}`)),remove({kind:'assessment',id:a.id}))
      assessments.append(row)
    }
    if(view.assessments.length===0) assessments.append(element('p','muted','검토 화면에서 남길 수 있습니다.'))

    const evidence=folded('evidence',`수정 근거 (${view.observations.length})`)
    evidence.append(element('p','muted','여기서 삭제하면 집계에서만 빠지고 원 피드백은 남습니다.'))
    for(const o of view.observations) {
      const row=element('details','growth-entry');row.id=`growth-evidence-${o.id}`
      row.append(element('summary',undefined,`${o.documentName} · v${o.versionOrdinal} → v${o.afterVersionOrdinal} · ${REVIEW_PERSPECTIVE_LABELS[o.perspective]}`),
        element('p',undefined,`관찰된 문제: ${o.problem}`),element('p',undefined,`AI 근거: ${o.aiJudgment}`),
        element('p',undefined,`내 판단: ${o.reaction===null?'미기록':REACTION_LABELS[o.reaction.kind]}`),
        element('p',undefined,`판단·반박 사유: ${o.reaction?.reason||'미기록'}`),element('p','badge',IMPROVEMENT[o.improvement]))
      const before=element('pre','growth-text',`수정 전 (v${o.versionOrdinal})\n${o.before}`)
      const after=element('pre','growth-text',`현재 (v${o.afterVersionOrdinal})\n${o.after??'원래 문단을 연결하지 못했습니다.'}`)
      const note=textarea('메모',o.note,`observation-${o.id}`)
      row.append(before,after,note,action('메모 저장',()=>window.agent.savePersonalRecord({kind:'observation',id:o.id,note:note.value}),()=>drafts.delete(`observation-${o.id}`)),
        remove({kind:'observation',id:o.id}))
      row.append(renderReaction(o.documentId,o.id,o.reaction??undefined,notify,
        ()=>openGrowth(container,documents,selectedId,notify)))
      if(o.reaction?.reason) {
        const propose=element('button',undefined,'이 판단으로 지침 작성');propose.type='button'
        propose.addEventListener('click',()=>{
          guidelineEditingId=undefined;doc.value=o.documentId;scope.value='document';instruction.value=o.reaction!.reason
          drafts.set('승인할 개인화 지침',instruction.value);drafts.set('guideline-document',doc.value);drafts.set('guideline-scope','document')
          save.textContent='내용·범위 확인 후 승인';writer.open=true;instruction.focus()
          notify('내 판단을 지침 편집기에 옮겼습니다. 내용과 적용 범위를 확인하고 승인해 주세요.')
        })
        row.append(propose)
      }
      if(o.reaction!==null) row.append(action('내 판단 삭제',()=>window.agent.deletePersonalRecord({kind:'reaction',id:o.id})))
      evidence.append(row)
    }
    content.append(summary,guidelines,stats,evidence,assessments)
    container.replaceChildren(header,content)
  }
}
