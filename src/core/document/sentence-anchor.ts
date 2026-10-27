/**
 * 문장 앵커 — 문단 UUID + 문장 + 문단 안 위치 + 문장 해시 (IMPLEMENTATION_PLAN.md §2.3, [Q-17]).
 *
 * PRD 4.2: "문장 단위 피드백은 문단과 문장 위치로 연결하며, 수정 후 그 문장을 다시 찾지 못하면
 *          임의로 다른 문장에 연결하지 않고 사용자에게 확인을 요청한다."
 *
 * 그래서 이 모듈이 하는 판정은 둘뿐이다.
 * - **찾았다**: 문장 해시가 같은 문장이 그 문단에 **딱 하나** 있다. 위치가 달라졌어도 같은 문장이다.
 * - **찾지 못했다**: 문단이 사라졌거나, 같은 문장이 없거나, 같은 문장이 **여럿**이라 어느 것인지 정할 수 없다.
 *
 * 세 번째 선택지("비슷한 문장에 붙인다")를 두지 않는다. 못 찾으면 못 찾았다고 남기고 사용자에게 묻는다.
 * 다시 연결하는 일은 사용자가 문장을 직접 고를 때만 일어난다 (`app/review-stage.ts`).
 *
 * 여기에는 I/O 도 난수도 없다. 같은 입력이면 항상 같은 결과가 나온다.
 */
import type { Sentence } from '../../shared/feedback.js'

import { normalizeText } from './normalize.js'
import { sha256Hex } from './sha256.js'

export type { Sentence }

/** 문장을 끝낼 수 있는 부호. */
const TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？'])

/** 종결 부호 뒤에 붙어도 문장이 끝난 것으로 보는 닫는 부호. */
const TRAILING = new Set(['"', "'", '”', '’', ')', ']', '}', '』', '」', '》', '›', '.', '!', '?', '…'])

/**
 * `text[at]` 이 문장의 끝이면 다음 문장이 시작할 위치를, 아니면 null.
 * 문단 텍스트는 정규화되어 있으므로 공백은 보통 공백 하나뿐이다 (`normalize.ts`).
 */
function boundaryEnd(text: string, at: number): number | null {
  if (!TERMINATORS.has(text.charAt(at))) return null

  let end = at + 1
  while (end < text.length && TRAILING.has(text.charAt(end))) end += 1
  // 뒤에 공백이 없으면 문장 끝이 아니다. 소수점(0.5)이나 약어가 여기서 걸러진다.
  if (end < text.length && text.charAt(end) !== ' ') return null
  return end
}

/**
 * 문단 텍스트를 문장으로 자른다.
 *
 * - 종결 부호(. ! ? … 。 ！ ？) 뒤에 공백이나 문단 끝이 와야 문장이 끝난다.
 * - "1. 실험 방법" 처럼 번호만 있는 조각은 문장으로 끊지 않는다.
 * - 빈 조각은 문장으로 세지 않는다.
 *
 * @param text 정규화된 문단 텍스트 (`Paragraph.text`)
 */
export function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = []
  let start = 0

  function push(raw: string, from: number): void {
    const trimmed = raw.trim()
    if (trimmed === '') return
    sentences.push({
      index: sentences.length,
      text: trimmed,
      offset: from + (raw.length - raw.trimStart().length),
    })
  }

  for (let i = 0; i < text.length; i += 1) {
    const end = boundaryEnd(text, i)
    if (end === null) continue
    // 항목 번호("3.")는 문장의 끝이 아니라 제목의 머리다.
    if (/^\s*\d+\s*$/.test(text.slice(start, i))) continue

    push(text.slice(start, end), start)
    start = end
    i = end - 1
  }
  push(text.slice(start), start)

  return sentences
}

/** 문장 해시. 같은 문장인지 보는 기준이며, 앵커를 다시 찾을 때도 이 값만 쓴다. */
export function sentenceHash(text: string): string {
  return sha256Hex(normalizeText(text))
}

/** 피드백이 가리키는 문장. 저장소에는 이 네 값이 그대로 남는다. */
export interface SentenceAnchor {
  paragraphUuid: string
  /** 앵커를 만들 때의 문장 번호 (0부터) */
  sentenceIndex: number
  /** 앵커를 만들 때의 문장 */
  text: string
  /** 앵커를 만들 때의 문단 안 위치 */
  offset: number
  /** 문장 해시 */
  hash: string
}

export interface CreateAnchorInput {
  paragraphUuid: string
  /** 정규화된 문단 텍스트 */
  paragraphText: string
  sentenceIndex: number
}

/** 사용자가 고른 문장으로 앵커를 만든다. 그런 문장이 없으면 만들지 않는다. */
export function createSentenceAnchor(input: CreateAnchorInput): SentenceAnchor | null {
  const sentence = splitSentences(input.paragraphText)[input.sentenceIndex]
  if (sentence === undefined) return null
  return {
    paragraphUuid: input.paragraphUuid,
    sentenceIndex: sentence.index,
    text: sentence.text,
    offset: sentence.offset,
    hash: sentenceHash(sentence.text),
  }
}

/** 앵커를 다시 찾지 못한 이유. 사용자에게 무엇이 일어났는지 그대로 알린다. */
export type AnchorMissReason =
  /** 그 문단 자체가 지금 버전에 없다 */
  | 'paragraph-missing'
  /** 문단은 있지만 같은 문장이 없다 */
  | 'sentence-missing'
  /** 같은 문장이 여럿이라 어느 것인지 정할 수 없다 */
  | 'ambiguous'

export type AnchorResolution =
  | {
      status: 'found'
      sentenceIndex: number
      offset: number
      text: string
      /** 문단 안에서 위치가 달라졌는가. 같은 문장이므로 연결은 유지된다 */
      moved: boolean
    }
  | { status: 'not-found'; reason: AnchorMissReason }

/**
 * 앵커가 가리키던 문장을 지금 문단에서 다시 찾는다.
 *
 * @param paragraph 지금 버전의 같은 uuid 문단. 문단이 사라졌으면 null
 */
export function resolveSentenceAnchor(
  anchor: SentenceAnchor,
  paragraph: { uuid: string; text: string } | null,
): AnchorResolution {
  if (paragraph === null || paragraph.uuid !== anchor.paragraphUuid) {
    return { status: 'not-found', reason: 'paragraph-missing' }
  }

  const sentences = splitSentences(paragraph.text)
  const matches = sentences.filter((sentence) => sentenceHash(sentence.text) === anchor.hash)
  if (matches.length === 0) return { status: 'not-found', reason: 'sentence-missing' }

  const atSameIndex = matches.find((sentence) => sentence.index === anchor.sentenceIndex)
  if (atSameIndex !== undefined) {
    return {
      status: 'found',
      sentenceIndex: atSameIndex.index,
      offset: atSameIndex.offset,
      text: atSameIndex.text,
      moved: atSameIndex.offset !== anchor.offset,
    }
  }

  // 같은 문장이 여럿이면 어느 것을 가리켰는지 프로그램이 정하지 않는다 (PRD 4.2).
  if (matches.length > 1) return { status: 'not-found', reason: 'ambiguous' }

  const moved = matches[0]
  if (moved === undefined) return { status: 'not-found', reason: 'sentence-missing' }
  return {
    status: 'found',
    sentenceIndex: moved.index,
    offset: moved.offset,
    text: moved.text,
    moved: true,
  }
}
