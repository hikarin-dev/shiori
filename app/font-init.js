(function () {
  try {
    const c = JSON.parse(localStorage.getItem('shiori-font') || 'null');
    if (c?.css) {
      const s = document.createElement('style');
      s.id = 'jb-mono-cache';
      s.textContent = c.css;
      document.head.appendChild(s);
      return;
    }
  } catch {}
  // No cache — fall back to Google Fonts
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap';
  document.head.appendChild(link);
})();
