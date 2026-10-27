/**
 * 지침 초안 제안에 쓰는 **문서 뼈대** 추출 (PRD 4.1).
 *
 * PRD 4.1: "프로그램은 제목·목차·표·안내 문구 등을 읽어 지침 초안을 제안할 수 있으나,
 * 이는 보조 기능이다."
 *
 * 여기서 뽑는 것이 곧 **외부로 나가는 전부**다 (`CLAUDE.md` §4).
 * 보고서 본문은 보내지 않는다. 사용자가 쓴 답을 모델에 넘겨 지침을 짓게 하면
 * 보고서 내용이 그대로 평가 기준이 되어 버리고, 최소 전송 원칙도 깨진다.
 *
 * 뽑는 것
 * - **제목** — `role === 'heading'` 인 문단. 개요 수준을 함께 남긴다
 * - **캡션** — 표·그림 설명 (`role === 'caption'`)
 * - **안내 문구** — 빈칸을 채우라는 양식 문구. 아래 ANNOTATION 규칙에 걸리는 짧은 문단만
 * - **표·수식 수** — 몇 개 있는지만. 표 안의 값은 보내지 않는다
 *
 * 부작용 없는 순수 함수다 (`CLAUDE.md` §2).
 */
import type { Paragraph } from '../document/model.js'

/** 뼈대에 실을 줄 하나. */
export interface OutlineEntry {
  kind: 'heading' | 'caption' | 'guide'
  /** 제목이면 개요 수준(1~10), 아니면 null */
  level: number | null
  text: string
}

export interface DocumentOutline {
  entries: OutlineEntry[]
  /** 문서 안의 표 개수 */
  tableCount: number
  /** 수식이 들어 있는 문단 수 */
  equationCount: number
  /** 본문 문단 수. 분량 감각만 넘기고 내용은 넘기지 않는다 */
  bodyParagraphCount: number
}

/** 뼈대 줄 하나의 길이 상한. 넘으면 본문일 가능성이 크므로 자르지 않고 **버린다**. */
export const OUTLINE_TEXT_MAX = 120

/** 뼈대에 실을 최대 줄 수. 아주 긴 문서에서도 보내는 양을 묶어 둔다. */
export const OUTLINE_MAX_ENTRIES = 60

/**
 * 채워 넣으라고 지시하는 양식 문구.
 *
 * 한국어 보고서 양식이 쓰는 명령형 어미만 좁게 본다. 넓게 잡으면 사용자가 쓴 본문이
 * 안내 문구로 오인되어 밖으로 나간다. **판단이 서지 않으면 보내지 않는 쪽으로 기운다.**
 */
const GUIDE_PATTERN =
  /(하시오|하세요|쓰시오|쓰세요|적으시오|적으세요|작성하시오|작성하세요|기입하시오|기입하세요|서술하시오|서술하세요|기술하시오|기술하세요)\s*[.]?$/

/** 안내 문구로 볼 만큼 짧은가. 긴 문단은 사용자가 쓴 본문으로 본다. */
const GUIDE_TEXT_MAX = 60

function entryOf(paragraph: Paragraph): OutlineEntry | null {
  const text = paragraph.text.trim()
  if (text === '' || text.length > OUTLINE_TEXT_MAX) return null

  if (paragraph.role === 'heading') {
    return { kind: 'heading', level: paragraph.headingLevel, text }
  }
  if (paragraph.role === 'caption') {
    return { kind: 'caption', level: null, text }
  }
  // 표 안의 글은 값이다. 안내 문구로 보지 않는다.
  if (paragraph.table === null && text.length <= GUIDE_TEXT_MAX && GUIDE_PATTERN.test(text)) {
    return { kind: 'guide', level: null, text }
  }
  return null
}

/**
 * 문단 목록에서 뼈대를 뽑는다.
 *
 * 같은 문서를 다시 읽으면 같은 결과가 나온다. 문서 순서를 그대로 지킨다.
 */
export function documentOutline(paragraphs: readonly Paragraph[]): DocumentOutline {
  const entries: OutlineEntry[] = []
  const tables = new Set<number>()
  let equationCount = 0
  let bodyParagraphCount = 0

  for (const paragraph of paragraphs) {
    if (paragraph.table !== null) tables.add(paragraph.table.tableIndex)
    if (paragraph.equations.length > 0) equationCount += 1
    if (paragraph.role === 'body' && paragraph.table === null && paragraph.text.trim() !== '') {
      bodyParagraphCount += 1
    }

    if (entries.length >= OUTLINE_MAX_ENTRIES) continue
    const entry = entryOf(paragraph)
    if (entry !== null) entries.push(entry)
  }

  return { entries, tableCount: tables.size, equationCount, bodyParagraphCount }
}

/** 모델에 물어볼 만한 뼈대인가. 제목도 캡션도 안내도 없으면 물어볼 근거가 없다. */
export function hasOutlineEvidence(outline: DocumentOutline): boolean {
  return outline.entries.length > 0
}
