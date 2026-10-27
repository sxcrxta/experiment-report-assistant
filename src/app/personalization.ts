import { modelFor, type ReviewModelSet } from '../adapters/model/index.js'
import type { OnlineStatus } from '../adapters/net/online.js'
import type { DocumentRepository } from '../adapters/repo/documents.js'
import type { PersonalizationRepository } from '../adapters/repo/personalization.js'
import type { ReviewRepository } from '../adapters/repo/reviews.js'
import { sha256Hex } from '../core/document/sha256.js'
import { aggregateGrowth, growthPayload, validateGrowthSummary } from '../core/personalization/growth.js'
import { improvement, observationKey } from '../core/personalization/observation.js'
import { NO_REPEATED_OBSERVATION, PERSONAL_TEXT_MAX, REACTIONS, type GrowthView, type PersonalDelete,
  type PersonalMutation, type PersonalResult, type RepeatedObservation,
  type WeaknessObservation } from '../shared/personalization.js'
import type { FeedbackCard } from '../shared/feedback.js'
import { DEFAULT_REVIEW_DEPTH, type ReviewDepth } from '../shared/review.js'

export const GROWTH_PROMPT_VERSION = 'growth-summary.v1'
export interface PersonalizationDeps {
  documents: DocumentRepository; reviews: ReviewRepository; repo: PersonalizationRepository
  /** 깊이별 어댑터. 요약도 사용자가 고른 깊이로 쓴다 (PRD 4.6) */
  models: ReviewModelSet; online: OnlineStatus; now: () => string; newId: () => string
}
const failed = (message: string): {status:'failed';message:string} => ({status:'failed',message})
const ok = <T>(value: T): PersonalResult<T> => ({status:'ok',value})
function record(value: unknown): value is Record<string,unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, empty = false): value is string {
  return typeof value === 'string' && value.length <= PERSONAL_TEXT_MAX && (empty || value.trim().length > 0)
}
export function parsePersonalMutation(value: unknown): PersonalMutation | null {
  if (!record(value)) return null
  if (value['kind'] === 'observation') return text(value['id']) && text(value['note'],true)
    ? {kind:'observation',id:value['id'],note:value['note']} : null
  if (!text(value['documentId'])) return null
  const documentId = value['documentId']
  if (value['kind'] === 'reaction') {
    if (!text(value['feedbackId']) || !REACTIONS.includes(value['reaction'] as never) || !text(value['reason'],true)) return null
    if (value['reaction'] === 'rebuttal' && !text(value['reason'])) return null
    return {kind:'reaction',documentId,feedbackId:value['feedbackId'],reaction:value['reaction'] as 'agree',reason:value['reason']}
  }
  if (!text(value['text']) || (value['id'] !== undefined && !text(value['id']))) return null
  const id = value['id'] === undefined ? {} : {id:value['id']}
  if (value['kind'] === 'assessment' && (value['phase'] === 'before' || value['phase'] === 'after'))
    return {kind:'assessment',...id,documentId,phase:value['phase'],text:value['text']}
  if (value['kind'] === 'guideline' && ['document','subject','global'].includes(value['scope'] as string))
    return {kind:'guideline',...id,documentId,scope:value['scope'] as 'document',text:value['text']}
  return null
}
export function parsePersonalDelete(value: unknown): PersonalDelete | null {
  if (!record(value) || !text(value['id']) || !['reaction','assessment','guideline','observation','summary'].includes(value['kind'] as string)) return null
  return {kind:value['kind'] as PersonalDelete['kind'],id:value['id']}
}

export function createPersonalizationService(deps: PersonalizationDeps) {
  const {documents,reviews,repo,models,online,now,newId} = deps
  // 지문·저장 기록에는 요약을 실제로 쓴 어댑터의 이름이 남는다. 로직 분기에는 쓰지 않는다.
  const defaultModel = modelFor(models,DEFAULT_REVIEW_DEPTH)
  let generation = 0
  let summaryBusy = false
  let repeatedRevision=-1
  let repeatedGroups=new Map<string,RepeatedObservation>()

  function observations(): WeaknessObservation[] {
    const reactions = new Map(repo.reactions().map(r=>[r.feedbackId,r]))
    const annotations = new Map(repo.annotations().map(a=>[a.id,a]))
    const result: WeaknessObservation[] = []
    for (const doc of documents.listDocuments()) {
      const versions = documents.listVersions(doc.id)
      const latest = versions.at(-1)
      if (latest === undefined) continue
      const latestTexts = new Map(documents.listParagraphs(latest.id).map(p=>[p.uuid,p.paragraph.text]))
      const versionTexts = new Map<string,Map<string,string>>()
      for (const review of reviews.listReviews(doc.id)) {
        if (review.status !== 'succeeded') continue
        let texts = versionTexts.get(review.versionId)
        if (texts === undefined) {
          texts = new Map(documents.listParagraphs(review.versionId).map(p=>[p.uuid,p.paragraph.text]))
          versionTexts.set(review.versionId,texts)
        }
        for (const item of review.items) {
          const annotation = annotations.get(item.itemId)
          if (annotation?.excluded === 1) continue
          const before = texts.get(item.paragraphId) ?? ''
          const after = latestTexts.get(item.paragraphId) ?? null
          const reaction = reactions.get(item.itemId) ?? null
          result.push({id:item.itemId,documentId:doc.id,documentName:doc.displayName,
            versionId:review.versionId,versionOrdinal:versions.find(v=>v.id===review.versionId)!.ordinal,
            paragraphId:item.paragraphId,perspective:item.perspective,rubricItemIds:item.appliedRubricItemIds,
            problem:item.body,aiJudgment:item.rationale,reaction,note:annotation?.note ?? '',before,after,
            fresh:review.sentTargetParagraphIds===null || review.sentTargetParagraphIds===undefined
              ? review.attempts>0 : review.sentTargetParagraphIds.includes(item.paragraphId),
            afterVersionOrdinal:latest.ordinal,changed:after!==null && before!==after,
            improvement:improvement(before,after,reaction?.kind==='completed')})
        }
      }
    }
    return result
  }
  function local() {
    const rows = observations()
    const assessments = repo.assessments()
    // 프롬프트·모델이 바뀌면 저장된 요약을 그대로 쓰지 않는다 (`CLAUDE.md` §6).
    const fingerprint = sha256Hex(JSON.stringify([GROWTH_PROMPT_VERSION,defaultModel.modelId,rows,assessments]))
    const summary = repo.summary()
    return {observations:rows,groups:aggregateGrowth(rows),assessments,guidelines:repo.guidelines(),
      summary:summary?.fingerprint===fingerprint?summary:null,fingerprint}
  }
  function approvedGuidelines(documentId: string) {
    const doc = documents.getDocument(documentId)
    if (doc === null) return []
    return repo.guidelines().filter(g=>g.scope==='global' || (g.scope==='document' && g.documentId===documentId) ||
      (g.scope==='subject' && doc.subject!==null && g.subject===doc.subject))
  }
  function mutate(value: unknown, approved = false): PersonalResult<null> {
    const input = parsePersonalMutation(value)
    if (input === null) return failed('입력 내용이나 적용 범위를 확인해 주세요. 반박에는 사유가 필요합니다.')
    if (input.kind === 'observation') {
      if (!observations().some(o=>o.id===input.id)) return failed('관찰 기록을 찾지 못했습니다.')
      repo.transaction(()=>{ repo.annotate(input.id,input.note.trim()); repo.invalidateSummary() })
    } else {
      const doc = documents.getDocument(input.documentId)
      const latest = documents.latestVersion(input.documentId)
      if (doc === null || latest === null) return failed('먼저 보고서를 불러와 저장해 주세요.')
      if (input.kind === 'reaction') {
        if (!reviews.listReviews(doc.id).some(r=>r.status==='succeeded' && r.items.some(i=>i.itemId===input.feedbackId)))
          return failed('이 문서의 피드백을 찾지 못했습니다.')
        repo.transaction(()=>{ repo.saveReaction({feedbackId:input.feedbackId,documentId:doc.id,kind:input.reaction,
          reason:input.reason.trim(),updatedAt:now()}); repo.invalidateSummary() })
      } else if (input.kind === 'assessment') {
        const existing = repo.assessments().find(a=>a.id===input.id)
        if (input.id!==undefined && (existing===undefined || existing.documentId!==doc.id)) return failed('수정할 자기평가를 찾지 못했습니다.')
        repo.transaction(()=>{ repo.saveAssessment({id:existing?.id??newId(),documentId:doc.id,
          versionId:existing?.versionId??latest.id,versionOrdinal:existing?.versionOrdinal??latest.ordinal,
          phase:input.phase,text:input.text.trim(),updatedAt:now()}); repo.invalidateSummary() })
      } else {
        if (!approved) return failed('개인화 지침은 적용 내용과 범위를 확인하고 승인해야 저장됩니다.')
        if (input.scope==='subject' && !doc.subject) return failed('먼저 과목을 입력해 주세요.')
        const existing = repo.guidelines().find(g=>g.id===input.id)
        if (input.id!==undefined && existing===undefined) return failed('수정할 개인화 지침을 찾지 못했습니다.')
        repo.saveGuideline({id:existing?.id??newId(),text:input.text.trim(),scope:input.scope,
          documentId:input.scope==='document'?doc.id:null,subject:input.scope==='subject'?doc.subject:null,
          approvedAt:now(),revision:(existing?.revision??0)+1})
      }
    }
    generation += 1
    return ok(null)
  }
  function remove(value: unknown): PersonalResult<null> {
    const input = parsePersonalDelete(value)
    if (input===null) return failed('삭제할 기록을 확인해 주세요.')
    const exists = input.kind==='observation'?observations().some(o=>o.id===input.id):
      input.kind==='reaction'?repo.reactions().some(r=>r.feedbackId===input.id):
      input.kind==='assessment'?repo.assessments().some(r=>r.id===input.id):
      input.kind==='guideline'?repo.guidelines().some(r=>r.id===input.id):repo.summary()?.id===input.id
    if (!exists) return failed('기록이 없거나 이미 삭제되었습니다.')
    repo.transaction(()=>{
      if (input.kind==='observation') repo.annotate(input.id,'',true)
      else repo.remove(input.kind,input.id)
      repo.invalidateSummary()
    })
    generation += 1
    return ok(null)
  }
  async function availability(depth: ReviewDepth = DEFAULT_REVIEW_DEPTH) {
    const model = modelFor(models,depth)
    if (!online.isOnline()) return {available:false,message:'오프라인입니다. 기록과 개인화 관리는 계속 사용할 수 있습니다.'}
    if (model.summarizeGrowth===undefined) return {available:false,message:'이 깊이의 성장 요약 연결이 준비되지 않았습니다.'}
    return model.checkAvailability()
  }
  return {
    mutate,remove,approvedGuidelines,
    reactions(documentId: string) { return repo.reactions().filter(r=>r.documentId===documentId) },
    /** 취약점 후보에 붙는 반복 관찰 근거. 근거가 없으면 빈 목록을 준다 (T-8). */
    repeatedObservation(card: Pick<FeedbackCard, 'perspective' | 'appliedRubric'>): RepeatedObservation {
      const revision=repo.revision()
      if(revision!==repeatedRevision) {
        repeatedGroups=new Map(aggregateGrowth(observations()).map(g=>[g.key,{count:g.repeatCount,versions:g.versions}]))
        repeatedRevision=revision
      }
      return repeatedGroups.get(observationKey({perspective:card.perspective,
        rubricItemIds:card.appliedRubric.map(i=>i.itemId)})) ?? NO_REPEATED_OBSERVATION
    },
    async getView(): Promise<GrowthView> {
      const state = local()
      const available = await availability()
      const deep = await availability('deep')
      const hasRecords = state.observations.length>0
      return {...state,summaryAvailable:available.available && hasRecords,
        deepSummaryAvailable:deep.available && hasRecords,
        deepUnavailableMessage:hasRecords?(deep.available?'':deep.message):
          '저장된 피드백 관찰 기록이 있어야 요약할 수 있습니다.',
        unavailableMessage:hasRecords?(available.available?'':available.message):
          '저장된 피드백 관찰 기록이 있어야 요약할 수 있습니다.'}
    },
    /**
     * 집계를 바탕으로 짧은 성장 요약을 받는다 (PRD 4.6).
     * 깊이는 사용자가 고른다. 심층을 쓸 수 없으면 그 사실만 알리고 빠른 요약은 그대로 쓴다.
     */
    async summarize(depth: ReviewDepth = DEFAULT_REVIEW_DEPTH): Promise<PersonalResult<null>> {
      const model = modelFor(models,depth)
      if (summaryBusy) return failed('성장 요약을 생성 중입니다. 잠시 기다려 주세요.')
      summaryBusy=true
      try {
        const available = await availability(depth)
        if (!available.available) return failed(available.message)
        const state = local()
        if (state.observations.length===0) return failed('먼저 저장된 피드백 기록이 필요합니다.')
        const token = generation
        const {payload,aliases} = growthPayload(state.groups)
        for (let attempt=0;attempt<3;attempt+=1) {
          const call = await model.summarizeGrowth!(payload)
          if (token!==generation || local().fingerprint!==state.fingerprint)
            return failed('요약 중 기록이 바뀌었습니다. 최신 기록으로 다시 요청해 주세요.')
          if (!call.ok) { if(call.reason==='malformed') continue; return failed(call.message) }
          const sentences = validateGrowthSummary(call.text,aliases)
          if (sentences===null) continue
          repo.saveSummary({id:newId(),createdAt:now(),modelId:model.modelId,promptVersion:GROWTH_PROMPT_VERSION,
            fingerprint:state.fingerprint,sentences})
          return ok(null)
        }
        return failed('성장 요약의 형식·근거·표현을 확인하지 못해 저장하지 않았습니다. 다시 요청해 주세요.')
      } catch (cause) {
        console.error('성장 요약 실패',cause)
        return failed('성장 요약을 만들지 못했습니다. 기존 기록은 유지됩니다.')
      } finally { summaryBusy=false }
    },
  }
}
export type PersonalizationService = ReturnType<typeof createPersonalizationService>
