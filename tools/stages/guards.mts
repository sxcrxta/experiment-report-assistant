/**
 * 중단 조건.
 *
 * 자동화가 건드리면 안 되는 것을 사후에 확인한다. 세션의 도구 권한 제한과 겹쳐서 두 겹으로 막는다.
 * 하나라도 걸리면 커밋하지 않고 멈춘다.
 */
import type { FileChange, GuardViolation } from './types.mts'

/** 사용자 승인 없이 고치면 안 되는 문서. PRD 수정은 사용자만 한다 (CLAUDE.md §0). */
export const PROTECTED_PATHS = [
  'experiment-report-assistant-prd.md',
  'CLAUDE.md',
  'IMPLEMENTATION_PLAN.md',
  'OPEN_QUESTIONS.md',
  'OPEN_ANSWERS.md',
  'STAGE_TASKS.md',
  '.gitignore',
]

/**
 * 자동화 자체. 단계 구현이 여기를 고치면 안 된다.
 *
 * 세션이 자기 실행 권한(허용 도구 목록)이나 검토·중단 조건을 스스로 바꾸는 것을 막는다.
 * 자동화를 고칠 일이 있으면 단계 실행과 분리해서 사람이 직접 한다.
 */
const AUTOMATION_PREFIXES = ['tools/stages/', 'tests/stages-']

/**
 * 비밀 정보가 들어 있을 수 있는 **데이터 파일**.
 *
 * 이름에 secret 이 들어간 디렉터리를 막지 않는다. src/adapters/secret/ 은 키체인 어댑터이고
 * 그 코드의 일이 오히려 키를 저장소 밖에 두는 것이다. 소스 디렉터리를 막으면 앞뒤가 바뀐다.
 */
const SECRET_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)credentials?\.(json|ya?ml|ini|conf|txt)$/i,
  /(^|\/)secrets?\.(json|ya?ml|ini|conf|txt|env)$/i,
]

/**
 * 파일 내용에서 찾는 실제 키 모양.
 *
 * 이름으로 거르는 것보다 이쪽이 실제 위험에 가깝다.
 * 길이만 긴 문자열(해시, base64 자료)은 잡지 않는다. 알려진 키 접두사만 본다.
 */
const SECRET_LITERALS = [
  // 실제 키 모양만 본다. 테스트가 쓰는 가짜 키(sk-or-v1-fixture-0123 같은)를 잡으면
  // 고정 응답 테스트를 못 쓰게 된다. 진짜 OpenRouter 키는 sk-or-v1- 뒤에 긴 16진수가 붙는다.
  { name: 'OpenRouter', pattern: /sk-or-v1-[0-9a-f]{32,}/i },
  { name: 'Anthropic', pattern: /sk-ant-[A-Za-z0-9_-]{40,}/ },
  { name: 'OpenAI', pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  { name: 'AWS', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub', pattern: /\bgh[pousr]_[A-Za-z0-9]{20}/ },
  { name: 'Google', pattern: /\bAIza[0-9A-Za-z_-]{30}/ },
  { name: 'Slack', pattern: /\bxox[abposr]-[0-9A-Za-z-]{10}/ },
]

/** 배포와 관련된 경로. 이 프로젝트는 공개 배포를 하지 않는다 (PRD 5절). */
const DEPLOY_PATTERNS = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)Dockerfile$/i,
  /(^|\/)fastlane\//,
  /(^|\/)electron-builder\./,
  /(^|\/)entitlements.*\.plist$/i,
]

export interface DiffGuardInput {
  changes: readonly FileChange[]
  /** 바뀐 파일의 내용. 주면 실제 키 리터럴이 들어갔는지도 본다 */
  fileContents?: ReadonlyMap<string, string>
  /** 변경 전후 package.json 내용. 없으면 검사를 건너뛴다 */
  packageJsonBefore?: string
  packageJsonAfter?: string
  /** 이 단계가 손대도 되는 문서. 보통은 비어 있다 */
  allowedProtectedPaths?: readonly string[]
}

function dependencyNames(packageJson: string): string[] {
  const parsed = JSON.parse(packageJson) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return [
    ...Object.entries(parsed.dependencies ?? {}).map(([k, v]) => `dependencies:${k}@${v}`),
    ...Object.entries(parsed.devDependencies ?? {}).map(([k, v]) => `devDependencies:${k}@${v}`),
  ].sort()
}

export function checkDiff(input: DiffGuardInput): GuardViolation[] {
  const violations: GuardViolation[] = []
  const allowed = new Set(input.allowedProtectedPaths ?? [])

  for (const change of input.changes) {
    const path = change.path

    if (PROTECTED_PATHS.includes(path) && !allowed.has(path)) {
      violations.push({
        rule: '보호 문서 변경',
        detail: `${path} 은 사용자 승인 없이 고칠 수 없습니다 (CLAUDE.md §0)`,
      })
    }
    if (AUTOMATION_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      violations.push({
        rule: '자동화 자체 변경',
        detail: `${path} 은 단계 실행 자동화입니다. 단계 구현이 자기 실행 권한이나 검토 규칙을 바꿀 수 없습니다`,
      })
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(path))) {
      violations.push({ rule: '비밀 정보', detail: `${path} 은 비밀 정보일 수 있습니다` })
    }
    if (DEPLOY_PATTERNS.some((pattern) => pattern.test(path))) {
      violations.push({ rule: '배포 설정', detail: `${path} 은 배포 설정입니다 (범위 밖)` })
    }
    if (change.status.startsWith('D')) {
      violations.push({ rule: '파일 삭제', detail: `${path} 이 삭제되었습니다` })
    }
    if (path.startsWith('node_modules/') || path === 'package-lock.json') {
      violations.push({ rule: '의존성 산출물', detail: `${path} 이 바뀌었습니다` })
    }
  }

  for (const [path, content] of input.fileContents ?? []) {
    for (const literal of SECRET_LITERALS) {
      if (literal.pattern.test(content)) {
        violations.push({
          rule: '비밀 정보',
          detail: `${path} 에 ${literal.name} 키로 보이는 값이 들어 있습니다`,
        })
      }
    }
  }

  if (input.packageJsonBefore !== undefined && input.packageJsonAfter !== undefined) {
    const before = dependencyNames(input.packageJsonBefore)
    const after = dependencyNames(input.packageJsonAfter)
    const added = after.filter((dep) => !before.includes(dep))
    const removed = before.filter((dep) => !after.includes(dep))
    if (added.length > 0 || removed.length > 0) {
      violations.push({
        rule: '무단 패키지 변경',
        detail: `추가: ${added.join(', ') || '없음'} / 제거: ${removed.join(', ') || '없음'}`,
      })
    }
  }

  return dedupe(violations)
}

function dedupe(violations: readonly GuardViolation[]): GuardViolation[] {
  const seen = new Set<string>()
  return violations.filter((v) => {
    const key = `${v.rule}|${v.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface PreflightInput {
  gitRoot: string
  projectRoot: string
  workingTreeClean: boolean
  branch: string
  /** 이어서 하기(--review-only)에서는 이미 변경이 있으므로 깨끗한 트리를 요구하지 않는다 */
  requireCleanTree?: boolean
}

export function checkPreflight(input: PreflightInput): GuardViolation[] {
  const violations: GuardViolation[] = []

  if (input.gitRoot !== input.projectRoot) {
    violations.push({
      rule: 'Git 루트 불일치',
      detail: `Git 루트가 ${input.gitRoot} 입니다. 이 프로젝트(${input.projectRoot})가 아니면 진행하지 않습니다`,
    })
  }
  if (input.requireCleanTree !== false && !input.workingTreeClean) {
    violations.push({
      rule: '작업 트리 더러움',
      detail: '커밋되지 않은 변경이 있습니다. 단계의 변경만 검토하려면 깨끗한 상태에서 시작해야 합니다',
    })
  }
  if (input.branch === '') {
    violations.push({ rule: '분리된 HEAD', detail: '브랜치가 아닌 상태에서는 커밋하지 않습니다' })
  }

  return violations
}
