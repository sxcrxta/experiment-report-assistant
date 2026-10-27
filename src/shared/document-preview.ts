/** 읽기 전용 HWPX 미리보기. 경로·XML·외부 URL 은 전달하지 않는다. */

/** 셀 한 변의 선. 한글의 선 종류를 화면이 그릴 수 있는 값으로만 옮긴다. */
export interface PreviewBorder {
  style: 'none' | 'solid' | 'dotted' | 'dashed' | 'double'
  width: number
  color: string
}

import type { MathNode } from './math.js'

/**
 * 문단 안에 놓인 수식 하나.
 *
 * 한글 수식은 이미지가 아니라 스크립트(`<hp:script>`)로 저장된다. 그 스크립트는 **사용자가 쓴 내용**이며
 * 문단 해시에도 들어간다(`core/document/hash.ts`). 미리보기는 조판하지 않고 스크립트를 그대로 보여 준다.
 */
export interface PreviewEquation {
  /** 한글 수식 스크립트 원문. 조판하더라도 원문은 늘 함께 둔다 */
  script: string
  /** 정규화된 문단 글에서 이 수식이 놓인 위치 (문자 기준) */
  offset: number
  /**
   * 조판한 모양. 모르는 문법이 하나라도 있으면 `null` 이고, 그때는 화면이 `script` 를 그대로 보여 준다.
   * 반쯤 조판한 수식은 내용을 틀리게 보여 줄 수 있으므로 만들지 않는다 (`core/math/hwp-equation.ts`).
   */
  nodes: MathNode[] | null
}

export interface PreviewParagraph {
  kind: 'paragraph'
  paragraphId: string
  align: 'left' | 'center' | 'right' | 'justify'
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  /** 글자색. 검정이거나 지정이 없으면 null (화면 기본색을 쓴다) */
  color: string | null
  /** 한글에서 지정한 글꼴 이름. 그 글꼴이 이 맥에 없으면 화면 기본 글꼴로 내려간다 */
  fontFamily: string | null
  /** 줄 간격 배수 (1.6 = 160%) */
  lineHeight: number
  /** 첫 줄 들여쓰기 (px). 음수면 내어쓰기 */
  indent: number
  marginLeft: number
  marginRight: number
  spaceBefore: number
  spaceAfter: number
  equations: PreviewEquation[]
  /**
   * 한글이 줄을 새로 시작한 자리 (정규화된 글에서의 위치).
   *
   * 한글은 저장할 때 자기가 조판한 줄 나눔을 파일에 넣어 둔다. 이 값이 있으면 화면이 줄 나눔을
   * 다시 계산하지 않고 **한글이 나눈 그대로** 그린다. 믿을 수 없으면 빈 배열이고, 그때는 흘려 쓴다.
   */
  lines: number[]
  children: PreviewBlock[]
}

/** 한글의 쪽 설정 (px). 이 폭에 맞춰 그려야 줄바꿈이 원본과 비슷해진다. */
export interface PreviewPage {
  width: number
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
}

export interface PreviewEdges { top: number; right: number; bottom: number; left: number }

export interface PreviewCell {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  width: number
  verticalAlign: 'top' | 'middle' | 'bottom'
  border: { top: PreviewBorder; right: PreviewBorder; bottom: PreviewBorder; left: PreviewBorder }
  /** 칸 배경색. 채우지 않았으면 null */
  background: string | null
  /** 칸 안쪽 여백 (px) */
  padding: PreviewEdges
  children: PreviewBlock[]
}

export interface PreviewTable {
  kind: 'table'
  tableIndex: number
  width: number
  /** 표 자체의 가로 위치 */
  align: 'left' | 'center' | 'right'
  /** 표 바깥 테두리. 칸 테두리와 별개로 지정된다 */
  border: { top: PreviewBorder; right: PreviewBorder; bottom: PreviewBorder; left: PreviewBorder }
  /** 표 바깥 여백 (px) */
  margin: PreviewEdges
  rows: PreviewCell[][]
}

export interface PreviewImage {
  kind: 'image'
  imageId: string | null
  width: number
  height: number
}

export type PreviewBlock = PreviewParagraph | PreviewTable | PreviewImage
export interface DocumentPreview {
  versionOrdinal: number
  /** 첫 구역의 쪽 설정. 쪽 나눔은 재현하지 않고 폭과 여백만 맞춘다 */
  page: PreviewPage
  blocks: PreviewBlock[]
  images: { imageId: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif'; bytes: Uint8Array }[]
}
export type DocumentPreviewResult =
  | { status: 'ok'; preview: DocumentPreview }
  | { status: 'failed'; message: string }
