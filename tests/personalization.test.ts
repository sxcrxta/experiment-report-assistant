import { randomUUID } from 'node:crypto'
import { createReviewContextRepository } from '../src/adapters/repo/review-context.js'
import { createReviewContextService } from '../src/app/review-context.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersonalizationRepository } from '../src/adapters/repo/personalization.js'
import { createPersonalizationService, parsePersonalMutation } from '../src/app/personalization.js'
import { createPersonalizationHandlers } from '../src/main/personalization-ipc.js'
import { createReviewService } from '../src/app/review-request.js'
import { createReviewCacheRepository } from '../src/adapters/repo/cache.js'
import type { ModelCallResult, ReviewModel } from '../src/adapters/model/index.js'
import { createReviewHarness, DOCUMENT_ID, modelReply, REVIEW_TEXTS } from './helpers/review-harness.js'

let h: ReturnType<typeof createReviewHarness>
let repo: ReturnType<typeof createPersonalizationRepository>
let service: ReturnType<typeof createPersonalizationService>
let online: boolean
const goodSummary=()=>JSON.stringify({sentences:[{text:'논리 관점의 관찰 기록과 사용자 판단을 함께 확인할 수 있습니다.',evidence:['E1']}]})
let summarize: ReturnType<typeof vi.fn<NonNullable<ReviewModel['summarizeGrowth']>>>
beforeEach(()=>{
  // 반복 관찰 근거는 8단계가 주입한다. 실제 배선과 같은 길로 카드까지 도달하는지 본다.
  h=createReviewHarness({repeatedObservation:card=>service.repeatedObservation(card)})
  repo=createPersonalizationRepository(h.db);online=true
  summarize=vi.fn(()=>Promise.resolve({ok:true as const,text:goodSummary()}))
  h.model.summarizeGrowth=summarize
  service=createPersonalizationService({documents:h.documents,reviews:h.reviews,repo,models:{quick:h.model,deep:h.deepModel},
    online:{isOnline:()=>online},now:()=>new Date().toISOString(),newId:randomUUID})
})
afterEach(()=>h.close())
async function feedback() {
  h.model.replies.push(modelReply())
  const result=await h.staged.requestStagedReview({documentId:DOCUMENT_ID,scope:'paragraph',paragraphIds:[h.uuidAt(4)],
    perspectives:['logic'],stage:'question'})
  if(!result.ok) throw new Error(result.message)
  return result.response.items[0]!.itemId
}
const guideline={kind:'guideline',documentId:DOCUMENT_ID,scope:'document',text:'근거를 먼저 질문해 주세요.'} as const

describe('자기평가·반응·승인 경계',()=>{
  it('AI 호출 전 자기평가를 오프라인으로 저장·수정·삭제한다 (T-6, T-32)',()=>{
    online=false
    expect(service.mutate({kind:'assessment',documentId:DOCUMENT_ID,phase:'before',text:'오차 원인을 다시 확인하고 싶다.'}).status).toBe('ok')
    const row=repo.assessments()[0]!
    expect(row).toMatchObject({phase:'before',versionOrdinal:1})
    h.saveVersion([...REVIEW_TEXTS,'추가 문단'])
    expect(service.mutate({kind:'assessment',id:row.id,documentId:DOCUMENT_ID,phase:'after',text:'측정 조건을 확인했다.'}).status).toBe('ok')
    expect(repo.assessments()[0]).toMatchObject({versionOrdinal:1,text:'측정 조건을 확인했다.'})
    expect(service.remove({kind:'assessment',id:row.id}).status).toBe('ok')
    expect(repo.assessments()).toEqual([])
    expect(h.model.calls).toHaveLength(0)
  })
  it('모든 반응을 저장하며 반박에는 사유가 필요하고 원 AI 판단은 보존된다',async()=>{
    const id=await feedback()
    expect(service.mutate({kind:'reaction',documentId:DOCUMENT_ID,feedbackId:id,reaction:'rebuttal',reason:' '}).status).toBe('failed')
    online=false
    for(const reaction of ['agree','partial','rebuttal','unclear','completed'])
      expect(service.mutate({kind:'reaction',documentId:DOCUMENT_ID,feedbackId:id,reaction,reason:'측정 근거를 표에 적었다.'}).status).toBe('ok')
    expect(repo.reactions()[0]).toMatchObject({kind:'completed'})
    expect(repo.guidelines()).toEqual([])
    const view=await service.getView()
    expect(view.observations[0]!.aiJudgment).toContain('측정값')
    expect(view.observations[0]!.improvement).toBe('unconfirmed')
    expect(view.summaryAvailable).toBe(false)
  })
  it('다른 문서 피드백과 비정상 입력은 기록하지 않는다',async()=>{
    const id=await feedback();h.addDocument('other',['다른 문서'])
    expect(service.mutate({kind:'reaction',documentId:'other',feedbackId:id,reaction:'agree',reason:''}).status).toBe('failed')
    for(const input of [null,[],{...guideline,text:'x'.repeat(2001)},{...guideline,scope:'all'},{kind:'reaction',documentId:DOCUMENT_ID}])
      expect(parsePersonalMutation(input)).toBeNull()
    expect(repo.reactions()).toEqual([])
  })
  it('승인 없이는 지침이 생기지 않고 IPC 승인 취소도 기록을 남기지 않는다 (T-7)',async()=>{
    expect(service.mutate(guideline).status).toBe('failed')
    const confirm=vi.fn(()=>Promise.resolve(false))
    const handlers=createPersonalizationHandlers({service,documents:h.documents,repo,confirm})
    expect((await handlers.savePersonalRecord(guideline)).status).toBe('canceled')
    expect(repo.guidelines()).toEqual([])
    expect(confirm).toHaveBeenCalledWith('개인화 지침 승인',expect.stringContaining(guideline.text))
    confirm.mockResolvedValue(true)
    expect((await handlers.savePersonalRecord(guideline)).status).toBe('ok')
    expect(repo.guidelines()).toHaveLength(1)
    const saved=repo.guidelines()[0]!
    expect((await handlers.savePersonalRecord({...guideline,id:saved.id,text:'표의 근거부터 확인해 주세요.'})).status).toBe('ok')
    expect(repo.guidelines()[0]!.revision).toBe(2)
    confirm.mockResolvedValue(false)
    expect((await handlers.deletePersonalRecord({kind:'guideline',id:saved.id})).status).toBe('canceled')
    expect(repo.guidelines()).toHaveLength(1)
    confirm.mockResolvedValue(true)
    expect((await handlers.deletePersonalRecord({kind:'guideline',id:saved.id})).status).toBe('ok')
    expect(repo.guidelines()).toEqual([])
  })
  it('문서·과목·전체 범위가 정확하고 변경된 과목에는 이전 과목 지침이 적용되지 않는다',()=>{
    h.addDocument('chem',['문서']);h.addDocument('physics',['문서'])
    h.documents.setSubject('physics','물리')
    for(const scope of ['document','subject','global']) expect(service.mutate({...guideline,scope,text:scope},true).status).toBe('ok')
    expect(service.approvedGuidelines(DOCUMENT_ID).map(g=>g.text).sort()).toEqual(['document','global','subject'])
    expect(service.approvedGuidelines('chem').map(g=>g.text).sort()).toEqual(['global','subject'])
    expect(service.approvedGuidelines('physics').map(g=>g.text)).toEqual(['global'])
    h.documents.setSubject(DOCUMENT_ID,'물리')
    expect(service.approvedGuidelines(DOCUMENT_ID).map(g=>g.text).sort()).toEqual(['document','global'])
  })
})

describe('실제 수정 근거와 성장 요약',()=>{
  it('중복 요청은 반복 횟수를 늘리지 않고 실제 변경과 수정 완료를 함께 집계한다 (T-8)',async()=>{
    const id=await feedback()
    await h.staged.requestStagedReview({documentId:DOCUMENT_ID,scope:'paragraph',paragraphIds:[h.uuidAt(4)],perspectives:['logic'],stage:'question'})
    expect((await service.getView()).groups[0]!.repeatCount).toBe(1)
    service.mutate({kind:'reaction',documentId:DOCUMENT_ID,feedbackId:id,reaction:'completed',reason:'측정값을 명시했다.'})
    const texts=[...REVIEW_TEXTS];texts[4]='온도가 올라가면 압력이 증가했다. 측정값은 2이다.';h.saveVersion(texts)
    let view=await service.getView()
    expect(view.observations.find(o=>o.id===id)).toMatchObject({changed:true,improvement:'confirmed-change',afterVersionOrdinal:2})
    await feedback();view=await service.getView()
    expect(view.groups[0]).toMatchObject({repeatCount:2,improvedCount:1})
    expect(view.groups[0]!.evidenceIds.length).toBeGreaterThanOrEqual(2)
  })
  it('모든 카드에 반복 관찰 근거가 문서 버전과 함께 붙고 새 버전에서 늘어난다 (T-8)',async()=>{
    await feedback()
    const first=await h.staged.getPanel(DOCUMENT_ID,{})
    if('ok' in first) throw new Error(first.message)
    expect(first.cards.length).toBeGreaterThan(0)
    for(const card of first.cards) expect(card.repeatedObservation.count).toBe(card.repeatedObservation.versions.length)
    expect(first.cards[0]!.repeatedObservation).toMatchObject({count:1,
      versions:[{documentName:'doc-1.hwpx',versionOrdinal:1}]})
    // 같은 버전을 다시 요청해도 근거는 늘지 않는다.
    await h.staged.requestStagedReview({documentId:DOCUMENT_ID,scope:'paragraph',paragraphIds:[h.uuidAt(4)],
      perspectives:['logic'],stage:'question'})
    const again=await h.staged.getPanel(DOCUMENT_ID,{})
    if('ok' in again) throw new Error(again.message)
    expect(again.cards[0]!.repeatedObservation.count).toBe(1)
    const texts=[...REVIEW_TEXTS];texts[4]='온도가 올라가면 압력이 증가했다. 값을 적었다.';h.saveVersion(texts)
    await feedback()
    const later=await h.staged.getPanel(DOCUMENT_ID,{})
    if('ok' in later) throw new Error(later.message)
    expect(later.cards[0]!.repeatedObservation.versions.map(v=>v.versionOrdinal)).toEqual([1,2])
  })
  it('문단을 못 찾으면 개선으로 보지 않는다',async()=>{
    const id=await feedback();h.saveVersion(REVIEW_TEXTS.slice(0,4))
    const o=(await service.getView()).observations.find(o=>o.id===id)!
    expect(o).toMatchObject({changed:false,after:null,improvement:'unresolved'})
  })
  it('Gemma 계약 하나로 집계만 전송해 근거가 연결된 요약을 저장한다 (T-25)',async()=>{
    await feedback()
    expect((await service.summarize()).status).toBe('ok')
    const view=await service.getView()
    expect(view.summary!.sentences[0]!.evidenceIds).toEqual([view.observations[0]!.id])
    const sent=JSON.stringify(summarize.mock.calls)
    expect(sent).not.toContain(REVIEW_TEXTS[4])
    expect(sent).not.toContain(DOCUMENT_ID)
    expect(sent).not.toContain('.hwpx')
    expect(view.summary!.modelId).toBe(h.model.modelId)
  })
  it('모델이 바뀌면 저장된 요약을 그대로 보여 주지 않는다',async()=>{
    await feedback()
    expect((await service.summarize()).status).toBe('ok')
    expect((await service.getView()).summary).not.toBeNull()
    // 같은 기록이라도 다른 모델이 쓴 요약은 그대로 쓰지 않는다.
    const other=createPersonalizationService({documents:h.documents,reviews:h.reviews,repo,
      models:{quick:{...h.model,modelId:'other/model'},deep:h.deepModel},online:{isOnline:()=>online},
      now:()=>new Date().toISOString(),newId:randomUUID})
    expect((await other.getView()).summary).toBeNull()
  })
  it('형식·근거·능력 단정을 어기면 3회 후 실패하고 원문은 저장하지 않는다',async()=>{
    await feedback()
    for(const text of ['{}',JSON.stringify({sentences:[{text:'논리 능력이 부족합니다.',evidence:['E1']}]}),
      JSON.stringify({sentences:[{text:'기록입니다.',evidence:['없는근거']} ]})]) {
      summarize.mockClear();summarize.mockResolvedValue({ok:true,text})
      expect((await service.summarize()).status).toBe('failed')
      expect(summarize).toHaveBeenCalledTimes(3)
      expect(repo.summary()).toBeNull()
    }
  })
  it('오프라인·빈 기록·키 없음은 모델을 부르지 않는다',async()=>{
    expect((await service.summarize()).status).toBe('failed')
    await feedback();online=false
    expect((await service.summarize()).status).toBe('failed')
    online=true;h.model.availability={available:false,reason:'no-key',message:'키 없음'}
    expect((await service.summarize()).status).toBe('failed')
    expect(summarize).not.toHaveBeenCalled()
  })
  it('관찰 메모 수정·삭제가 요약을 무효화하며 삭제한 관찰은 다시 생기지 않는다',async()=>{
    const id=await feedback();await service.summarize()
    expect(service.mutate({kind:'observation',id,note:'추가 확인이 필요하다.'}).status).toBe('ok')
    expect(repo.summary()).toBeNull()
    expect((await service.getView()).observations[0]!.note).toBe('추가 확인이 필요하다.')
    await service.summarize();service.remove({kind:'observation',id})
    expect((await service.getView()).observations).toEqual([])
    expect(repo.summary()).toBeNull()
    expect(h.reviews.listReviews(DOCUMENT_ID)).toHaveLength(1)
  })
  it('요약 요청 중 삭제/새 저장은 늦은 응답으로 되살리지 않는다',async()=>{
    const id=await feedback()
    let finish!:(value:ModelCallResult)=>void
    summarize.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const pending=service.summarize()
    await vi.waitFor(()=>expect(summarize).toHaveBeenCalledTimes(1))
    expect((await service.summarize()).status).toBe('failed')
    service.remove({kind:'observation',id})
    finish({ok:true,text:goodSummary()})
    expect((await pending).status).toBe('failed')
    expect(repo.summary()).toBeNull()
  })
  it('지침 승인/수정/삭제가 실제 검토 페이로드와 캐시 키에 반영된다',async()=>{
    const review=createReviewService({documents:h.documents,context:createReviewContextService({repo:createReviewContextRepository(h.db),now:()=>new Date().toISOString()}),reviews:h.reviews,
      cache:createReviewCacheRepository(h.db),models:{quick:h.model,deep:h.deepModel},online:{isOnline:()=>true},now:()=>new Date().toISOString(),
      newId:randomUUID,approvedGuidelines:service.approvedGuidelines})
    const input={documentId:DOCUMENT_ID,depth:'quick',paragraphIds:[h.uuidAt(4)],scope:'paragraph',stage:'question',perspectives:['logic']} as const
    h.model.replies.push(modelReply());await review.requestReview(input)
    service.mutate(guideline,true)
    h.model.replies.push(modelReply());await review.requestReview(input)
    expect(h.model.calls[1]!.personalization.approvedGuidelines).toEqual([guideline.text])
    await review.requestReview(input);expect(h.model.calls).toHaveLength(2)
    const g=repo.guidelines()[0]!
    service.mutate({...guideline,id:g.id,text:'다른 지침'},true)
    h.model.replies.push(modelReply());await review.requestReview(input)
    expect(h.model.calls[2]!.personalization.approvedGuidelines).toEqual(['다른 지침'])
    service.remove({kind:'guideline',id:g.id})
    await review.requestReview(input)
    // 삭제 후 개인화 없는 원래 캐시만 다시 사용할 수 있다.
    expect(h.model.calls).toHaveLength(3)
    expect(service.approvedGuidelines(DOCUMENT_ID)).toEqual([])
  })
})
