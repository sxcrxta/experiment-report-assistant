import { parsePersonalDelete, parsePersonalMutation, type PersonalizationService } from '../app/personalization.js'
import type { DocumentRepository } from '../adapters/repo/documents.js'
import type { PersonalizationRepository } from '../adapters/repo/personalization.js'

export function createPersonalizationHandlers(deps: {
  service: PersonalizationService; documents: DocumentRepository; repo: PersonalizationRepository
  confirm: (title: string, detail: string) => Promise<boolean>
}) {
  const {service,documents,repo,confirm} = deps
  return {
    async getGrowth() { return {status:'ok' as const,value:await service.getView()} },
    getPersonalRecords(documentId: unknown) {
      if (typeof documentId!=='string' || documents.getDocument(documentId)===null)
        return {status:'failed' as const,message:'보고서를 선택해 주세요.'}
      return {status:'ok' as const,value:{reactions:service.reactions(documentId),
        assessments:repo.assessments().filter(a=>a.documentId===documentId)}}
    },
    async savePersonalRecord(value: unknown) {
      const input = parsePersonalMutation(value)
      if (input===null) return {status:'failed' as const,message:'입력 내용과 반박 사유를 확인해 주세요.'}
      if (input.kind!=='guideline') return service.mutate(input)
      const doc = documents.getDocument(input.documentId)
      if (doc===null) return {status:'failed' as const,message:'보고서를 선택해 주세요.'}
      const revision = input.id===undefined?null:repo.guidelines().find(g=>g.id===input.id)?.revision
      const scope = input.scope==='global'?'전체 보고서':input.scope==='subject'?`과목: ${doc.subject??'미입력'}`:`이번 문서: ${doc.displayName}`
      if (!await confirm('개인화 지침 승인',`적용 범위: ${scope}\n\n${input.text}\n\n승인하면 이후 AI 검토에 적용됩니다.`))
        return {status:'canceled' as const}
      if (input.scope==='subject' && documents.getDocument(doc.id)?.subject!==doc.subject)
        return {status:'failed' as const,message:'승인 중 과목이 바뀌었습니다. 적용 범위를 다시 확인해 주세요.'}
      if (input.id!==undefined && repo.guidelines().find(g=>g.id===input.id)?.revision!==revision)
        return {status:'failed' as const,message:'승인 중 지침이 바뀌었습니다. 최신 내용을 다시 확인해 주세요.'}
      return service.mutate(input,true)
    },
    async deletePersonalRecord(value: unknown) {
      const input = parsePersonalDelete(value)
      if (input===null) return {status:'failed' as const,message:'삭제할 기록을 확인해 주세요.'}
      if (!await confirm('기록 삭제',input.kind==='observation'
        ? '이 관찰을 성장 집계에서 제외하고 메모를 삭제할까요? 원본 피드백과 HWPX는 유지됩니다. 관련 성장 요약도 삭제됩니다.'
        : '이 기록을 삭제할까요? 관련 성장 요약도 삭제됩니다. 이 작업은 되돌릴 수 없습니다.'))
        return {status:'canceled' as const}
      return service.remove(input)
    },
    /** 깊이는 사용자가 고른다. 모르는 값이면 빠른 요약이다 (PRD 4.6). */
    summarizeGrowth:(value: unknown)=>service.summarize(value==='deep'?'deep':'quick'),
  }
}
export type PersonalizationHandlers = ReturnType<typeof createPersonalizationHandlers>
