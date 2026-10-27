import { afterEach, describe, expect, it, vi } from 'vitest'
import { openGrowth } from '../src/renderer/src/views/growth.js'
import type { GrowthView } from '../src/shared/personalization.js'
import { documentStub, NodeStub } from './helpers/dom-stub.js'
import { aggregateGrowth, growthPayload, validateGrowthSummary } from '../src/core/personalization/growth.js'
import { improvement } from '../src/core/personalization/observation.js'
import type { WeaknessObservation } from '../src/shared/personalization.js'

function observation(id:string,versionId='v1'):WeaknessObservation {
  return {id,versionId,documentId:'d',documentName:'실제파일.hwpx',versionOrdinal:1,paragraphId:'p',perspective:'logic',
    rubricItemIds:['r1'],problem:'문제',aiJudgment:'AI 판단',reaction:null,note:'',fresh:true,before:'전',after:'후',
    afterVersionOrdinal:2,changed:true,improvement:'changed'}
}
describe('결정론 성장 집계',()=>{
  it('같은 버전의 단계·중복 요청·복수 문단은 반복 버전 수를 부풀리지 않는다',()=>{
    const rows=[observation('a'),observation('b'),{...observation('c'),paragraphId:'p2'},observation('d','v2')]
    expect(aggregateGrowth(rows)[0]).toMatchObject({repeatCount:2,changedCount:3,improvedCount:0,rebuttalCount:0})
  })
  it('다른 평가 지침은 별도 분류이며 입력을 변경하지 않는다',()=>{
    const rows=[observation('a'),{...observation('b'),rubricItemIds:['r2']}]
    const before=JSON.stringify(rows)
    expect(aggregateGrowth(rows)).toHaveLength(2)
    expect(JSON.stringify(rows)).toBe(before)
  })
  it('새 버전에 복사된 캐시 응답은 새 관찰로 세지 않는다',()=>{
    const groups=aggregateGrowth([observation('a'),{...observation('b','v2'),fresh:false}])
    expect(groups[0]!.repeatCount).toBe(1)
  })
  it('변경 없음·연결 유실은 수정 완료 표시만으로 개선을 확정하지 않는다',()=>{
    expect(improvement('전','전',true)).toBe('unconfirmed')
    expect(improvement('전',null,true)).toBe('unresolved')
    expect(improvement('전','후',true)).toBe('confirmed-change')
  })
  it('반복 관찰 근거는 관찰된 문서 버전 목록이며 반복 횟수와 항상 같다',()=>{
    const rows=[observation('a'),observation('b'),{...observation('c','v2'),versionOrdinal:2},
      {...observation('d','v3'),versionOrdinal:3,fresh:false},
      {...observation('e'),documentId:'other',documentName:'다른.hwpx',versionOrdinal:7}]
    const group=aggregateGrowth(rows)[0]!
    // 같은 버전의 중복 관찰은 한 번, 검토하지 않은(캐시 복제) 버전은 근거가 되지 않는다.
    expect(group.versions).toEqual([
      {documentId:'d',documentName:'실제파일.hwpx',versionOrdinal:1},
      {documentId:'d',documentName:'실제파일.hwpx',versionOrdinal:2},
      {documentId:'other',documentName:'다른.hwpx',versionOrdinal:7},
    ])
    expect(group.repeatCount).toBe(group.versions.length)
  })
  it('요약 페이로드에는 집계와 별칭만 있고 원문은 없다',()=>{
    const {payload,aliases}=growthPayload(aggregateGrowth([observation('private-feedback-id')]))
    expect(payload.groups[0]!.evidence).toEqual(['E1'])
    expect(aliases.get('E1')).toBe('private-feedback-id')
    expect(JSON.stringify(payload)).not.toContain('실제파일')
    expect(JSON.stringify(payload)).not.toContain('private-feedback-id')
    // 근거 문서 버전은 화면에만 쓴다. 외부로 나가지 않는다.
    expect(JSON.stringify(payload)).not.toContain('versions')
    expect(validateGrowthSummary('null',aliases)).toBeNull()
    expect(validateGrowthSummary('{"sentences":[null]}',aliases)).toBeNull()
  })
})

describe('개인화·성장 기록 화면',()=>{
  const version={documentId:'doc-1',documentName:'실험1.hwpx',versionOrdinal:2}
  function observation():WeaknessObservation {
    return {id:'item-1',documentId:'doc-1',documentName:'실험1.hwpx',versionId:'v2',versionOrdinal:2,
      paragraphId:'p1',perspective:'logic',rubricItemIds:['r1'],problem:'근거가 무엇인가요?',
      aiJudgment:'측정값이 드러나지 않습니다.',reaction:null,note:'',fresh:true,
      before:'전',after:'후',afterVersionOrdinal:3,changed:true,improvement:'changed'}
  }
  function view(overrides:Partial<GrowthView>={}):GrowthView {
    return {observations:[observation()],
      groups:[{key:'k',perspective:'logic',repeatCount:2,evidenceIds:['item-1'],versions:[version,
        {...version,versionOrdinal:3}],changedCount:1,improvedCount:0,rebuttalCount:0}],
      assessments:[],guidelines:[],summary:null,summaryAvailable:true,unavailableMessage:'',
      deepSummaryAvailable:false,deepUnavailableMessage:'Claude Code 를 찾지 못했습니다.',...overrides}
  }
  function open(value:GrowthView) {
    vi.stubGlobal('document',documentStub())
    const agent={getGrowth:vi.fn(()=>Promise.resolve({status:'ok',value})),
      savePersonalRecord:vi.fn(()=>Promise.resolve({status:'ok',value:null})),
      deletePersonalRecord:vi.fn(()=>Promise.resolve({status:'ok',value:null})),
      summarizeGrowth:vi.fn(()=>Promise.resolve({status:'ok',value:null}))}
    vi.stubGlobal('window',{agent})
    const root=new NodeStub('main')
    const documents=[{documentId:'doc-1',displayName:'실험1.hwpx',subject:'화학'}]
    return {root,agent,
      run:()=>openGrowth(root as unknown as HTMLElement,documents as never,'doc-1',vi.fn()),
      text:()=>root.all().map(n=>n.textContent).join('\n'),
      by:(label:string)=>root.all().find(n=>n.textContent===label)}
  }
  afterEach(()=>vi.unstubAllGlobals())

  it('관점별 집계에 근거 문서 버전을 함께 적는다 (T-8)',async()=>{
    const h=open(view());await h.run()
    expect(h.by('실험1.hwpx · 버전 2')).toBeDefined()
    expect(h.by('실험1.hwpx · 버전 3')).toBeDefined()
    expect(h.text()).toContain('반복 관찰 후보')
  })
  it('지침은 자동으로 생기지 않고 승인·수정·삭제를 화면에서 할 수 있다 (T-7)',async()=>{
    const h=open(view({guidelines:[{id:'g1',text:'근거를 먼저 질문해 주세요.',scope:'document',
      documentId:'doc-1',subject:null,approvedAt:'2026-09-12T00:00:00.000Z',revision:1}]}))
    await h.run()
    expect(h.text()).toContain('자동으로 지침을 만들지 않습니다')
    expect(h.by('내용·범위 확인 후 승인')).toBeDefined()
    expect(h.by('근거를 먼저 질문해 주세요.')).toBeDefined()
    expect(h.by('수정')).toBeDefined()
    const guidelineRow=h.root.all().find(n=>n.className==='growth-entry'
      && n.all().some(c=>c.textContent==='근거를 먼저 질문해 주세요.'))!
    guidelineRow.all().find(n=>n.textContent==='삭제')!.click()
    await vi.waitFor(()=>expect(h.agent.deletePersonalRecord).toHaveBeenCalledWith({kind:'guideline',id:'g1'}))
    expect(h.agent.savePersonalRecord).not.toHaveBeenCalled()
  })
  it('저장된 요약은 문장마다 근거 문서 버전을 달고 모델 원문을 그대로 쓰지 않는다',async()=>{
    const h=open(view({summary:{id:'s1',createdAt:'2026-09-12T00:00:00.000Z',modelId:'test/fake-model',
      promptVersion:'growth-summary.v1',fingerprint:'f',
      sentences:[{text:'같은 관점의 기록이 두 버전에 있습니다.',evidenceIds:['item-1']}]}}))
    await h.run()
    expect(h.by('같은 관점의 기록이 두 버전에 있습니다.')).toBeDefined()
    expect(h.by('실험1.hwpx · v2 → v3')).toBeDefined()
    // 능력 단정 검사는 저장 전에 끝난다 (validateGrowthSummary). 화면은 저장된 문장만 그대로 보여 준다.
    expect(h.text()).toContain('test/fake-model')
    expect(h.text()).not.toContain('E1')
  })
  it('요약을 만들 수 없으면 이유를 적고 버튼을 잠근다',async()=>{
    const h=open(view({summaryAvailable:false,unavailableMessage:'오프라인입니다.'}))
    await h.run()
    const button=h.by('요약 만들기')!
    expect(button.disabled).toBe(true)
    expect(h.text()).toContain('오프라인입니다.')
    button.click()
    expect(h.agent.summarizeGrowth).not.toHaveBeenCalled()
  })
})
