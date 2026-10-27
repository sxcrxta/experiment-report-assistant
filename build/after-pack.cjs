/**
 * 묶은 뒤 **애드혹 서명**을 다시 붙인다 ([Q-31]).
 *
 * 왜 필요한가: Apple Silicon 은 서명이 유효하지 않은 실행 파일을 커널이 막는다(SIGTRAP, 종료 코드 133).
 * Electron 바이너리에는 원래 애드혹 서명이 붙어 있는데, 우리가 app.asar 를 넣고 Info.plist 를 바꾸면
 * 그 서명이 더 이상 내용과 맞지 않는다. 그래서 바뀐 번들에 서명을 다시 붙여야 실행된다.
 *
 * `--sign -` 은 **애드혹**이다. 인증서도 Apple Developer 계정도 쓰지 않는다.
 * 이 맥에서 만들어 이 맥에서 쓰는 용도이며, 공개 배포·공증은 범위 밖이다 (PRD 5절, [Q-22]~[Q-24]).
 * 다른 맥으로 옮기면 Gatekeeper 가 막는다. 그것이 이 서명의 한계다.
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // 안쪽(프레임워크·헬퍼)부터 바깥쪽 순서로 붙여야 한다. --deep 이 그 순서를 맡는다.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  // 서명이 실제로 유효한지 확인한다. 실패하면 여기서 빌드를 멈춘다 — 못 여는 앱을 내보내지 않는다.
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })

  console.log(`  • 애드혹 서명 완료  app=${app}`)
}
