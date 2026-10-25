import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

for (const scenario of ['available', 'busy-lane-available', 'busy', 'wrong-lane', 'unauthorized']) {
  test(`연결 검사: ${scenario}`, async (t) => {
    const requests = []
    const server = createServer((req, res) => {
      requests.push([req.method, req.url, req.headers['x-samba-lane']])
      req.resume()
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
      }
      if (req.headers['x-samba-token'] !== 'test-only') return send(401, {})
      if (req.url === '/health') return scenario === 'available'
        ? send(200, { ok: true, tools: ['login', 'get_page'] })
        : send(scenario === 'unauthorized' ? 401 : 409, {})
      if (scenario === 'busy') return send(409, { error: 'busy' })
      send(200, { ok: true, lane: scenario === 'wrong-lane' ? 'other' : 'keeper-health', result: '[]' })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const dir = mkdtempSync(join(tmpdir(), 'keeper-health-'))
    const config = join(dir, 'config.json')
    writeFileSync(config, JSON.stringify({ bridgeEnabled: true, bridgeToken: 'test-only', bridgePort: server.address().port }))
    const old = process.env.SAMBA_BROWSER_CONFIG
    process.env.SAMBA_BROWSER_CONFIG = config
    t.after(async () => {
      if (old === undefined) delete process.env.SAMBA_BROWSER_CONFIG
      else process.env.SAMBA_BROWSER_CONFIG = old
      await new Promise((resolve) => server.close(resolve))
      unlinkSync(config)
      rmdirSync(dir)
    })
    const bridge = await import(`./bridge.mjs?${scenario}`)
    if (scenario === 'busy') await assert.rejects(bridge.health(), bridge.BridgeBusy)
    else assert.deepEqual(await bridge.health(), scenario === 'available' ? ['login', 'get_page']
      : scenario === 'busy-lane-available' ? ['list_tabs'] : null)
    if (scenario === 'busy-lane-available') assert.deepEqual(requests[1], ['POST', '/tool/list_tabs', 'keeper-health'])
    if (scenario === 'unauthorized') assert.equal(requests.length, 1)
    assert.ok(requests.every(([, url]) => url === '/health' || url === '/tool/list_tabs'))
  })
}
