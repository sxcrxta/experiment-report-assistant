/**
 * 문단 추적 — 버전 사이에서 같은 문단을 이어 붙인다.
 *
 * PRD 4.5: "문단마다 고유 식별자를 부여해 버전 사이에서 추적하며, 문단이 나뉘거나 합쳐지면
 * 새 식별자를 만들고 이전 식별자와의 관계를 기록한다."
 * PRD 4.5(해싱·메모이제이션): "저장 시 문단별 해시를 비교해 바뀌지 않은 문단은 분석하지 않는다."
 *
 * CLAUDE.md §2: 여기에 AI 가 없다. 같은 입력에는 항상 같은 출력이 나온다.
 *
 * 판정 규칙 (전부 결정론)
 * - 해시가 같으면 같은 문단이다. 이전 uuid 를 그대로 물려받고 **분석 대상에서 빠진다.**
 * - 한 문단이 여러 문단으로 나뉘었는지(분할), 여러 문단이 하나로 합쳐졌는지(병합)는
 *   합친 텍스트의 유사도로 판정한다. 판정되면 **새 uuid** 를 만들고 관계를 남긴다.
 * - 그 밖의 변경 구간은 자리 순서대로 짝지어 '수정'으로 보고, 남는 쪽을 추가·삭제로 본다.
 *   자리 순서로 짝짓는 이유는 문단 uuid 에 붙은 피드백이 사소한 수정에도 끊기면 안 되기 때문이다.
 */
import { paragraphUuid } from '../document/hash.js'
import type { Paragraph } from '../document/model.js'

import { myersDiff } from './myers.js'

/**
 * 분할·병합으로 볼 최소 유사도.
 * 이 값 미만이면 "나뉜 문단"이 아니라 서로 다른 문단이 들어오고 나간 것으로 본다.
 * 상수를 여기 한 곳에만 두고 테스트로 고정한다.
 */
export const SPLIT_MERGE_SIMILARITY = 0.8

/** 새 버전에서 문단에 일어난 일. */
export type ParagraphChange =
  | 'unchanged'
  | 'modified'
  | 'added'
  /** 이전 문단 하나가 나뉘어 생긴 문단 */
  | 'split'
  /** 이전 문단 여럿이 합쳐져 생긴 문단 */
  | 'merged'

/** 이전 버전에서 넘어온 최소 정보. 저장소가 그대로 돌려줄 수 있는 모양이다. */
export interface PreviousParagraph {
  uuid: string
  hash: string
  /** 정규화된 텍스트. 분할·병합 판정에만 쓴다 */
  text: string
}

export interface TrackedParagraph {
  /** 이 버전에서 쓸 문단 uuid */
  uuid: string
  change: ParagraphChange
  /** 이어받은 이전 uuid (unchanged·modified 일 때만) */
  previousUuid: string | null
  paragraph: Paragraph
}

export interface RemovedParagraph {
  uuid: string
  text: string
}

export interface LineageRecord {
  childUuid: string
  parentUuid: string
  relation: 'split' | 'merge'
}

export interface TrackResult {
  /** 새 버전의 문단 전체. 문서 순서 */
  paragraphs: TrackedParagraph[]
  /** 사라진 문단 */
  removed: RemovedParagraph[]
  /** 분할·병합 관계 */
  lineage: LineageRecord[]
  /** 분석 대상 = 해시가 달라진 문단만. 메모이제이션의 1단계 */
  changed: TrackedParagraph[]
  /** 그대로인 문단 수 */
  unchangedCount: number
}

export interface TrackInput {
  previous: readonly PreviousParagraph[]
  current: readonly Paragraph[]
  /**
   * 새로 만드는 uuid 를 버전 안에서 유일하게 만드는 이름 공간.
   * 같은 위치·같은 내용이 다른 버전에서 되살아나도 서로 다른 문단으로 다루기 위해 넣는다.
   */
  versionKey: string
}

/**
 * 공백을 무시한 앞뒤 공통 부분의 비율.
 *
 * 분할·병합은 보통 "가운데를 끊거나 이어 붙인" 결과라서 앞뒤가 그대로 남는다.
 * 그 성질만 보므로 계산은 O(길이) 이고, 문단이 길어도 비용이 늘지 않는다.
 */
export function textSimilarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, '')
  const y = b.replace(/\s+/g, '')
  if (x === y) return 1
  if (x.length === 0 || y.length === 0) return 0

  const shorter = Math.min(x.length, y.length)
  let prefix = 0
  while (prefix < shorter && x[prefix] === y[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < shorter - prefix &&
    x[x.length - 1 - suffix] === y[y.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return (prefix + suffix) / Math.max(x.length, y.length)
}

/** 변경 구간 하나. Myers 결과에서 이어진 삭제·삽입 묶음이다. */
interface ChangeBlock {
  deletes: number[]
  inserts: number[]
}

function newUuid(paragraph: Paragraph, versionKey: string): string {
  return paragraphUuid({
    namespace: versionKey,
    sectionIndex: paragraph.sectionIndex,
    index: paragraph.index,
    text: paragraph.text,
    equations: paragraph.equations,
  })
}

export function trackParagraphs({ previous, current, versionKey }: TrackInput): TrackResult {
  const ops = myersDiff(
    previous.map((p) => p.hash),
    current.map((p) => p.hash),
  )

  const tracked = new Array<TrackedParagraph | undefined>(current.length).fill(undefined)
  const removed: RemovedParagraph[] = []
  const lineage: LineageRecord[] = []

  const blocks: ChangeBlock[] = []
  let block: ChangeBlock | null = null

  const flush = (): void => {
    if (block !== null) {
      blocks.push(block)
      block = null
    }
  }

  for (const op of ops) {
    if (op.kind === 'equal') {
      flush()
      const before = previous[op.oldIndex]
      const after = current[op.newIndex]
      if (before === undefined || after === undefined) {
        throw new Error('문단 추적 내부 오류: 편집 스크립트가 범위를 벗어났습니다')
      }
      tracked[op.newIndex] = {
        uuid: before.uuid,
        change: 'unchanged',
        previousUuid: before.uuid,
        paragraph: after,
      }
      continue
    }

    block ??= { deletes: [], inserts: [] }
    if (op.kind === 'delete') block.deletes.push(op.oldIndex)
    else block.inserts.push(op.newIndex)
  }
  flush()

  for (const changeBlock of blocks) {
    applyBlock(changeBlock, { previous, current, versionKey }, tracked, removed, lineage)
  }

  const paragraphs = tracked.map((entry, index) => {
    if (entry === undefined) {
      throw new Error(`문단 추적 내부 오류: ${index} 번 문단이 비었습니다`)
    }
    return entry
  })

  const changed = paragraphs.filter((entry) => entry.change !== 'unchanged')

  return {
    paragraphs,
    removed,
    lineage,
    changed,
    unchangedCount: paragraphs.length - changed.length,
  }
}

function applyBlock(
  block: ChangeBlock,
  input: TrackInput,
  tracked: (TrackedParagraph | undefined)[],
  removed: RemovedParagraph[],
  lineage: LineageRecord[],
): void {
  const olds: PreviousParagraph[] = block.deletes.map((index) => {
    const value = input.previous[index]
    if (value === undefined) throw new Error('문단 추적 내부 오류: 이전 문단이 없습니다')
    return value
  })
  const news: { newIndex: number; paragraph: Paragraph }[] = block.inserts.map((newIndex) => {
    const paragraph = input.current[newIndex]
    if (paragraph === undefined) throw new Error('문단 추적 내부 오류: 새 문단이 없습니다')
    return { newIndex, paragraph }
  })

  const onlyOld = olds.length === 1 ? olds[0] : undefined
  const onlyNew = news.length === 1 ? news[0] : undefined

  // 분할: 이전 문단 하나 -> 새 문단 여럿
  if (onlyOld !== undefined && news.length > 1) {
    const joined = news.map((entry) => entry.paragraph.text).join('')
    if (textSimilarity(onlyOld.text, joined) >= SPLIT_MERGE_SIMILARITY) {
      for (const { newIndex, paragraph } of news) {
        const uuid = newUuid(paragraph, input.versionKey)
        tracked[newIndex] = { uuid, change: 'split', previousUuid: null, paragraph }
        lineage.push({ childUuid: uuid, parentUuid: onlyOld.uuid, relation: 'split' })
      }
      return
    }
  }

  // 병합: 이전 문단 여럿 -> 새 문단 하나
  if (onlyNew !== undefined && olds.length > 1) {
    const joined = olds.map((old) => old.text).join('')
    if (textSimilarity(joined, onlyNew.paragraph.text) >= SPLIT_MERGE_SIMILARITY) {
      const uuid = newUuid(onlyNew.paragraph, input.versionKey)
      tracked[onlyNew.newIndex] = {
        uuid,
        change: 'merged',
        previousUuid: null,
        paragraph: onlyNew.paragraph,
      }
      for (const old of olds) {
        lineage.push({ childUuid: uuid, parentUuid: old.uuid, relation: 'merge' })
      }
      return
    }
  }

  // 그 밖에는 자리 순서로 짝짓는다. 짝이 있으면 수정, 남으면 추가·삭제.
  for (const [offset, { newIndex, paragraph }] of news.entries()) {
    const old = olds[offset]
    tracked[newIndex] =
      old === undefined
        ? {
            uuid: newUuid(paragraph, input.versionKey),
            change: 'added',
            previousUuid: null,
            paragraph,
          }
        : { uuid: old.uuid, change: 'modified', previousUuid: old.uuid, paragraph }
  }
  for (const old of olds.slice(news.length)) {
    removed.push({ uuid: old.uuid, text: old.text })
  }
}
