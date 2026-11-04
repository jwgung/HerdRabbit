# HerdRabbit이 Herdr 명령으로 하는 일

[English](herdr-coverage.md)

Herdr 0.9.5(`herdr --help`와 명령 묶음마다의 `--help`)를 기준으로 확인했습니다. HerdRabbit은 Herdr의 이름을 그대로 씁니다. **세션(Session)** 안에 **워크스페이스(Workspace)**가, 워크스페이스 안에 **탭(Tab)**이, 탭 안에 **패인(Pane)**이 있습니다.

**표시**는 페이지에 보인다는 뜻, **됨**은 페이지에서 할 수 있다는 뜻, **일부**는 일부만 된다는 뜻, **내부 사용**은 HerdRabbit이 자기 일에 쓰지만 따로 조작하는 곳은 없다는 뜻, **없음**은 아직 HerdRabbit에서 할 방법이 없다는 뜻입니다. Herdr 자체 터미널 화면이나 에이전트 통합만 쓰는 명령은 **필요 없음**으로 적었습니다.

## 세션 (`herdr session`)

| 명령 | HerdRabbit | 메모 |
|---|---|---|
| `list` | 표시 | 사이드바에 모든 머신의 세션과 실행 여부 |
| `attach` | 필요 없음 | 페이지는 세션 전체가 아니라 패인에 붙습니다 |
| `stop` | 없음 | 실행 중인 세션을 `⋯` 메뉴에서 멈추기 |
| `delete` | 없음 | 멈춘 세션 지우기 |
| 새 이름 있는 세션(`herdr --session <name>`) | 없음 | 머신에 세션 하나 더 시작하기 |

## 워크스페이스 (`herdr workspace`)

| 명령 | HerdRabbit | 메모 |
|---|---|---|
| `list`, `get` | 표시 | 사이드바의 워크스페이스 |
| `create` | 됨 | 머신 `⋯` 메뉴의 **New workspace…**, 셸이나 에이전트로, 직접 쓰거나 Browse…로 고른 폴더에서 시작(`--cwd`). `~` 그대로 두면 Herdr의 `new_cwd` 설정을 따른 폴더에서 열립니다 |
| `rename` | 됨 | |
| `close` | 됨 | 확인 뒤 |
| `focus` | 필요 없음 | 페이지가 직접 패인을 고릅니다 |
| `report-metadata` | 필요 없음 | 에이전트 통합용 |

## 탭 (`herdr tab`)

| 명령 | HerdRabbit | 메모 |
|---|---|---|
| `list`, `get` | 표시 | |
| `create` | 됨 | 워크스페이스 `⋯` 메뉴의 **New tab…**, 셸·에이전트·에이전트의 예전 대화로, 워크스페이스 폴더나 직접 쓰거나 Browse…로 고른 폴더에서 시작(`--cwd`). 이어하는 대화는 워크스페이스 폴더에서 열립니다 |
| `rename` | 됨 | |
| `close` | 됨 | 확인 뒤 |
| `focus` | 필요 없음 | |

## 패인 (`herdr pane`)

| 명령 | HerdRabbit | 메모 |
|---|---|---|
| `list`, `get`, `layout` | 표시 | 패인, 폴더, 그 안의 에이전트, 탭의 배치 |
| `process-info` | 내부 사용 | 패인에서 도는 Codex 대화를 찾을 때 읽음. 화면에는 없음 |
| `read` | 됨 | 비춰 보이는 패인, 터미널 안 찾기 |
| `send-text`, `send-keys`, `run` | 됨 | 입력창, 키 막대, 에이전트 시작 |
| `split` | 됨 | 오른쪽·아래로 나누기, 같은 폴더에서 |
| `close` | 됨 | |
| `zoom` | 됨 | |
| `resize` | 일부 | **Even out layout**만. 없는 것: 나눈 경계 끌기 |
| `swap`, `move` | 됨 | 줄과 패인 끌어 옮기기, Move out to its own tab |
| `rename` | 없음 | 패인 이름 붙이기(탭과 워크스페이스는 이름을 바꿀 수 있음) |
| `focus`, `neighbor`, `edges` | 필요 없음 | 페이지가 직접 패인 사이를 옮깁니다 |
| `input` | 없음 | 한 입력을 여러 패인에 함께 보내기 |
| `wait-output` | 필요 없음 | 스크립트용 |
| `report-agent`, `report-agent-session`, `release-agent`, `report-metadata` | 필요 없음 | 에이전트 통합용 |

## 터미널 (`herdr terminal`)

| 명령 | HerdRabbit | 메모 |
|---|---|---|
| `attach` | 됨 | 붙은 패인은 모두 실제 `herdr terminal attach` |
| `session`, `title` | 필요 없음 | |

## 워크트리 (`herdr worktree`)

| 명령 | HerdRabbit | 메모 |
|---|---|---|
| `list` | 됨 | Open worktree…가 저장소의 체크아웃을 보여 줌. 워크트리 워크스페이스는 이름 옆에 브랜치 표시 |
| `create` | 됨 | 저장소 워크스페이스의 New worktree…: 브랜치, 선택 사항인 시작점과 이름, `--path`는 쓰지 않음. Herdr 포커스를 가져오지 않고 엶 |
| `open` | 됨 | Open worktree…가 목록의 체크아웃을 폴더로(`--path`) 엶 |
| `remove` | 됨 | 워크트리 워크스페이스의 Remove worktree…, 확인 뒤. Git이 변경 있는 체크아웃을 거절하면 한 번 더 확인한 뒤에만 `--force` |
| `--cwd`, `--trust-repository` | 없음 | 워크스페이스 대신 폴더에서 시작하기, 다른 사용자 소유 저장소 |

## 플러그인 (`herdr plugin`)

| 명령 | HerdRabbit | 메모 |
|---|---|---|
| `list` | 표시 | Settings → Plugins, 머신마다 |
| `install` | 됨 | GitHub `owner/repo`에서, 확인 뒤. 로그인이 켜져 있어야 합니다 |
| 마켓플레이스([herdr.dev/plugins](https://herdr.dev/plugins/)) | 표시 | Settings → Plugins → Browse: 검색, Herdr와 같은 정렬, Installed 표시, Install…은 같은 확인 단계로 |
| `enable`, `disable`, `update`, `uninstall` | 됨 | HerdRabbit 자신은 제외(Settings → Updates에서 업데이트). 새 버전이 있는 플러그인도 그곳에서 업데이트(Update all) |
| 업데이트 확인 | 표시 | Ref 없이 GitHub에서 설치한 플러그인만, 마켓플레이스의 head commit이 설치된 커밋과 다르면 "Update available"(목록은 10분마다 다시 읽음). Update all은 하나씩, HerdRabbit은 마지막, 처음 실패에서 멈춤 |
| `link`, `unlink` | 됨 | Link local folder…(입력하거나 Browse…로 고른 폴더, Files 탭과 같은 검사, 매니페스트가 HerdRabbit이나 이미 있는 플러그인이 아닐 것). 링크한 플러그인은 Unlink… |
| `action list`, `action invoke` | 됨 | ⋯ → Actions and panes… → Run. 보고 있는 패인을 위해(그 워크스페이스·탭·폴더를 Herdr 컨텍스트로, 소켓으로), 없으면 Herdr 포커스가 있는 곳에서. HerdRabbit 자신의 것은 제외 |
| `pane open` | 됨 | ⋯ → Actions and panes… → Open. 보고 있는 패인의 워크스페이스에 새 탭으로 열고 보여 줌. overlay·popup 배치는 쓰지 않음: overlay는 어디든 Herdr 자신의 포커스를 덮고, popup은 패인이 아님. HerdRabbit 자신의 것은 제외 |
| `pane focus`, `pane close` | 필요 없음 | 연 플러그인 패인은 평범한 패인이라 다른 패인처럼 보여 주고 닫음 |
| `log list` | 됨 | ⋯ → Logs…: 최근 20개, 최신순, 색과 폴더를 뺀 출력 |
| `config-dir` | 없음 | |

## 그 밖의 명령

| 명령 | HerdRabbit | 메모 |
|---|---|---|
| `herdr update` | 됨 | Settings → Updates, 모든 머신의 Herdr |
| `herdr channel` | 됨 | Settings → Herdr: 머신마다 Stable·Preview, Updates가 따름 |
| `herdr config`, `herdr server reload-config` | 됨 | Settings → Herdr: `config.toml`을 글로 편집, 저장 전에 `herdr config check`로 검사하고 저장 뒤 다시 불러옴. `config reset-keys`는 없음 |
| `herdr notification` | 필요 없음 | HerdRabbit은 자체 Web Push 알림을 보냅니다 |
| `herdr integration` | 됨 | Settings → Herdr: 머신마다 상태, 설치, 제거 |
| `herdr agent` | 없음 | |
| `herdr machine` | 필요 없음 | Connect PC로 대체 |
| `herdr api` | 내부 사용 | 페이지 목록은 `herdr api snapshot`과 Herdr 소켓 API에서 옴 |
| `herdr status`, `herdr server stop` | 없음 | Herdr 자체 상태 보기, 서버 멈추기 |

## 없는 기능, 추천 순서

지금은 아래 기능을 만들 계획이 없습니다.

1. 나눈 경계를 끌어 패인 크기 바꾸기, 패인 이름 붙이기.
2. 세션: 하나 더 시작하기, 멈추기, 멈춘 세션 지우기.
3. 한 입력을 여러 패인에 보내기(`pane input`).
