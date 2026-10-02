// titlebar-preload.cjs — the title bar strip's link to the main process: going back and forward in
// its window, and the state it shows.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shioriTitlebar', {
  back: () => ipcRenderer.send('titlebar:back'),
  forward: () => ipcRenderer.send('titlebar:forward'),
  onState: (cb) => ipcRenderer.on('titlebar:state', (_event, state) => cb(state)),
});
