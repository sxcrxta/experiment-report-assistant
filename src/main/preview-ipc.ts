/** 기록된 최신 버전과 같은 HWPX 바이트에서만 미리보기를 만든다. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readHwpxPreview } from '../adapters/hwpx/preview.js'
import type { DocumentRepository } from '../adapters/repo/documents.js'
import type { ReviewImage } from '../adapters/model/schema.js'
import type { DocumentPreviewResult } from '../shared/document-preview.js'

export function createPreviewHandler(repo: DocumentRepository) {
  return async (documentId: unknown): Promise<DocumentPreviewResult> => {
    if (typeof documentId !== 'string') return { status: 'failed', message: '미리볼 문서를 찾지 못했습니다.' }
    const document = repo.getDocument(documentId)
    const version = repo.latestVersion(documentId)
    if (document === null || version === null) return { status: 'failed', message: '기록된 문서가 없습니다.' }
    try {
      const bytes = await readFile(document.path)
      if (createHash('sha256').update(bytes).digest('hex') !== version.contentHash) {
        return { status: 'failed', message: '새 저장을 기록하는 중입니다. 기록이 끝나면 미리보기를 다시 읽습니다.' }
      }
      return { status: 'ok', preview: readHwpxPreview(bytes, repo.listParagraphs(version.id), version.ordinal) }
    } catch (cause) {
      console.error('HWPX 미리보기 읽기 실패', cause)
      return { status: 'failed', message: '원본 서식을 읽지 못해 기록된 문단을 표시합니다. 파일 위치를 확인해 주세요.' }
    }
  }
}

/**
 * 검토와 함께 보낼 **보고서의 그림**을 HWPX 에서 읽는다 ([Q-38]).
 *
 * 미리보기와 같은 읽기 경로를 쓴다. 파일을 고치지 않고, 기록된 그 버전의 바이트일 때만 넘긴다 —
 * 저장 도중이거나 파일이 바뀌었으면 그림을 보내지 않는다 (엉뚱한 그림을 근거로 삼지 않게).
 * 읽지 못하면 빈 목록이고, 부르는 쪽은 글만으로 검토를 이어 간다.
 */
export function createDocumentImageReader(repo: DocumentRepository) {
  return async (documentId: string, versionId: string): Promise<readonly ReviewImage[]> => {
    const document = repo.getDocument(documentId)
    const version = repo.listVersions(documentId).find(entry => entry.id === versionId)
    if (document === null || version === undefined) return []
    try {
      const bytes = await readFile(document.path)
      if (createHash('sha256').update(bytes).digest('hex') !== version.contentHash) return []
      const preview = readHwpxPreview(bytes, repo.listParagraphs(version.id), version.ordinal)
      return preview.images.map((image, at) => ({
        alias: `G${at + 1}`, mimeType: image.mimeType, bytes: image.bytes,
      }))
    } catch (cause) {
      console.error('검토에 실을 그림을 읽지 못했습니다', cause)
      return []
    }
  }
}
