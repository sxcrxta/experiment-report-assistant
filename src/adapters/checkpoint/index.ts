/**
 * 체크포인트 — 원본 HWPX 를 **복사해서** 보관한다.
 *
 * PRD 4.5: "최초본과 사용자가 지정한 시점을 복구용 전체 체크포인트로 보관한다.
 * 체크포인트는 원본을 복사해 보관하며 내용을 편집하지 않는다."
 * CLAUDE.md §3: "체크포인트는 원본을 복사할 뿐 편집하지 않는다."
 *
 * 그래서 이 모듈이 **하지 않는 일**을 먼저 적어 둔다.
 * - 원본 경로에 쓰지 않는다. 복사는 언제나 보관 폴더 쪽으로만 간다.
 * - 복구도 원본을 덮어쓰지 않는다. 사용자가 지정한 **새 경로**에만 내놓고, 이미 파일이 있으면 거부한다.
 *   사용자의 문서를 프로그램이 바꾸는 경로를 아예 만들지 않기 위해서다.
 * - 파괴적으로 보이는 동작은 사용자 확인(`confirmed`) 없이는 실행하지 않는다.
 */
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

export type CheckpointKind = 'initial' | 'user'

export interface CheckpointFile {
  /** 보관된 사본의 절대 경로 */
  filePath: string
  byteSize: number
  /** 사본 바이트의 sha256. 복구 전 확인에 쓴다 */
  contentHash: string
}

export interface SaveCheckpointInput {
  /**
   * 체크포인트 행의 id. 사본 파일 이름에 넣는다.
   * 같은 버전에서 사용자가 체크포인트를 여러 번 남길 수 있어서 버전·종류만으로는 이름이 겹친다.
   */
  checkpointId: string
  documentId: string
  versionId: string
  kind: CheckpointKind
  /** 복사할 원본 HWPX 경로 */
  sourcePath: string
  /**
   * 사본이 가져야 할 sha256 (체크포인트가 가리키는 버전의 해시).
   * 복사하는 사이 한글이 다시 저장하면 사본이 그 버전과 달라진다. 그런 사본은 남기지 않는다.
   */
  expectedContentHash?: string
}

export interface CheckpointStore {
  save(input: SaveCheckpointInput): CheckpointFile
  /** 사본이 그대로인지 확인한다 */
  verify(file: CheckpointFile): boolean
  /** 사용자가 지정한 **새** 경로로 되살린다. 기존 파일을 덮어쓰지 않는다 */
  restoreTo(file: CheckpointFile, destinationPath: string, options: { confirmed: boolean }): void
  /**
   * 보관 사본 하나를 지운다. **보관 폴더 안의 파일만** 지운다 — 사용자 문서에 닿는 경로가 아니다.
   * 이미 없으면 그대로 넘어간다.
   */
  remove(filePath: string, options: { confirmed: boolean }): void
  /** 보고서 하나의 보관 폴더를 통째로 지운다. 보고서를 삭제할 때만 쓴다 */
  removeDocument(documentId: string, options: { confirmed: boolean }): void
}

export function sha256File(absolutePath: string): string {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
}

/**
 * 보관 폴더 아래에 사본을 둔다.
 * 폴더 위치는 메인 프로세스가 `app.getPath('userData')` 로 정해 넘긴다 (`CLAUDE.md` §7).
 */
export function createCheckpointStore(rootDir: string): CheckpointStore {
  /** 보관 폴더 **안쪽**의 경로인가. 밖이면 지우지 않는다 */
  function inside(path: string): boolean {
    const rel = relative(rootDir, path)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  return {
    save({
      checkpointId,
      documentId,
      versionId,
      kind,
      sourcePath,
      expectedContentHash,
    }: SaveCheckpointInput): CheckpointFile {
      const directory = join(rootDir, documentId)
      mkdirSync(directory, { recursive: true })

      const filePath = join(directory, `${versionId}-${kind}-${checkpointId}.hwpx`)
      if (existsSync(filePath)) {
        throw new Error(`이미 있는 체크포인트를 덮어쓰려고 했습니다: ${filePath}`)
      }

      copyFileSync(sourcePath, filePath, constants.COPYFILE_EXCL)

      const copied = statSync(filePath)
      const original = statSync(sourcePath)
      if (copied.size !== original.size) {
        unlinkSync(filePath)
        throw new Error('체크포인트 사본의 크기가 원본과 다릅니다. 저장 중인 파일일 수 있습니다.')
      }

      const contentHash = sha256File(filePath)
      if (expectedContentHash !== undefined && contentHash !== expectedContentHash) {
        // 방금 만든 보관 사본만 지운다. 원본에는 손대지 않는다.
        unlinkSync(filePath)
        throw new Error(
          '체크포인트를 남기는 사이 문서가 다시 저장됐습니다. 저장이 끝난 뒤 다시 시도해 주세요.',
        )
      }

      return { filePath, byteSize: copied.size, contentHash }
    },

    verify(file: CheckpointFile): boolean {
      if (!existsSync(file.filePath)) return false
      return sha256File(file.filePath) === file.contentHash
    },

    restoreTo(file: CheckpointFile, destinationPath: string, { confirmed }): void {
      if (!confirmed) {
        throw new Error('복구는 사용자 확인 뒤에만 실행합니다.')
      }
      if (!existsSync(file.filePath)) {
        throw new Error(`체크포인트 사본을 찾을 수 없습니다: ${file.filePath}`)
      }
      if (sha256File(file.filePath) !== file.contentHash) {
        throw new Error('체크포인트 사본이 기록된 해시와 다릅니다. 복구하지 않았습니다.')
      }
      if (existsSync(destinationPath)) {
        throw new Error(
          `이미 파일이 있는 경로에는 복구하지 않습니다: ${destinationPath}. ` +
            '새 이름을 지정해 주세요.',
        )
      }

      copyFileSync(file.filePath, destinationPath, constants.COPYFILE_EXCL)
    },

    remove(filePath: string, { confirmed }): void {
      if (!confirmed) throw new Error('삭제는 사용자 확인 뒤에만 실행합니다.')
      if (!inside(filePath)) throw new Error(`보관 폴더 밖의 파일은 지우지 않습니다: ${filePath}`)
      rmSync(filePath, { force: true })
    },

    removeDocument(documentId: string, { confirmed }): void {
      if (!confirmed) throw new Error('삭제는 사용자 확인 뒤에만 실행합니다.')
      const directory = join(rootDir, documentId)
      if (!inside(directory)) throw new Error(`보관 폴더 밖은 지우지 않습니다: ${directory}`)
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
