// titlebar.js — the title bar strip: back and forward through the window's pages, and the page's
// title, as the main process reports them.
const back = document.getElementById('back');
const forward = document.getElementById('forward');
const title = document.getElementById('title');

back.addEventListener('click', () => window.shioriTitlebar.back());
forward.addEventListener('click', () => window.shioriTitlebar.forward());
window.shioriTitlebar.onState((state) => {
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  back.title = back.ariaLabel = state.labels.back;
  forward.title = forward.ariaLabel = state.labels.forward;
  title.textContent = state.title || '';
});
