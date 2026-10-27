/**
 * HWPX 어댑터 — **읽기 전용**.
 *
 * PRD 4.5: "프로그램은 사용자의 HWPX를 읽기만 하며 어떤 경우에도 수정하지 않는다.
 * 메모를 삽입하거나 검토본 파일을 만들지 않는다."
 *
 * 이 파일에 쓰기 API를 추가하지 말 것. 체크포인트는 파일 복사로만 만든다 (2단계).
 */
import type { HwpxDocument } from '../../core/document/model.js'

import { readHwpx } from './reader.js'

export interface HwpxReader {
  /** HWPX 를 읽어 문단 목록을 돌려준다. 파일을 수정하지 않는다. */
  read(absolutePath: string): HwpxDocument
}

/** 기본 구현. */
export const hwpxReader: HwpxReader = {
  read: readHwpx,
}

export { readHwpx, NotHwpxError, parseSection, parseSectionOrder, parseStyles } from './reader.js'
export { checkHwpxIntact } from './integrity.js'
export type { IntegrityResult } from './integrity.js'
export type { HwpxDocument, Paragraph, ParagraphRole, TablePosition } from '../../core/document/model.js'
