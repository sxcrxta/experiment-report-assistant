/**
 * 계층 경계 검사기.
 *
 * CLAUDE.md §7: "코어(도메인·알고리즘)는 UI·네트워크·파일 시스템에 의존하지 않는다.
 * 외부 세계는 인터페이스 뒤에 둔다."
 * IMPLEMENTATION_PLAN.md 0단계: "계층 경계 위반이 빌드 실패로 잡힌다."
 *
 * 이 모듈은 순수 함수만 담는다. 파일 시스템 접근은 호출자(테스트)가 한다.
 */
import { builtinModules } from 'node:module'

export const LAYERS = ['shared', 'core', 'adapters', 'app', 'main', 'preload', 'renderer'] as const

export type Layer = (typeof LAYERS)[number]

/** 각 계층이 import 할 수 있는 계층. 자기 자신은 항상 허용된다. */
export const ALLOWED_LAYERS: Record<Layer, readonly Layer[]> = {
  shared: ['shared'],
  core: ['core', 'shared'],
  adapters: ['adapters', 'core', 'shared'],
  app: ['app', 'adapters', 'core', 'shared'],
  main: ['main', 'app', 'adapters', 'core', 'shared'],
  preload: ['preload', 'shared'],
  renderer: ['renderer', 'shared'],
}

/**
 * 계층별로 금지되는 외부 모듈.
 * - core/shared: 순수해야 하므로 Node 내장 모듈과 electron 금지.
 * - renderer: contextIsolation. 외부 세계는 preload 브리지를 통해서만 닿는다.
 */
export const FORBIDS_NODE_BUILTINS: readonly Layer[] = ['shared', 'core', 'renderer']
export const FORBIDS_ELECTRON: readonly Layer[] = ['shared', 'core', 'renderer']

const NODE_BUILTINS = new Set(builtinModules)

export interface Violation {
  file: string
  spec: string
  reason: string
}

/** 'src/core/diff/myers.ts' -> 'core'. src 밖이면 null. */
export function layerOf(relPath: string): Layer | null {
  const parts = relPath.split('/')
  if (parts[0] !== 'src') return null
  const candidate = parts[1]
  return LAYERS.find((l) => l === candidate) ?? null
}

/** import/export/require/동적 import 에서 모듈 지정자를 뽑는다. */
export function extractImports(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  const specs = new Set<string>()
  // 중간 부분에 따옴표와 세미콜론을 허용하지 않아 문장 경계를 넘지 않게 한다.
  const patterns = [
    /\bimport\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      const spec = match[1]
      if (spec !== undefined) specs.add(spec)
    }
  }
  return [...specs]
}

/** 상대 경로 지정자를 저장소 기준 경로로 정규화한다. */
export function resolveRelative(fromRelPath: string, spec: string): string {
  const fromDir = fromRelPath.split('/').slice(0, -1)
  const out = [...fromDir]
  for (const segment of spec.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

function bareModuleName(spec: string): string {
  if (spec.startsWith('node:')) return spec.slice('node:'.length)
  const parts = spec.split('/')
  if (spec.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0] ?? spec
}

/** 파일 하나를 검사한다. relPath 는 저장소 루트 기준 POSIX 경로. */
export function checkFile(relPath: string, source: string): Violation[] {
  const layer = layerOf(relPath)
  if (layer === null) return []

  const violations: Violation[] = []
  const allowed = ALLOWED_LAYERS[layer]

  for (const spec of extractImports(source)) {
    if (spec.startsWith('.')) {
      const target = resolveRelative(relPath, spec)
      const targetLayer = layerOf(target)
      if (targetLayer === null) {
        violations.push({
          file: relPath,
          spec,
          reason: `${layer} 계층이 src 밖(${target})을 상대 경로로 참조한다`,
        })
        continue
      }
      if (!allowed.includes(targetLayer)) {
        violations.push({
          file: relPath,
          spec,
          reason: `${layer} 계층은 ${targetLayer} 계층을 import 할 수 없다 (허용: ${allowed.join(', ')})`,
        })
      }
      continue
    }

    const name = bareModuleName(spec)
    if (NODE_BUILTINS.has(name) && FORBIDS_NODE_BUILTINS.includes(layer)) {
      violations.push({
        file: relPath,
        spec,
        reason: `${layer} 계층은 Node 내장 모듈(${name})을 쓸 수 없다`,
      })
      continue
    }
    if (name === 'electron' && FORBIDS_ELECTRON.includes(layer)) {
      violations.push({
        file: relPath,
        spec,
        reason: `${layer} 계층은 electron 을 직접 import 할 수 없다`,
      })
    }
  }

  return violations
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `  ${v.file}\n    import '${v.spec}' — ${v.reason}`).join('\n')
}
