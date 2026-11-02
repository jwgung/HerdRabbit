# 디자인 규칙

HerdRabbit 화면을 만들거나 고칠 때 따르는 규칙이다. 값은 `public/ui/tokens.css`의 토큰으로 쓰고, 이 문서에 없는 값이 필요하면 먼저 이 문서와 토큰을 고친다.

이 문서는 2026-11-02에 앱 CSS를 측정해서 만들었다. 대상 파일: `public/styles.css`, `public/ui/*.css`, `public/chat/chat-view.css`, `public/chat/prompt-card.css`, `public/key-bar.css`. 측정 당시에는 글자 크기 35종, 모서리 22종, 간격 20여 종, z-index 16종, 그림자 22종, 토큰 밖 색 리터럴은 hex 11곳과 그림자 안의 `rgb()` 여러 곳이 있었다. 각 절의 **목표 값**이 규칙이고, **지금 값 → 목표** 표는 토큰 정리(UI-2) 때 옮길 대응표다. 정리 전까지는 지금 값이 남아 있을 수 있다.

표에 있는 토큰 중 지금 `tokens.css`에 있는 것은 `--space-2`, `--space-3`, `--space-5`, `--radius-sm`, `--radius-control`, `--radius-input`, `--radius-panel`, `--radius-card`, `--sidebar-motion`, `--mobile-shadow`, `--terminal-font-size`와 색 토큰뿐이다. 나머지(`--font-*`, `--layer-*`, `--shadow-*`, `--motion-*` 등)는 UI-2에서 추가한다.

작업 번호: UI-2 토큰 정리(CSS만), UI-3 규칙 검사 스크립트, UI-4 컴포넌트 통일, N1/Q2 상태 글자 표시. 토큰 정리가 끝나면 각 절의 "지금 값 → 목표" 표는 지운다.

## 원칙

- 폰과 데스크톱을 둘 다 1급으로 본다. 레이아웃은 너비로, 입력 방식(터치·마우스)은 `pointer`/`hover`로 나눈다.
- 터미널이 주인공이다. 장식(그림자, 큰 모서리, 움직임)은 터미널과 채팅을 가리지 않는 만큼만 쓴다.
- 상태는 색만으로 전하지 않는다. 기호와 글자를 함께 둔다.
- 같은 역할의 요소는 한 가지 모양만 쓴다(버튼, 메뉴, 대화상자, 목록 행, 상태 표시). 통일은 UI-4에서 한다.

## 글자 크기

| 토큰 | 값 | 쓰는 곳 |
|---|---|---|
| `--font-2xs` | 10px | 고정폭 eyebrow, 아주 작은 배지 |
| `--font-xs` | 11px | 보조 정보(시간, 경로, 개수) |
| `--font-sm` | 12px | 기본 UI 글자(사이드바 행, 메뉴, 버튼) |
| `--font-md` | 13px | 본문(채팅 기본, 대화상자 본문) |
| `--font-lg` | 14px | 강조 본문, 대화상자 제목 줄 |
| `--font-input-touch` | 16px | 터치 기기의 입력칸, 폰 패인 제목 |
| `--font-xl` | 18px | 화면 제목(`h1`) |
| `--font-2xl` | 22px | 로그인 화면 같은 단독 화면 제목 |

- `rem`은 쓰지 않는다. 사용자 글꼴 설정은 채팅 배율(`--chat-scale`)과 터미널 글자 크기(`--terminal-font-size`)로만 받는다.
- 채팅 안의 크기는 `calc(<토큰 값> * var(--chat-scale, 1))`로 쓴다. `--chat-scale`은 토큰이 아니라 앱이 채팅 글꼴 설정에 따라 실행 중에 정하는 값이다(`public/chat-font-preference.js`). 마크다운 본문 안의 상대 크기(코드, 인용)만 `em`을 허용한다.
- 줄 높이는 UI 1.3, 본문 1.5를 기본으로 한다.

지금 값 → 목표:

| 지금 | 목표 |
|---|---|
| `0.65rem`, `0.7rem`, `0.72rem` | `--font-2xs` (10px) 또는 `--font-xs` (11px) |
| `0.8rem`, `0.82rem`, `0.85rem` | `--font-sm` (12px) 또는 `--font-md` (13px) |
| `0.88rem`, `0.9rem`, `0.92rem` | `--font-lg` (14px) |
| 17px (`h2`) | `--font-xl` (18px) 또는 `--font-input-touch` (16px) |
| 채팅의 `calc(15px …)` | `calc(14px …)` 또는 `calc(16px …)` |

## 간격

4px 격자를 쓰고, 촘촘한 컨트롤 안에서만 2px·6px·10px를 허용한다.

| 토큰 | 값 |
|---|---|
| `--space-0-5` | 2px |
| `--space-1` | 4px |
| `--space-1-5` | 6px |
| `--space-2` | 8px |
| `--space-2-5` | 10px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |

- 1px는 테두리 두께를 보정할 때만 쓴다.
- 지금 값 → 목표: 3px → 2px 또는 4px, 5px → 4px 또는 6px, 7px → 6px 또는 8px, 9px·11px → 8px·10px·12px 중 가까운 쪽, 14px → 12px 또는 16px, 18px·22px → 16px·20px·24px 중 가까운 쪽. 어느 쪽이든 터치 타깃 규칙(아래)을 깨지 않는 쪽을 고른다.

## 모서리

| 토큰 | 값 | 쓰는 곳 |
|---|---|---|
| `--radius-xs` | 4px | 표식, 찾기 강조, 작은 배지 |
| `--radius-sm` | 6px | 키 바 키, 작은 칩, 목록 행 |
| `--radius-control` | 8px | 버튼, 입력칸, 선택칸 |
| `--radius-panel` | 12px | 메뉴, 팝오버, 패널, 바텀시트 윗모서리 |
| `--radius-card` | 14px | 카드, 대화상자 |
| `--radius-pill` | 999px | 알약 모양 버튼·배지 |

- 원은 `50%`로 쓴다. 모서리를 없앨 때는 `0`을 쓴다.
- `--radius-input`(9px)은 `--radius-control`로 합친다. `--radius-sm`은 7px에서 6px로 바뀐다.
- `var(--radius-control, 8px)`처럼 대체값을 쓰지 않는다. `tokens.css`는 항상 먼저 로드된다.
- 지금 값 → 목표: 2px·3px·5px → `--radius-xs`, 7px → `--radius-sm`, 9px → `--radius-control`, 10px·11px → `--radius-panel`.

## 층 (z-index)

숫자 대신 층 토큰을 쓴다. 같은 층 안에서만 `+ 1`로 순서를 정한다.

| 토큰 | 값 | 무엇 (측정 당시 요소) |
|---|---|---|
| `--layer-raised` | 1 | 흐름 안에서 살짝 위: 포커스된 격자 칸(1), 선택된 칸(1), 접기 단추(1), 채팅 맨 아래로 단추(2) |
| `--layer-pane-overlay` | 4 | 패인 위 표시: 터미널 찾기 표식(4)·링크 표식(5), 질문 카드(4), 파일 제안(5)·`@` 파일 참조 목록(6), 사이드바 크기 조절 손잡이(4) |
| `--layer-pane-chrome` | 10 | 패인 도구: 복사 바(10), 터미널 상태(11), 터미널 찾기 바(12), 사이드바 머리(11) |
| `--layer-popover` | 15 | 메뉴·팝오버(지금 10). 패인 도구보다 위, 가림막보다 아래 |
| `--layer-scrim` | 20 | 폰 사이드바 뒤 가림막 |
| `--layer-drawer` | 30 | 폰 사이드바(서랍) |
| `--layer-toast` | 40 | 앱 알림(`.app-alert`) |
| `--layer-screen` | 100 | 로그인 같은 전체 화면 |
| `--layer-drag` | 1000 | 패인 놓을 자리 미리보기(999), 끌기 고스트(1000), 사이드바 놓을 자리 선(1001) |

- 괄호 안은 측정 당시 값이다. 같은 층 안의 순서는 유지한다.
- 층 이름은 패인 기준이지만 사이드바 요소도 같은 높이의 층을 쓴다(사이드바 머리는 `--layer-pane-chrome`, 크기 조절 손잡이는 `--layer-pane-overlay`).
- 측정 당시 메뉴 팝오버(10)가 터미널 상태(11)·터미널 찾기(12)보다 낮았다. 목표는 메뉴가 패인 도구보다 위다. 이 순서를 바꿀 때는 겹치는 화면을 브라우저 체크로 확인한다.
- 대화상자는 네이티브 `<dialog>`의 top layer를 쓰고 z-index를 주지 않는다.

## 그림자

| 토큰 | 값 | 쓰는 곳 |
|---|---|---|
| `--shadow-popover` | `0 6px 18px rgb(0 0 0 / 30%)` | 메뉴, 팝오버, 제안 목록 |
| `--shadow-float` | `0 10px 28px var(--mobile-shadow)` | 떠 있는 바(복사 바, 찾기 바), 토스트 |
| `--shadow-sheet` | `0 24px 80px var(--mobile-shadow)` | 바텀시트, 대화상자 |
| `--shadow-drawer` | `18px 0 50px var(--mobile-shadow)` | 폰 사이드바 서랍(옆으로 드리우는 그림자) |

- 지금 쓰는 `rgb(0 0 0 / 18%~35%)` 변형과 `0 12px 36px`은 위 세 개 중 가까운 것으로 옮긴다. 폰 서랍의 옆 그림자 `18px 0 50px`은 방향이 달라서 `--shadow-drawer`로 따로 둔다.
- `--shadow-popover`의 `rgb()`는 일부러 테마와 상관없는 검정이다. 팝오버는 두 테마 모두 바탕보다 어둡게 떨어져 보여야 한다. 리터럴은 `tokens.css` 안에만 둔다.
- 테두리처럼 쓰는 `inset 0 0 0 1px <색 토큰>`(선택·포커스 고리)와 `0 0 8px var(--online-glow)`, `0 0 12px var(--online-glow)`(연결 점의 빛)은 그림자 토큰 밖으로 허용한다. 색은 토큰만 쓴다.

## 색

색은 `tokens.css`의 역할 토큰으로만 쓴다. 다른 CSS 파일에는 `#…`, `rgb()`, `hsl()` 리터럴을 두지 않는다. 투명도는 `color-mix(in srgb, var(--토큰) N%, transparent)`로 만든다.

| 역할 | 토큰 |
|---|---|
| 바탕 | `--page`, `--surface`, `--surface-raised`, `--navigator-surface`, `--hover-surface`, `--selected-surface` |
| 글자 | `--text`, `--muted`, `--control-text`, `--workspace-heading`, `--input-text` |
| 선 | `--line`, `--hover-line`, `--selected-border` |
| 강조·주 동작 | `--accent`, `--accent-hover`, `--accent-ink`(강조 바탕 위 글자) |
| 에이전트 상태 | `--working`, `--done`, `--status-ok`, `--status-attention`, `--offline`, `--agent-unknown` |
| 경고·위험 | `--warning`, `--danger` |
| 터미널 | `--terminal-bg`, `--terminal-text` (테마와 상관없이 어둡다) |
| 가림막·그림자 | `--scrim`, `--mobile-shadow` |
| 스크롤바 | `--scrollbar-*` |
| 찾기 강조 (UI-2에서 추가) | `--find-mark`, `--find-mark-current` |
| diff (UI-2에서 추가) | `--diff-add`, `--diff-del` |
| 위험 바탕 위 글자 (UI-2에서 추가) | `--danger-ink` |
| 문서 보기 바탕 (UI-2에서 추가) | `--viewer-page` |

- 새 색이 필요하면 다크·라이트 두 테마 값을 함께 `tokens.css`에 넣는다.
- 측정 당시 토큰 밖 리터럴과 옮길 토큰:

| 위치 | 지금 | 목표 |
|---|---|---|
| `public/styles.css` 찾기 표식 `--find-mark` | `#ffc799` | `--find-mark` 토큰을 `tokens.css`로 옮김(두 테마) |
| `public/chat/chat-view.css` 대화 찾기 강조 | `#ffb340`, `#ff9500` | 위와 같은 `--find-mark`, `--find-mark-current` |
| `public/chat/chat-view.css` diff 추가·삭제 | `#7ee2a8`, `#ff9a9a` | `--diff-add`, `--diff-del` 새 토큰(두 테마) |
| `public/styles.css` "removed" 배지 글자 | `#ffffff` | `--accent-ink`와 같은 성격의 `--danger-ink` |
| `public/styles.css` 문서 보기 바탕 `.viewer-document` | `#ffffff` | `--viewer-page` (문서가 스스로 흰 바탕을 가정하므로 두 테마 모두 흰색) |
| 대체값 `var(--accent, #99ffe4)`, `var(--danger, #e5484d)` | 리터럴 대체값 | 대체값 삭제 |
| 그림자 안의 `rgb(0 0 0 / 18%~35%)` (`public/styles.css`, `public/chat/chat-view.css`, `public/chat/prompt-card.css`) | 리터럴 | `--shadow-*` 토큰 |

에이전트 표식(`AGENT_MARKS` SVG, `public/app.js`)의 브랜드 색은 이 규칙에서 뺀다.

## 상태 표기

에이전트 상태는 네 가지(와 아직 모르는 `unknown`)이고, 어디서나 같은 이름·기호·색을 쓴다.

| 상태 | 글자 | 색 토큰 |
|---|---|---|
| `idle` | Idle | `--accent` |
| `working` | Working | `--working` |
| `blocked` | Needs your answer | `--danger` |
| `done` | Done | `--done` |
| `unknown` | Unknown | `--agent-unknown` (상태를 아직 모르는 패인) |

- 색은 `public/ui/components.css`의 `.ui-status.state-*`와 같다. `unknown`은 따로 규칙이 없고 기본 `.ui-status` 색을 쓴다.
- 글자는 `public/ui-model.js`의 상태 문구 함수 하나에서 나온다. 화면마다 따로 쓰지 않는다. 측정 당시 이 함수는 `idle`과 `unknown`을 소문자 그대로 돌려줬다. "Idle", "Unknown"으로 맞추는 일은 상태 글자 작업(N1/Q2)에서 한다.
- 공간이 없는 곳(사이드바 행 끝)에서는 기호만 두되, 같은 뜻의 글자를 `aria-label`과 `title`로 붙인다. 폰 헤더처럼 한 패인을 보여 주는 곳에는 글자를 보인다.
- 연결 상태(`connecting`, `offline`)는 에이전트 상태와 섞지 않는다.

## 터치와 입력

- 터치 기기(`@media (pointer: coarse)` 또는 `(hover: none)`)에서 누를 수 있는 것은 44×44px 이상이다. 보이는 크기가 작아야 하면 padding이나 `::before`로 누르는 영역만 넓힌다.
- 터치 기기의 텍스트 입력칸은 글자 16px 이상이다. 16px보다 작으면 iOS Safari가 포커스 때 화면을 확대한다. 컴포저는 터미널 글자 크기를 따르므로, 터치 기기에서는 `max(var(--font-input-touch), var(--terminal-font-size))`로 둔다.
- 마우스 전용 동작(hover로만 보이는 버튼)은 터치 기기에서 항상 보이게 하거나 다른 길을 둔다.
- 아이콘만 있는 버튼에는 `aria-label`을 둔다. 포커스는 `:focus-visible`에 `2px solid var(--accent)` 고리다(`public/ui/base.css`).

## 화면 너비

| 조건 | 뜻 |
|---|---|
| `max-width: 760px` | 폰 배치: 사이드바가 서랍이 되고 헤더가 한 줄 |
| `max-width: 520px` | 좁은 폰: 대화상자 폭, 터미널 패널 간격. 목표로 메뉴를 바텀시트로 바꾸는 기준(UI-4) |
| `min-width: 520px` | 전송 목록 행을 두 열로. 정확히 520px에서는 `max-width: 520px`와 함께 맞는다(UI-2에서 `min-width: 521px`로 정리) |
| `(pointer: coarse)` / `(hover: none)` | 터치 크기와 입력 규칙 |
| `(hover: hover) and (pointer: fine)` | 마우스 전용 표시(hover 버튼) |

새 너비 기준을 만들지 않는다. 다른 값이 필요하면 이 표를 고친다.

## 메뉴와 대화상자

- 메뉴: 데스크톱은 단추 옆 팝오버(`--radius-panel`, `--shadow-popover`, `--layer-popover`)다. 목표는 폰(520px 이하)에서 바텀시트(`--shadow-sheet`, 윗모서리 `--radius-panel`)로 그리는 것이다. 측정 당시에는 폰에서도 팝오버였다. 한 메뉴를 두 모양으로 그리고, 항목 마크업은 같다(UI-4).
- 위험한 항목은 `is-danger`로 표시하고 맨 아래에 둔다.
- 대화상자는 `dialog.app-dialog`와 `.dialog-form`을 쓴다. 앱의 대화상자는 제출을 JS로 처리하고, `form method="dialog"`는 `public/ui` 예제의 방식이다. 주 동작 버튼은 오른쪽 끝, 취소는 그 왼쪽이다. 측정 당시 Connect PC 대화상자(`#servers-dialog`)만 Close가 Save 오른쪽에 있었다(UI-4에서 맞춤).
- 클래스와 마크업은 `public/ui/README.md`의 HTML 인터페이스를 따른다.

## 움직임

| 토큰 | 값 | 쓰는 곳 |
|---|---|---|
| `--motion-fast` | 120ms | hover, 색 바뀜 |
| `--motion-base` | 180ms | 펼치기, 팝오버 열기 |
| `--motion-slow` | 280ms | 사이드바 서랍(`--sidebar-motion`과 같은 값) |

- 지금 쓰는 140ms·150ms → `--motion-fast` 또는 `--motion-base`, 220ms → `--motion-base` 또는 `--motion-slow`.
- 무한 반복 애니메이션은 진행 중 표시(스피너, 받아쓰기·작업 중 맥박)에만 쓰고, `prefers-reduced-motion: reduce`에서 멈춘다.
- 무한 반복 애니메이션에 `steps()`를 쓰지 않는다. 끊기는 움직임은 멈춘 화면처럼 보인다.
- 레이아웃 속성(`width`, `height`, `top`)보다 `transform`과 `opacity`를 움직인다.

## 문구

- UI 언어는 영어다. 문장형 대소문자(Sentence case)를 쓴다: "Sign out everywhere", "Back to grid".
- 버튼은 동사로 시작한다. 대화상자를 여는 버튼과 진행 중 문구에는 `…`(U+2026)을 붙인다: "Loading projects…".
- 오류 문구는 무슨 일이 있었는지와 다음에 할 일을 한 문장씩 쓴다. 느낌표를 쓰지 않는다.
- 같은 개념은 한 단어로 부른다: pane, tab, session, project, machine.

## 검사

`scripts/check-design.mjs`(UI-3)가 이 문서의 기계로 확인할 수 있는 규칙을 검사한다: 토큰 밖 색 리터럴, 토큰 밖 font-size·radius·z-index·shadow, 무한 애니메이션의 `steps()`. 그 전까지는 리뷰에서 이 문서를 기준으로 본다.
