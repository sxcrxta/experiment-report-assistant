/**
 * 렌더러를 브라우저 없이 돌려 보는 최소 DOM 대역.
 *
 * 이벤트 연결과 화면에 실제로 적히는 글을 검증한다.
 * **실제 Electron 창의 배치·색 검증을 대신하지 않는다.**
 */
export class NodeStub {
  children: NodeStub[] = []
  className = ''
  parent: NodeStub | null = null
  textContent = ''
  value = ''
  disabled = false
  hidden = false
  open = false
  id = ''
  attributes = new Map<string, string>()
  dataset: Record<string, string> = {}
  scrollTop = 0
  scrollLeft = 0
  get parentElement(): NodeStub | null { return this.parent }
  listeners = new Map<string, ((event: { preventDefault(): void; stopPropagation(): void; key?: string }) => void)[]>()
  readonly tag: string
  constructor(tag: string) { this.tag = tag }
  append(...nodes: NodeStub[]): void {
    for (const node of nodes) { node.parent = this; this.children.push(node) }
  }
  prepend(...nodes: NodeStub[]): void {
    for (const node of nodes) node.parent = this
    this.children = [...nodes, ...this.children]
  }
  replaceChildren(...nodes: NodeStub[]): void { this.children = []; this.append(...nodes) }
  remove(): void {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((node) => node !== this)
  }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value) }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null }
  addEventListener(event: string, listener: (event: { preventDefault(): void; stopPropagation(): void; key?: string }) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  focus(): void { /* 포커스 이동은 검증하지 않는다 */ }
  /** 이름을 지정해 이벤트를 흘린다 (드래그처럼 click 이 아닌 것에 쓴다). */
  fire(type: string): void {
    if (this.disabled) return
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault: () => undefined, stopPropagation: () => undefined })
    }
  }
  click(): void { this.fire('click') }
  submit(): void {
    for (const listener of this.listeners.get('submit') ?? []) listener({ preventDefault: () => undefined, stopPropagation: () => undefined })
  }
  get childElementCount(): number { return this.children.length }
  /** `.클래스` 모양의 선택자만 알아듣는다. 나머지는 찾지 못한 것으로 친다 */
  querySelector(selector: string): NodeStub | null {
    if (!/^\.[\w-]+$/.test(selector)) return null
    const name = selector.slice(1)
    return this.all().slice(1).find((node) => node.className.split(/\s+/).includes(name)) ?? null
  }
  get lastElementChild(): NodeStub | null { return this.children.at(-1) ?? null }
  querySelectorAll(selector = ''): NodeStub[] {
    if (/^\.[\w-]+$/.test(selector)) {
      const name = selector.slice(1)
      return this.all().slice(1).filter((node) => node.className.split(/\s+/).includes(name))
    }
    return this.all().filter((node) => ['button','input','textarea','select'].includes(node.tag))
  }
  all(): NodeStub[] { return [this, ...this.children.flatMap((child) => child.all())] }
}

/** `document` 전역 대역. 렌더러가 쓰는 만큼만 만든다. */
export function documentStub(): Record<string, unknown> {
  return {
    createElement: (tag: string) => new NodeStub(tag),
    createElementNS: (_namespace: string, tag: string) => new NodeStub(tag),
    createTextNode: (text: string) => { const node = new NodeStub('#text'); node.textContent = text; return node },
    getElementById: () => null,
  }
}
