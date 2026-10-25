import { app, BrowserWindow, WebContentsView } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TabManager } from '../../src/main/browser/tab-manager'
import { runFromBridge } from '../../src/main/browser/human-activity'
const mode = process.env.LOAD_MODE!
app.setPath('userData', join(__dirname, `load-${mode}-profile-v4`))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function bounded<T>(p: Promise<T>, ms = 3000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([p, new Promise<null>(r => { timer = setTimeout(() => r(null), ms) })]) }
  finally { clearTimeout(timer!) }
}
const rows: any[] = []
app.whenReady().then(async () => {
  setTimeout(() => app.exit(3), 160000).unref()
  const win = new BrowserWindow({ width: 850, height: 650, show: false, title: `삼바 다중 탭 표시 검증 ${mode}` })
  win.showInactive()
  const manager = new TabManager(win)
  const m = manager as any
  m.emit = () => {}
  m.noteVisit = () => {}
  manager.setLayout({ x: 0, y: 0, width: 800, height: 560, viewportWidth: 800, viewportHeight: 560 })
  const tabs = Array.from({ length: 64 }, (_, i) => ({ id: `load-${i}`, profile: 'qa', mobile: false,
    view: new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } }) }))
  m.tabs = tabs
  const sites = ['https://www.ssg.com/', 'https://www.lemouton.co.kr/', 'https://www.lotteon.com/p/display/main/lotteon']
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]
    win.contentView.addChildView(tab.view, 0)
    tab.view.setBounds({ x: 0, y: 0, width: 800, height: 560 })
    await bounded(tab.view.webContents.loadURL(i < sites.length ? sites[i] : 'data:text/html,' + encodeURIComponent(
      `<body style="background:#3878b8;font:28px sans-serif"><h1>응답 검사 ${i}</h1><button onclick="this.textContent='완료'">조회</button><script>setInterval(()=>document.body.dataset.tick=Date.now(),100)</script></body>`
    )).catch(() => undefined), i < sites.length ? 20000 : 3000)
    if (i < 16) { m.laneIds.add(tab.id); m.laneTouchedAt.set(tab.id, Date.now()) }
    else win.contentView.removeChildView(tab.view)
    console.log('loaded', i)
  }
  manager.activate(tabs[0].id, { by: 'user' })
  for (let i = 1; i < 16; i++) m.sizeHidden(tabs[i])
  let running = true
  const bg = (async () => {
    let n = 0
    while (running) {
      const tab = tabs[12 + n % 4]
      const start = performance.now()
      const img = await bounded(runFromBridge('qa-load', () => (mode === 'before' ? manager.withFront.bind(manager) : manager.withCapture.bind(manager))(tab.id, async () => { await sleep(100); return tab.view.webContents.capturePage() })))
      rows.push({ type: 'background', ms: performance.now() - start, size: img?.getSize() ?? null })
      n++
      await sleep(100)
    }
  })()
  for (let i = 0; i < 48; i++) {
    const tab = tabs[i % 12]
    const start = performance.now()
    manager.activate(tab.id, { by: 'user' })
    const activateMs = performance.now() - start
    const frame = await bounded(tab.view.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>r(true)))'))
    const img = await bounded((mode === 'before' ? manager.withFront.bind(manager) : manager.withCapture.bind(manager))(tab.id, async () => { await sleep(100); return tab.view.webContents.capturePage() }))
    rows.push({ type: 'foreground', i, activateMs, ms: performance.now() - start, frame,
      size: img?.getSize() ?? null, local: i % 12 >= 3,
      pixel: img && !img.isEmpty() ? Array.from(img.toBitmap().subarray(0, 4)) : null })
    await sleep(30)
  }
  running = false
  await bg
  const percentile = (v: number[], q: number) => v.sort((a, b) => a - b)[Math.floor((v.length - 1) * q)]
  const fg = rows.filter(r => r.type === 'foreground')
  const result = { mode, tabs: tabs.length, foreground: fg.length, background: rows.length - fg.length,
    activateMedianMs: percentile(fg.map(r => r.activateMs), .5), activateP95Ms: percentile(fg.map(r => r.activateMs), .95),
    responseMedianMs: percentile(fg.map(r => r.ms), .5), responseP95Ms: percentile(fg.map(r => r.ms), .95),
    invalidCaptures: rows.filter(r => !r.size || r.size.width <= 0 || r.size.height <= 0).length,
    localWrongPixels: fg.filter(r => r.local && (!r.pixel || r.pixel[0] !== 184 || r.pixel[1] !== 120 || r.pixel[2] !== 56)).length,
    rows }
  writeFileSync(join(__dirname, `load-${mode}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, rows: undefined }))
  manager.dispose()
  for (const tab of tabs) tab.view.webContents.close()
  win.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
