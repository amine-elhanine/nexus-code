const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const files = [
  'exact-uploaded-n',
  'nexus-obsidian-n'
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      offscreen: true
    }
  });

  for (const name of files) {
    const svgPath = path.resolve(__dirname, `assets/icon-proposals/${name}.svg`);
    await win.loadFile(svgPath);
    await new Promise(r => setTimeout(r, 400));
    const image = await win.capturePage({ x: 0, y: 0, width: 512, height: 512 });
    const outPath = path.resolve(__dirname, `assets/icon-proposals/${name}.png`);
    fs.writeFileSync(outPath, image.toPNG());
    console.log(`Rendered: ${name}.png`);
  }

  app.quit();
});
