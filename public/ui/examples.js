// Demo behavior only; the UI styles have no JavaScript dependencies.
const themeSwitch = document.querySelector('#theme-switch');
themeSwitch.addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  themeSwitch.setAttribute('aria-pressed', String(light));
  themeSwitch.textContent = light ? '어두운 테마' : '밝은 테마';
});
const feedback = document.querySelector('#catalog-feedback');
for (const target of document.querySelectorAll('[data-source]')) {
  const preview = document.querySelector(`[data-example="${target.dataset.source}"]`);
  const source = preview.tagName === 'DIALOG' ? preview.outerHTML : preview.innerHTML.trim();
  const details = document.createElement('details');
  details.className = 'catalog-source';
  const summary = document.createElement('summary');
  summary.textContent = 'HTML 보기';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = source;
  pre.append(code);
  const copy = document.createElement('button');
  copy.type = 'button'; copy.className = 'ghost-button'; copy.textContent = 'HTML 복사';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(source); feedback.textContent = 'HTML을 복사했습니다.'; }
    catch { details.open = true; const range = document.createRange(); range.selectNodeContents(code);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      feedback.textContent = '코드를 선택했습니다. 복사 단축키 또는 브라우저 메뉴로 복사하세요.'; }
  });
  details.append(summary, pre, copy); target.append(details);
}
for (const item of document.querySelectorAll('.ui-nav-item')) item.addEventListener('click', () => {
  for (const other of document.querySelectorAll('.ui-nav-item')) other.setAttribute('aria-pressed', String(other === item));
});
const dialog = document.querySelector('#example-dialog');
document.querySelector('#open-dialog').addEventListener('click', () => dialog.showModal());
dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'save') feedback.textContent = '프로젝트 만들기 UI 예제를 완료했습니다.';
});
for (const button of document.querySelectorAll('.ui-menu-item')) button.addEventListener('click', () => {
  button.closest('details').open = false;
  feedback.textContent = `${button.textContent.trim()} 작업을 선택했습니다. 실제 데이터는 변경하지 않습니다.`;
});
// Demo: choosing a tab. The roving tabindex, arrow keys and edge arrows of a real strip are app/tab-strip.js.
for (const tab of document.querySelectorAll('[data-example="tabs"] .ui-tab')) tab.addEventListener('click', () => {
  for (const other of document.querySelectorAll('[data-example="tabs"] .ui-tab')) {
    other.setAttribute('aria-selected', String(other === tab));
    other.tabIndex = other === tab ? 0 : -1;
  }
});
