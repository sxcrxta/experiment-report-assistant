/**
 * 말로 하는 검토 요청 ([Q-44]). "고찰 부분 피드백해줘" 를 검토 범위로 바꾼다.
 *
 * **AI 를 쓰지 않는다.** 어느 문단이 대상인지는 프로그램이 정한다 (`CLAUDE.md` §2).
 * 부작용 없는 순수 함수이고, 같은 입력에 같은 결과를 낸다. 렌더러와 테스트가 함께 쓴다.
 *
 * 찾는 순서
 * 1. "전체" → 문서 전체, "바뀐/고친" → 최근 저장에서 바뀐 문단, "3번 문단" → 그 문단
 * 2. 보고서 항목(경계 편집에서 보이는 것) 이름과 맞으면 그 항목
 * 3. 목차(`shared/outline.ts` — AI 가 나눈 것, 없으면 번호 규칙)의 제목과 맞으면 그 항목.
 *    항목의 범위는 AI 가 아니라 `buildOutline` 이 정한다 ([Q-47]).
 *
 * 둘 이상이 똑같이 맞으면 임의로 고르지 않고 후보를 알려 준다.
 */
import type { ParagraphChoice, SectionBoundary } from './feedback.js'
import { buildOutline, flattenOutline, ruleHeadings, type OutlineNode, type OutlineView } from './outline.js'
import type { ReviewDepth, ReviewStage } from './review.js'

export type CommandTarget =
  | { kind: 'document' }
  | { kind: 'section'; ordinal: number }
  | { kind: 'paragraphs'; paragraphIds: string[] }

export type CommandResult =
  | {
      ok: true
      target: CommandTarget
      /** 사용자에게 보여 줄 대상 이름. 예: "7. 실험 결과 (문단 12개)" */
      label: string
      /** 말에 단계가 있으면 그 단계. 없으면 null (추천 단계를 쓴다) */
      stage: ReviewStage | null
      /** "꼼꼼하게" 같은 말이 있으면 deep. 없으면 null */
      depth: ReviewDepth | null
    }
  | { ok: false; message: string }

/** 대상이 아닌 말. 낱말 **끝**에서만 떼어 낸다 (가운데서 떼면 "프로판" 같은 낱말이 깨진다) */
const FILLER = [
  '피드백', '검토', '해주세요', '봐주세요', '해줘', '봐줘', '해봐', '주세요', '부탁', '줘', '좀', '한번', '다시',
  '부분', '파트', '항목', '내용', '쪽', '대해서', '대해', '대한', '관해', '관련', '확인',
  '꼼꼼하게', '꼼꼼히', '자세히', '심층', '빠르게', '간단히', '질문', '강한', '약한', '힌트', '설명',
].sort((a, b) => b.length - a.length)
const JOSA = /(에서|에게|에는|으로|이랑|하고|까지|부터|이나|은|는|이|가|을|를|의|에|도|만|랑|과|와)$/

/** 말에서 제목을 찾을 낱말을 뽑는다 */
export function commandWords(text: string): string[] {
  return text.split(/[\s.,·:;?!]+/).map((token) => {
    let word = token
    for (let round = 0; round < 6; round += 1) {
      const before = word
      // 두 글자 밑으로는 떼지 않는다. "결과" 의 "과" 는 조사가 아니다.
      const stripped = word.replace(JOSA, '')
      if (stripped.length >= 2) word = stripped
      const tail = FILLER.find((filler) => word.endsWith(filler) && word.length - filler.length >= 2)
      if (tail !== undefined) word = word.slice(0, -tail.length)
      if (word === before) break
    }
    return FILLER.includes(word) ? '' : word
  }).filter((word) => word.length >= 2)
}

/** 비교용으로 번호·띄어쓰기·문장부호를 걷는다 */
function core(text: string): string {
  return text.trim()
    .replace(/^(\d{1,2}\.|[IVX]{1,4}\.|[가-하]\.|\d{1,2}\)|\(\d{1,2}\))\s*/, '')
    .replace(/[\s.,·:;()[\]\-–—'"“”‘’?!]/g, '')
}


/**
 * 제목이 말의 낱말을 얼마나 덮는가. 제목 자체에 낱말이 하나도 없으면 0.
 * @param context 윗급 제목들. "실험 결과의 측정값" 처럼 윗제목으로 가려 말할 수 있게 한다
 * @returns covered 덮은 글자 수, complete 모든 낱말을 덮었는가
 */
function score(title: string, words: readonly string[], context = ''): { covered: number; complete: boolean } {
  const c = core(title)
  if (c.length < 2) return { covered: 0, complete: false }
  const own = words.filter((word) => c.includes(word))
  if (own.length === 0) return { covered: 0, complete: false }
  const hit = words.filter((word) => c.includes(word) || context.includes(word))
  return { covered: hit.reduce((sum, word) => sum + word.length, 0), complete: hit.length === words.length }
}

/** 말에 담긴 단계·깊이. 목차에서 고른 항목에 "힌트 줘" 를 덧붙일 때도 쓴다 */
export function readStageAndDepth(text: string): { stage: ReviewStage | null; depth: ReviewDepth | null } {
  return { stage: stageOf(text), depth: depthOf(text) }
}

/** 목차 항목 하나를 요청 대상으로. 제목 아래에 쓴 글이 없으면 null (선행 작성 보장) */
export function targetOfNode(node: OutlineNode, paragraphs: readonly ParagraphChoice[]):
  { target: CommandTarget; label: string } | null {
  const ids = new Set(node.paragraphIds)
  const written = paragraphs.filter((p) => ids.has(p.paragraphId) && p.hasContent).map((p) => p.paragraphId)
  if (written.length <= 1) return null
  return { target: { kind: 'paragraphs', paragraphIds: written }, label: `${node.title} (문단 ${written.length}개)` }
}

/** 화면에 쓸 목차. 받은 것이 없으면 번호 규칙으로 만든다 */
export function outlineOf(panel: { paragraphs: readonly ParagraphChoice[]; outline?: OutlineView | undefined }): OutlineNode[] {
  return panel.outline?.nodes ?? buildOutline(ruleHeadings(panel.paragraphs), panel.paragraphs)
}

function stageOf(text: string): ReviewStage | null {
  if (text.includes('강한 힌트') || text.includes('강한힌트')) return 'strong_hint'
  if (text.includes('힌트')) return 'weak_hint'
  if (text.includes('설명')) return 'explanation'
  if (text.includes('질문')) return 'question'
  return null
}

function depthOf(text: string): ReviewDepth | null {
  if (/꼼꼼|심층|자세히/.test(text)) return 'deep'
  if (/빠르게|간단히/.test(text)) return 'quick'
  return null
}

export function interpretReviewCommand(
  text: string,
  panel: { sections: readonly SectionBoundary[]; paragraphs: readonly ParagraphChoice[]; outline?: OutlineView | undefined },
): CommandResult {
  const said = text.trim()
  if (said === '') return { ok: false, message: '무엇을 볼지 적어 주세요. 예: 고찰 부분 피드백해줘' }
  if (said.includes('예시')) {
    return { ok: false, message: '짧은 수정 예시는 피드백 카드에서 직접 요청해 주세요.' }
  }
  const stage = stageOf(said)
  const depth = depthOf(said)
  const written = (ids: readonly ParagraphChoice[]): string[] =>
    ids.filter((p) => p.hasContent).map((p) => p.paragraphId)
  const done = (target: CommandTarget, label: string): CommandResult => ({ ok: true, target, label, stage, depth })

  if (/전체|전부|처음부터|다 봐|모두/.test(said)) return done({ kind: 'document' }, '문서 전체')

  if (/바뀐|변경|고친|수정한|새로 쓴/.test(said)) {
    const ids = written(panel.paragraphs.filter((p) => p.changed))
    if (ids.length === 0) return { ok: false, message: '최근 저장에서 바뀐 문단이 없습니다.' }
    return done({ kind: 'paragraphs', paragraphIds: ids }, `바뀐 문단 ${ids.length}개`)
  }

  const numbered = /(\d+)\s*번\s*(째\s*)?문단|문단\s*(\d+)/.exec(said)
  if (numbered !== null) {
    const number = Number(numbered[1] ?? numbered[3])
    const paragraph = panel.paragraphs.find((p) => p.number === number)
    if (paragraph === undefined) return { ok: false, message: `문단 ${number}이(가) 없습니다.` }
    if (!paragraph.hasContent) return { ok: false, message: `문단 ${number}은(는) 아직 비어 있습니다. 한글에서 먼저 써 주세요.` }
    return done({ kind: 'paragraphs', paragraphIds: [paragraph.paragraphId] }, `문단 ${number}`)
  }

  const words = commandWords(said)
  if (words.length === 0) {
    return { ok: false, message: '어느 부분인지 알아듣지 못했습니다. 예: 고찰 부분 피드백해줘, 3번 문단, 전체' }
  }

  type Candidate = {
    title: string; where: string; covered: number; complete: boolean; level: number; result: () => CommandResult
  }
  const candidates: Candidate[] = []

  // 보고서 항목. 통째 문서로 떨어진 추정("전체 문서")은 제목으로 치지 않는다.
  for (const section of panel.sections) {
    if (section.source === 'fallback') continue
    const s = score(section.title, words)
    if (s.covered === 0) continue
    const ids = written(panel.paragraphs.slice(section.startIndex, section.endIndex + 1))
    candidates.push({ title: section.title, where: section.title, ...s, level: 0, result: () => ids.length === 0
      ? { ok: false, message: `'${section.title}' 에는 아직 쓴 내용이 없습니다.` }
      : done({ kind: 'section', ordinal: section.ordinal }, `${section.title} (문단 ${ids.length}개)`) })
  }

  // 목차 항목 (AI 가 나눈 것, 없으면 번호 규칙). 윗항목 이름으로도 가려 말할 수 있다.
  const outline = outlineOf(panel)
  for (const { node, parents } of flattenOutline(outline)) {
    const s = score(node.title, words, parents.map(core).join(''))
    if (s.covered === 0) continue
    const picked = targetOfNode(node, panel.paragraphs)
    candidates.push({ title: node.title, where: [...parents, node.title].join(' > '), ...s, level: node.level,
      result: () => picked === null
        ? { ok: false, message: `'${node.title}' 아래에 아직 쓴 내용이 없습니다.` }
        : done(picked.target, picked.label) })
  }

  if (candidates.length === 0) {
    const titles = [
      ...panel.sections.filter((s) => s.source !== 'fallback').map((s) => s.title),
      ...outline.map((node) => node.title),
    ]
    return { ok: false, message: titles.length === 0
      ? `'${words.join(' ')}' 에 맞는 부분을 찾지 못했습니다.`
      : `'${words.join(' ')}' 에 맞는 부분을 찾지 못했습니다. 이런 이름이 있습니다: ${[...new Set(titles)].slice(0, 8).join(', ')}` }
  }

  // 말의 낱말을 모두 덮는 제목을 먼저, 그다음 많이 덮는 제목을, 같으면 큰 제목(항목 → 1급 → 2급…)을 고른다.
  // "고찰에서 오차 부분" 처럼 제목에 없는 낱말이 섞여도 가장 많이 덮는 제목으로 간다.
  candidates.sort((a, b) => Number(b.complete) - Number(a.complete) || b.covered - a.covered || a.level - b.level)
  const best = candidates[0]!
  const tied = candidates.filter((c) => c !== best && c.complete === best.complete
    && c.covered === best.covered && c.level === best.level)
  if (tied.length > 0) {
    return { ok: false, message: `어느 부분인지 정할 수 없습니다: ${[best, ...tied].map((c) => c.where).join(' / ')}. `
      + '윗제목을 함께 적어 주세요. 예: 실험 결과의 측정값' }
  }
  return best.result()
}
