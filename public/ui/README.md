# HerdRabbit HTML UI

현재 앱과 같은 CSS를 사용하는 독립 UI 모음입니다. `index.html`을 브라우저에서 열면 밝은/어두운 테마, 버튼, 입력, 상태별 탐색 항목, 메뉴, 대화상자와 복사 가능한 HTML을 확인할 수 있습니다. 앱 실행 중에는 `/ui/index.html`로 접근합니다.

## 다른 프로젝트에서 사용

이 폴더 전체를 복사하고 페이지에 연결합니다. npm, 빌드, 서버, 외부 폰트 다운로드는 필요하지 않습니다.

```html
<!doctype html>
<html lang="ko" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="./ui/ui.css">
</head>
<body>
  <button class="primary-button" type="button">저장</button>
  <label for="name">이름</label>
  <input class="ui-input" id="name">
</body>
</html>
```

`ui.css`가 같은 폴더의 `tokens.css`, `base.css`, `components.css`를 불러옵니다. 세 파일도 함께 배포해야 합니다. 예제 전용 `index.html`, `examples.css`, `examples.js`, 이 설명서는 제품 배포에서 제외해도 됩니다.

| 파일 | 책임 |
| --- | --- |
| tokens.css | 밝은/어두운 색상, 글꼴, 간격, 모서리 값 |
| base.css | 페이지 배경과 기본 글꼴, box-sizing, 포커스, 모션 줄이기 |
| components.css | 버튼·입력·메뉴·탐색 항목·사이드바·카드·대화상자 |
| examples.css / examples.js | 예제 페이지 배치와 시연 동작만 담당 |

`base.css`는 전역 요소의 기본 스타일을 설정합니다. 기존 사이트에 일부 UI만 추가하려면 `tokens.css`와 `components.css`를 개별 연결하고, 사이트에서 글꼴·box-sizing·키보드 포커스 스타일을 제공하세요. 클래스와 CSS 변수는 Shadow DOM으로 격리되지 않습니다.

## HTML 인터페이스

| 용도 | 클래스 / 상태 |
| --- | --- |
| 버튼 | `primary-button`, `secondary-button`, `ghost-button`, `icon-button` |
| 입력 | `ui-input` (텍스트 input, select) |
| 상태 표시 | `ui-status state-idle`, `state-working`, `state-blocked`, `state-done` |
| 탐색 항목 | `ui-nav-item` 안에 `ui-status`와 `ui-nav-copy`; 제목 strong, 보조 상태 small |
| 선택·강조 | `aria-pressed="true"` (배경만 강조) |
| 메뉴 | `details.ui-menu` → summary → `.ui-menu-panel` → button.ui-menu-item |
| 위험 작업 | 메뉴 항목에 `is-danger` |
| 사이드바 | `ui-sidebar` 안에 `ui-sidebar-heading`, `ui-sidebar-content`, `ui-sidebar-footer` |
| 카드 | `ui-card` |
| 대화상자 | `dialog.app-dialog` 안에 `form.dialog-form`, `dialog-heading`, `dialog-actions` |
| 상태 문구 | `dialog-feedback`, 오류는 `data-error="true"` |
| 연결 점 | `connection-dot`의 `data-state="online"` 또는 `"error"`; 별도 텍스트로 의미 제공 |

상태 배지는 색상 외에도 글자나 기호와 상태 문구를 함께 표시하세요. 아이콘만 있는 버튼에는 `aria-label`을, 입력에는 연결된 label을 둡니다. 메뉴는 기본 details/summary와 일반 버튼의 Tab 이동을 사용합니다. 전체 ARIA menu 키보드 모델을 구현하지 않았다면 `role="menu"`를 추가하지 않습니다.

사이드바의 모바일 열기/닫기, 탐색 항목의 실제 이동, 제출, 삭제, 인증, 저장소 연동은 사용하는 프로젝트가 담당합니다. `examples.js`는 시연용이므로 제품에서 로드하지 않습니다. 대화상자는 네이티브 `showModal()`과 `form method="dialog"`로 열고 닫을 수 있습니다.

```js
document.querySelector('#open').addEventListener('click', () => {
  document.querySelector('#dialog').showModal();
});
```

## 테마와 사용자화

`document.documentElement.dataset.theme = 'light'` 또는 `'dark'`로 전환합니다. 기본값은 dark이며, 이 UI 모음 자체는 localStorage나 시스템 테마를 읽지 않습니다. 기존 앱의 테마 저장 정책은 앱의 `theme.js`에 남아 있습니다.

색상과 간격을 바꾸려면 UI CSS 뒤에서 변수를 재정의합니다.

```css
:root { --radius-control: 10px; --space-2: 8px; }
:root[data-theme="dark"] { --accent: #99ffe4; }
:root[data-theme="light"] { --accent: #167454; }
```

기존 HerdRabbit의 `pane-button`, `pane-copy`, `sidebar-action-*`, `navigator*`, `login-card`는 같은 규칙의 호환 이름입니다. 새 프로젝트는 `ui-*` 이름을 사용하세요. 앱 전용 레이아웃·터미널·인증·SSH·알림 동작은 이 폴더에 포함하지 않습니다. 앱의 `styles.css`는 공통 UI 뒤에 로드됩니다.
