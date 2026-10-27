# V-2 — 설치된 Claude Code 의 비대화형 실행 방식 (확인 기록)

확인한 날짜: **2026-09-12**
확인한 기계: 이 개발 맥북 (macOS 24.6.0, darwin)
확인한 버전: **`2.1.269 (Claude Code)`**

`CLAUDE.md` §7 — "외부 도구의 인자·출력 형식을 추측해서 코드에 넣지 않는다. 설치된 버전에서
확인한 뒤 확정한다." 아래는 전부 이 맥에서 **실제로 실행해 본 결과**다. 도움말에만 있고 실행해
보지 않은 것은 그렇게 적어 두었다.

---

## 1. 설치 위치

```
$ which claude
/Users/me/.local/bin/claude

$ $SHELL -l -c 'command -v claude'
/Users/me/.local/bin/claude
```

`~/.local/bin` 은 로그인 셸의 PATH 에만 있다. **GUI 로 띄운 Electron 앱의 PATH 에는 없다.**
그래서 경로 해결은 로그인 셸(`$SHELL -l -c 'command -v claude'`)을 한 번 실행해서 한다
(`IMPLEMENTATION_PLAN.md` §1.6).

## 2. 로그인 상태 판별

```
$ claude auth status        # --json 이 기본값이다
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  ...
  "subscriptionType": "pro"
}
$ echo $?
0
```

- `claude auth status` 는 **JSON 이 기본 출력**이고 `--text` 로 사람이 읽는 형식을 고를 수 있다.
- 쓰는 것은 `loggedIn` 뿐이다. 이메일·조직·구독 종류는 읽지 않고 화면에도 쓰지 않는다.

## 3. 비대화형 호출 (확정한 인자)

```
claude -p \
  --output-format json \
  --json-schema '<JSON Schema>' \
  --system-prompt '<우리 프롬프트 판>' \
  --model opus \
  --tools "" \
  --permission-prompts none \
  --no-session-persistence \
  --safe-mode
```

프롬프트 본문은 **stdin** 으로 넣고 결과는 stdout 으로 받는다.

각 인자를 쓰는 이유:

| 인자 | 이유 |
| --- | --- |
| `-p` | 비대화형(print) 모드. 한 번 답하고 끝난다 |
| `--output-format json` | 결과 봉투를 JSON 으로 받는다 (아래 4절) |
| `--json-schema <schema>` | 구조화 출력. 모델이 이 스키마대로만 답한다 |
| `--system-prompt <글>` | Claude Code 의 기본 시스템 프롬프트를 **우리 프롬프트 판으로 대체**한다. 코딩 도우미 지침이 검토에 섞이지 않는다 |
| `--model opus` | 심층 검토 모델을 고정한다 ([Q-30]) |
| `--tools ""` | 내장 도구를 전부 끈다. 파일을 읽거나 명령을 실행할 길이 없다 |
| `--permission-prompts none` | 물어봐야 하는 일은 자동 거부된다. 무인 실행이 멈추지 않는다 |
| `--no-session-persistence` | 대화를 디스크에 남기지 않는다. 검토 내용이 `~/.claude/projects` 에 쌓이지 않는다 |
| `--safe-mode` | CLAUDE.md·스킬·플러그인·훅·MCP 등 사용자 설정을 끈다. 이 저장소의 CLAUDE.md 가 검토 프롬프트에 섞이지 않는다. 인증·모델 선택은 정상 동작한다 |

**쓰지 않는 것:** `--bare` 는 OAuth·키체인을 아예 읽지 않고 `ANTHROPIC_API_KEY` 만 쓴다.
PRD 4.3 이 "Claude API 를 사용하지 않는다" 고 못박았으므로 쓰지 않는다.

### 실측

| 조합 | 결과 |
| --- | --- |
| `--tools ""` 만 (기본 시스템 프롬프트) | 캐시 생성 입력 23,103 토큰, 12초, $0.10 (sonnet) |
| `--tools "" --safe-mode --system-prompt …` | 캐시 생성 입력 2,775 토큰, $0.023 (sonnet) |

시스템 프롬프트를 우리 것으로 바꾸면 들어가는 토큰이 8배 넘게 줄고, 코딩 도우미 지침도 사라진다.

## 4. 출력 형식

성공한 호출의 stdout 은 JSON 객체 하나다. 우리가 읽는 필드:

| 필드 | 뜻 |
| --- | --- |
| `type` | `"result"` |
| `subtype` | `"success"` — **성공을 뜻하지 않는다.** 아래 5절 참고 |
| `is_error` | 오류 여부. **이것을 본다** |
| `result` | 모델의 답. `--json-schema` 를 주면 구조화 출력을 직렬화한 JSON **문자열** |
| `structured_output` | `--json-schema` 를 줬을 때만. `result` 를 파싱한 객체 |
| `api_error_status` | API 오류의 HTTP 상태. 정상이면 `null` |
| `session_id`, `total_cost_usd`, `num_turns`, `usage` | 기록용. 로직에 쓰지 않는다 |

`--json-schema` 를 쓰면 구조화 출력이 **도구 호출**로 전달되므로 `stop_reason` 이 `"tool_use"`,
`num_turns` 가 2~3 으로 나온다. `--tools ""` 로 도구를 다 껐어도 그렇다. 정상이다.

## 5. 오류 판별 — 종료 코드만 믿지 않는다

없는 모델 이름을 준 실제 실행:

```
$ echo hi | claude -p --output-format json --model no-such-model-xyz … ; echo $?
[claude-code:unrecognized_model] {"model":"no-such-model-xyz","query_source":"sdk"}   # stderr
{"type":"result","subtype":"success","is_error":true,"api_error_status":404,
 "result":"There's an issue with the selected model …","terminal_reason":"api_error", …}
1
```

- `subtype` 은 **`"success"` 인데 `is_error` 가 true** 였다. `subtype` 만 보면 오류를 놓친다.
- 종료 코드는 1 이었다. 잘못된 플래그(`--no-such-flag`)도 1 이었다.
- 오류일 때 `result` 는 모델의 답이 아니라 **오류 설명 문장**이다. 결과인 척 보여 주면 안 된다.

그래서 어댑터의 성공 판정은 **`code === 0 && is_error !== true && 읽을 수 있는 구조화 출력이 있다`**
셋을 모두 만족할 때뿐이다. 하나라도 어긋나면 실패로 분류해 사용자에게 알린다.

실패 분류에 쓰는 근거:

| 관찰한 것 | 분류 |
| --- | --- |
| spawn 이 `ENOENT` | `not-installed` |
| `claude auth status` 의 `loggedIn` 이 false | `not-logged-in` |
| `api_error_status` 가 401/403 | `unauthorized` |
| `api_error_status` 가 429 | `rate-limited` |
| `api_error_status` 가 5xx | `server-error` |
| 정해 둔 시간 안에 끝나지 않음 | `timeout` (프로세스를 죽인다) |
| 봉투를 파싱하지 못하거나 `result`/`structured_output` 이 없음 | `malformed` (앱이 다시 묻는다) |
| 그 밖의 0 이 아닌 종료 코드 | `rejected` |

## 6. 확인하지 못한 것

- **로그인하지 않은 상태의 출력.** 이 맥은 로그인되어 있어 재현하지 못했다.
  `loggedIn: false` 를 읽으면 부르지 않는 쪽으로 처리하므로, 판별은 `auth status` 한 곳에만 기댄다.
- **오프라인일 때의 종료 코드.** 앱이 먼저 `net.isOnline()` 으로 막으므로 이 경로는 쓰지 않는다.
- `--max-budget-usd` 는 도움말로만 봤고 실행하지 않았다. 지금 코드에 넣지 않는다.
