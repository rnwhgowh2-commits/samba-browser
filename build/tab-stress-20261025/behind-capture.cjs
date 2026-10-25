const { app, BrowserWindow, WebContentsView } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
app.setPath('userData', path.join(__dirname, 'behind-capture-data'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function bounded(p) { let t; try { return await Promise.race([p, new Promise(r => t=setTimeout(()=>r(null),1500))]) } finally { clearTimeout(t) } }
app.whenReady().then(async () => {
  setTimeout(() => app.exit(3), 65000).unref()
  const win = new BrowserWindow({ width: 700, height: 500, show: false, title: '삼바 뒤 탭 캡처 격리 검증' })
  win.showInactive()
  const shown = new WebContentsView({ webPreferences: { backgroundThrottling: true } })
  const bg = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  for (const v of [shown, bg]) { win.contentView.addChildView(v); v.setBounds({ x: 0, y: 0, width: 650, height: 450 }) }
  await bounded(shown.webContents.loadURL('data:text/html,<body style="background:lightgreen">전경'))
  await bounded(bg.webContents.loadURL('data:text/html,<body style="background:lightblue">배경'))
  win.contentView.addChildView(shown)
  const rows = []
  for (const mode of ['background-false', 'capture-managed', 'capture-managed']) {
    for (let i=0;i<6;i++) {
      await bounded(bg.webContents.loadURL('data:text/html,'+encodeURIComponent(`<body style="background:rgb(50,100,150)">배경 문서 ${i}</body>`)))
      if (mode==='capture-managed') bg.webContents.setBackgroundThrottling(true)
      await sleep(50)
      const start=performance.now()
      const img=await bounded(bg.webContents.capturePage())
      rows.push({mode,i,ms:performance.now()-start,size:img?.getSize(),pixel:img&&!img.isEmpty()?Array.from(img.toBitmap().subarray(0,4)):null,topIsShown:win.contentView.children.at(-1)===shown})
      if (mode==='capture-managed') {
        win.contentView.removeChildView(bg)
        bg.webContents.setBackgroundThrottling(false)
        win.contentView.addChildView(bg,0)
      }
    }
  }
  writeFileSync(path.join(__dirname,'behind-capture.json'),JSON.stringify(rows,null,2))
  console.log(JSON.stringify(rows))
  shown.webContents.close();bg.webContents.close();win.destroy();app.exit(0)
}).catch(e=>{console.error(e);app.exit(1)})
