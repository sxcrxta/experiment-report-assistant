import type { GrowthGroup, GrowthPayload, GrowthSentence, ObservedVersion,
  WeaknessObservation } from '../../shared/personalization.js'
import { observationKey } from './observation.js'

/**
 * 반복 관찰의 근거가 된 문서 버전. 실제로 모델이 검토한(`fresh`) 관찰만 센다.
 * 같은 버전을 여러 번 요청하거나 캐시를 복제해도 한 번이다.
 */
export function observedVersions(rows: readonly WeaknessObservation[]): ObservedVersion[] {
  const seen = new Map<string, ObservedVersion>()
  for (const o of rows) {
    if (!o.fresh) continue
    const key = JSON.stringify([o.documentId, o.versionId])
    if (!seen.has(key)) seen.set(key, {documentId:o.documentId,documentName:o.documentName,versionOrdinal:o.versionOrdinal})
  }
  return [...seen.values()].sort((a,b) => a.documentId.localeCompare(b.documentId) || a.versionOrdinal-b.versionOrdinal)
}

/** 반복 검토/힌트 단계를 횟수로 부풀리지 않는다. 같은 분류·문서 버전은 최대 1회다. */
export function aggregateGrowth(observations: readonly WeaknessObservation[]): GrowthGroup[] {
  const groups = new Map<string, WeaknessObservation[]>()
  for (const o of observations) {
    const key = observationKey(o)
    const group = groups.get(key) ?? []; group.push(o); groups.set(key, group)
  }
  return [...groups].map(([key, rows]) => {
    const versions = observedVersions(rows)
    return { key, perspective: rows[0]!.perspective,
    repeatCount: versions.length, versions,
    evidenceIds: rows.map(o => o.id),
    changedCount: new Set(rows.filter(o => o.changed).map(o => JSON.stringify([o.documentId,o.versionId,o.paragraphId]))).size,
    improvedCount: new Set(rows.filter(o => o.improvement === 'confirmed-change').map(o => JSON.stringify([o.documentId,o.versionId,o.paragraphId]))).size,
    rebuttalCount: new Set(rows.filter(o => o.reaction?.kind === 'rebuttal').map(o => JSON.stringify([o.documentId,o.versionId,o.paragraphId]))).size,
    }
  }).sort((a,b) => b.repeatCount-a.repeatCount || a.key.localeCompare(b.key))
}

export function growthPayload(groups: GrowthGroup[]): { payload: GrowthPayload; aliases: Map<string, string> } {
  const aliases = new Map<string, string>()
  // 요약은 상위 10개 분류, 분류별 최대 3개 근거만. 전체 기록은 로컬에서 계속 볼 수 있다.
  const payload: GrowthPayload = { groups: groups.slice(0,10).map(g => ({
    perspective:g.perspective, repeatCount:g.repeatCount, changedCount:g.changedCount,
    improvedCount:g.improvedCount, rebuttalCount:g.rebuttalCount,
    evidence:g.evidenceIds.slice(0,3).map(id => {
      const alias = `E${aliases.size+1}`; aliases.set(alias,id); return alias
    }),
  })) }
  return {payload,aliases}
}

/** 모델 원문은 표시하지 않는다. 형식/근거/능력 단정 검사를 통과한 짧은 문장만 허용한다. */
export function validateGrowthSummary(text: string, aliases: Map<string,string>): GrowthSentence[] | null {
  try {
    const data = JSON.parse(text) as { sentences?: unknown }
    if (!Array.isArray(data.sentences) || data.sentences.length < 1 || data.sentences.length > 3) return null
    const result: GrowthSentence[] = []
    for (const row of data.sentences as { text?: unknown; evidence?: unknown }[]) {
      if (row === null || typeof row.text !== 'string' || row.text.trim().length < 1 || row.text.length > 300 ||
        !Array.isArray(row.evidence) || row.evidence.length < 1 || row.evidence.length > 5 ||
        row.evidence.some(id => typeof id !== 'string' || !aliases.has(id))) return null
      if (/(능력|재능|지능|성격|소질|실력|이해력|논리력|역량|우수|열등|뛰어나|잘한다|못한다|형편없|게으르|산만|부족한\s*사람|당신|학습자|학생|사용자[은는이가]|취약점|weakness|intelligen|talent|ability|you are)/i.test(row.text)) return null
      result.push({text:row.text.trim(),evidenceIds:row.evidence.map(id=>aliases.get(id as string)!)})
    }
    return result
  } catch { return null }
}
