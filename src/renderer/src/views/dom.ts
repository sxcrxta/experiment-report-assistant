/**
 * 화면을 그릴 때 쓰는 작은 도우미.
 *
 * 여기에 로직을 넣지 않는다. innerHTML 을 쓰지 않고 요소를 만들어 붙인다
 * (문서 내용이 그대로 화면에 오므로 마크업으로 해석될 여지를 두지 않는다).
 */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 값과 보이는 글이 다른 선택지 하나. */
export function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

/** 눌리는 상태를 aria-pressed 로 나타내는 버튼. 색은 CSS 토큰이 정한다. */
export function toggleButton(
  className: string,
  label: string,
  pressed: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const button = element('button', className, label)
  button.type = 'button'
  button.setAttribute('aria-pressed', String(pressed))
  button.addEventListener('click', onClick)
  return button
}
