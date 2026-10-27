/**
 * 평가 지침 모델.
 *
 * PRD 4.1: "평가 지침은 문서의 상태와 무관하게 항상 사용자가 검토 초기에 입력하고 확정한다."
 *          "모든 지침은 AI 적용 전에 사용자가 확인·수정하며 언제든 변경할 수 있다."
 * `CLAUDE.md` §1: 확정 전 초안은 어떤 AI 호출에도 쓰지 않는다.
 *
 * 그래서 초안(`RubricDraft`)과 확정 지침(`ConfirmedRubric`)을 **서로 다른 타입**으로 둔다.
 * - 타입: `ConfirmedRubric` 에는 이 모듈 밖에서 붙일 수 없는 표식이 있다. 초안이나 손으로 만든 객체를
 *   확정 지침 자리에 넣으면 컴파일이 실패한다. 확정 지침은 `confirmRubric`(사용자가 확정할 때)과
 *   `restoreConfirmedRubric`(저장소에서 다시 읽을 때)로만 생긴다.
 * - 런타임: `assertConfirmedRubric` 가 상태를 보고 해시를 다시 계산한다. 타입을 속였거나
 *   확정한 뒤 내용이 바뀐 객체는 여기서 걸린다. 확정 지침은 얼려 두므로 확정 뒤에 고칠 수도 없다.
 *
 * 문서 상태(양식이 있는 문서 / 빈 문서)에 따라 갈라지는 경로는 없다 ([Q-3]).
 */
import {
  RUBRIC_IMPORTANCE_LEVELS,
  RUBRIC_ITEM_DESCRIPTION_MAX_LENGTH,
  RUBRIC_ITEM_TITLE_MAX_LENGTH,
  RUBRIC_MAX_ITEMS,
  type RubricImportance,
  type RubricItemInput,
} from '../../shared/rubric.js'
import { normalizeText } from '../document/normalize.js'

import { computeRubricVersion, rubricContentHash } from './version.js'

export interface RubricItemContent {
  /** 항목 이름 (예: "결과와 고찰의 연결") */
  title: string
  /** 이 항목에서 무엇을 보는지. 비워 둘 수 있다 */
  description: string
  /** 6단계 우선순위 점수의 "평가 기준 중요도" 입력값 */
  importance: RubricImportance
}

export interface RubricItem extends RubricItemContent {
  /** 항목 식별자. 이름이나 설명을 고쳐도 유지된다. 피드백의 "적용 지침"이 이 값을 가리킨다 */
  itemId: string
}

export type { RubricItemInput }

/** 확정 전 초안. **어떤 AI 요청에도 싣지 않는다.** */
export interface RubricDraft {
  readonly status: 'draft'
  readonly documentId: string
  readonly items: readonly RubricItem[]
  readonly updatedAt: string
}

/** 이 모듈의 생성 함수만 붙이는 표식. 타입에만 있고 실제 값은 없다. */
declare const CONFIRMED: unique symbol

/** 사용자가 확정한 지침. 한 번 만들어지면 바뀌지 않는다. 지침을 바꾸면 새 버전이 생긴다. */
export interface ConfirmedRubric {
  readonly [CONFIRMED]: true
  readonly status: 'confirmed'
  readonly documentId: string
  /** 그 문서에서 몇 번째로 확정한 지침인가 (1부터). 화면에는 "버전 N" 으로 보인다 */
  readonly ordinal: number
  /** 캐시 키에 들어가는 지침 버전 (`version.ts`) */
  readonly rubricVersion: string
  readonly contentHash: string
  readonly items: readonly Readonly<RubricItem>[]
  readonly confirmedAt: string
}

/** 저장소에 남은 확정 지침. 다시 읽을 때 `restoreConfirmedRubric` 가 검증한다. */
export interface StoredConfirmedRubric {
  documentId: string
  ordinal: number
  rubricVersion: string
  contentHash: string
  items: readonly RubricItem[]
  confirmedAt: string
}

/** 저장된 확정 지침이 확정할 때의 내용과 다르다. */
export class RubricIntegrityError extends Error {
  override name = 'RubricIntegrityError'
}

/** 확정 지침이 아닌 것을 확정 지침 자리에 넣었다. */
export class UnconfirmedRubricError extends Error {
  override name = 'UnconfirmedRubricError'
}

// ---------------------------------------------------------------------------
// 정규화와 검증
// ---------------------------------------------------------------------------

/** 항목 이름은 한 줄이다. 문단 텍스트와 같은 규칙으로 정규화한다. */
function normalizeTitle(title: string): string {
  return normalizeText(title)
}

/** 설명은 여러 줄일 수 있다. 줄바꿈은 살리고 줄 끝 공백과 앞뒤 빈 줄만 걷어 낸다. */
function normalizeDescription(description: string): string {
  return description
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

export function isRubricImportance(value: unknown): value is RubricImportance {
  return typeof value === 'number' && (RUBRIC_IMPORTANCE_LEVELS as readonly number[]).includes(value)
}

function labelOf(index: number): string {
  return `${index + 1}번 항목`
}

/** 초안이든 확정 지침이든 항목이 지켜야 하는 형태. */
function itemProblems(items: readonly RubricItem[]): string[] {
  const problems: string[] = []
  if (items.length > RUBRIC_MAX_ITEMS) {
    problems.push(`지침 항목은 ${RUBRIC_MAX_ITEMS}개까지 둘 수 있습니다.`)
  }

  const seenIds = new Set<string>()
  items.forEach((item, index) => {
    const label = labelOf(index)
    if (item.itemId === '' || seenIds.has(item.itemId)) {
      problems.push(`${label}: 항목 식별자가 비었거나 겹칩니다.`)
    }
    seenIds.add(item.itemId)

    if (item.title !== normalizeTitle(item.title)) {
      problems.push(`${label}: 이름이 정규화되지 않았습니다.`)
    }
    if (item.description !== normalizeDescription(item.description)) {
      problems.push(`${label}: 설명이 정규화되지 않았습니다.`)
    }
    if (item.title.length > RUBRIC_ITEM_TITLE_MAX_LENGTH) {
      problems.push(`${label}: 이름은 ${RUBRIC_ITEM_TITLE_MAX_LENGTH}자까지 쓸 수 있습니다.`)
    }
    if (item.description.length > RUBRIC_ITEM_DESCRIPTION_MAX_LENGTH) {
      problems.push(`${label}: 설명은 ${RUBRIC_ITEM_DESCRIPTION_MAX_LENGTH}자까지 쓸 수 있습니다.`)
    }
    if (!isRubricImportance(item.importance)) {
      problems.push(
        `${label}: 중요도는 ${RUBRIC_IMPORTANCE_LEVELS[0]}~` +
          `${RUBRIC_IMPORTANCE_LEVELS[RUBRIC_IMPORTANCE_LEVELS.length - 1]} 중에서 골라 주세요.`,
      )
    }
  })
  return problems
}

/**
 * 확정하려면 더 지켜야 하는 것.
 * 초안은 쓰는 중이라 이름이 비어 있어도 저장할 수 있지만, 확정한 지침은 AI 에 전달되므로 비어 있으면 안 된다.
 */
export function confirmationProblems(items: readonly RubricItem[]): string[] {
  if (items.length === 0) return ['지침 항목을 하나 이상 입력해 주세요.']

  const problems: string[] = []
  const seenTitles = new Map<string, number>()
  items.forEach((item, index) => {
    const label = labelOf(index)
    if (item.title === '') {
      problems.push(`${label}: 이름을 적어 주세요.`)
      return
    }
    const earlier = seenTitles.get(item.title)
    if (earlier !== undefined) {
      problems.push(`${label}: ${labelOf(earlier)}과 이름이 같습니다. 항목 이름은 서로 달라야 합니다.`)
      return
    }
    seenTitles.set(item.title, index)
  })
  return problems
}

export type PrepareResult = { ok: true; items: RubricItem[] } | { ok: false; problems: string[] }

/**
 * 편집기 입력을 정규화해 초안 항목으로 만든다.
 *
 * - 이름과 설명이 모두 빈 줄은 내용이 없으므로 항목으로 만들지 않는다
 *   (편집기에서 "항목 추가"만 누르고 비워 둔 줄).
 * - 식별자가 없는 새 항목에는 `newId` 로 식별자를 준다. 코어는 난수를 만들지 않는다.
 * - 초안으로 저장할 수 있는지만 본다. 확정할 수 있는지는 `confirmRubric` 이 본다.
 */
export function prepareRubricItems(
  inputs: readonly RubricItemInput[],
  newId: () => string,
): PrepareResult {
  const items: RubricItem[] = []
  for (const input of inputs) {
    const title = normalizeTitle(input.title)
    const description = normalizeDescription(input.description)
    if (title === '' && description === '') continue

    const itemId = input.itemId === null || input.itemId.trim() === '' ? newId() : input.itemId
    items.push({ itemId, title, description, importance: input.importance as RubricImportance })
  }

  const problems = itemProblems(items)
  return problems.length > 0 ? { ok: false, problems } : { ok: true, items }
}

/** 두 항목 목록의 내용(식별자·이름·설명·중요도·순서)이 같은가. */
export function sameRubricContent(a: readonly RubricItem[], b: readonly RubricItem[]): boolean {
  return rubricContentHash(a) === rubricContentHash(b)
}

// ---------------------------------------------------------------------------
// 확정 지침 만들기와 확인
// ---------------------------------------------------------------------------

function seal(fields: Omit<ConfirmedRubric, typeof CONFIRMED>): ConfirmedRubric {
  const items = Object.freeze(fields.items.map((item) => Object.freeze({ ...item })))
  return Object.freeze({ ...fields, items }) as ConfirmedRubric
}

/** 저장된 값이 확정할 때 만든 값 그대로인지 본다. 문제가 없으면 빈 배열. */
function storedProblems(record: StoredConfirmedRubric): string[] {
  const problems: string[] = []
  if (record.documentId === '') problems.push('문서가 비어 있습니다.')
  if (!Number.isInteger(record.ordinal) || record.ordinal < 1) {
    problems.push('버전 순번이 올바르지 않습니다.')
  }
  problems.push(...itemProblems(record.items), ...confirmationProblems(record.items))

  const contentHash = rubricContentHash(record.items)
  if (record.contentHash !== contentHash) problems.push('내용 해시가 맞지 않습니다.')
  const rubricVersion = computeRubricVersion({
    documentId: record.documentId,
    ordinal: record.ordinal,
    contentHash,
  })
  if (record.rubricVersion !== rubricVersion) problems.push('지침 버전이 맞지 않습니다.')
  return problems
}

export interface ConfirmInput {
  documentId: string
  /** 그 문서에서 몇 번째 확정인가. 이전 확정 순번 + 1 */
  ordinal: number
  items: readonly RubricItem[]
  confirmedAt: string
}

export type ConfirmResult = { ok: true; rubric: ConfirmedRubric } | { ok: false; problems: string[] }

/**
 * 사용자가 확정한 항목으로 확정 지침을 만든다. **확정 지침이 생기는 유일한 입구다.**
 * 확정할 수 없는 내용(빈 지침, 이름 없는 항목, 겹치는 이름)이면 만들지 않고 이유를 돌려준다.
 */
export function confirmRubric({ documentId, ordinal, items, confirmedAt }: ConfirmInput): ConfirmResult {
  const contentHash = rubricContentHash(items)
  const record: StoredConfirmedRubric = {
    documentId,
    ordinal,
    rubricVersion: computeRubricVersion({ documentId, ordinal, contentHash }),
    contentHash,
    items,
    confirmedAt,
  }
  const problems = storedProblems(record)
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, rubric: seal({ status: 'confirmed', ...record }) }
}

/**
 * 저장소에서 읽은 확정 지침을 되살린다.
 * 확정할 때와 내용이 다르면(누군가 DB 를 고쳤거나 깨졌으면) 확정 지침으로 인정하지 않고 예외를 던진다.
 */
export function restoreConfirmedRubric(record: StoredConfirmedRubric): ConfirmedRubric {
  const problems = storedProblems(record)
  if (problems.length > 0) {
    throw new RubricIntegrityError(
      `저장된 지침(버전 ${record.ordinal})을 확정 지침으로 인정할 수 없습니다: ${problems.join(' ')}`,
    )
  }
  return seal({ status: 'confirmed', ...record })
}

function isItemShape(value: unknown): value is RubricItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item['itemId'] === 'string' &&
    typeof item['title'] === 'string' &&
    typeof item['description'] === 'string' &&
    typeof item['importance'] === 'number'
  )
}

/**
 * 런타임 확인. 타입 표식은 컴파일이 끝나면 사라지므로, AI 요청 직전에는 이 함수로 다시 본다.
 * 이 모듈이 만들어 얼린 객체이고, 상태가 'confirmed' 이고, 해시가 내용과 맞아야 통과한다.
 */
export function isConfirmedRubric(value: unknown): value is ConfirmedRubric {
  if (typeof value !== 'object' || value === null || !Object.isFrozen(value)) return false
  const rubric = value as Record<string, unknown>
  const items = rubric['items']
  if (
    rubric['status'] !== 'confirmed' ||
    typeof rubric['documentId'] !== 'string' ||
    typeof rubric['ordinal'] !== 'number' ||
    typeof rubric['rubricVersion'] !== 'string' ||
    typeof rubric['contentHash'] !== 'string' ||
    typeof rubric['confirmedAt'] !== 'string' ||
    !Array.isArray(items) ||
    !Object.isFrozen(items) ||
    !items.every((item) => isItemShape(item) && Object.isFrozen(item))
  ) {
    return false
  }
  return (
    storedProblems({
      documentId: rubric['documentId'],
      ordinal: rubric['ordinal'],
      rubricVersion: rubric['rubricVersion'],
      contentHash: rubric['contentHash'],
      items: items as RubricItem[],
      confirmedAt: rubric['confirmedAt'],
    }).length === 0
  )
}

/** 확정 지침이 아니면 예외를 던진다. AI 요청을 만드는 쪽이 요청 직전에 부른다. */
export function assertConfirmedRubric(value: unknown): asserts value is ConfirmedRubric {
  if (!isConfirmedRubric(value)) {
    throw new UnconfirmedRubricError('확정하지 않은 지침은 AI 요청에 실을 수 없습니다.')
  }
}
