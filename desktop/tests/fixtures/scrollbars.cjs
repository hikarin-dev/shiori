const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', process.env.SHIORI_SCROLLBAR_TEST_PROFILE);
setTimeout(() => app.exit(1), 20000).unref();

app.whenReady().then(async () => {
  ipcMain.on('shiori:config', event => { event.returnValue = {}; });
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { preload: path.resolve(__dirname, '../../preload.cjs'), contextIsolation: true, sandbox: true } });
  try {
    await win.loadURL(process.env.SHIORI_SCROLLBAR_TEST_URL);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const { customScrollbarAvailable, applyScrollbarPreference } = await import('/scrollbar.js');
      const measure = () => ({ pageGutter: innerWidth - document.documentElement.clientWidth,
        panelGutter: panel.offsetWidth - panel.clientWidth,
        overlays: document.querySelectorAll('.scrollbar-host').length,
        gutter: getComputedStyle(document.documentElement).scrollbarGutter });
      const native = measure();
      localStorage.setItem('shiori:customScrollbar', 'true');
      applyScrollbarPreference();
      await new Promise(requestAnimationFrame);
      const custom = measure();
      localStorage.setItem('shiori:customScrollbar', 'false');
      applyScrollbarPreference();
      return { available: customScrollbarAvailable, native, custom, restored: measure() };
    })()`);
    result.zooms = [];
    for (const factor of [1, .5, .67, .8, .9, 1.1, 1.25, 1.5, 2, 1]) {
      win.webContents.setZoomFactor(factor);
      const geometry = await win.webContents.executeJavaScript(`(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const root = document.documentElement;
        return { dpr: devicePixelRatio,
          occupied: innerWidth - root.clientWidth,
          reserved: parseFloat(getComputedStyle(root).getPropertyValue('--page-scrollbar-width')),
          customWidth: getComputedStyle(root, '::-webkit-scrollbar').width };
      })()`);
      const image = await win.webContents.capturePage();
      const { width, height } = image.getSize(), pixels = image.getBitmap();
      let paintedRail = 0;
      for (let x = width - 1; x >= 0; x--) {
        const pixel = (Math.floor(height / 2) * width + x) * 4;
        if (pixels[pixel] !== 23 || pixels[pixel + 1] !== 23 || pixels[pixel + 2] !== 23) break;
        paintedRail++;
      }
      result.zooms.push({ factor, ...geometry, paintedRail });
    }
    fs.writeFileSync(process.env.SHIORI_SCROLLBAR_TEST_RESULT, JSON.stringify(result));
  } finally { win.destroy(); app.quit(); }
}).catch(error => {
  fs.writeFileSync(process.env.SHIORI_SCROLLBAR_TEST_RESULT, JSON.stringify({ error: error.stack }));
  app.exit(1);
});
