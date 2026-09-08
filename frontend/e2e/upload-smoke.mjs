// Production-bundle smoke test. No real account, receipt, or server is used.
// Run from the repository root after `npm --prefix frontend run build`:
//   npm --prefix frontend run preview -- --host 127.0.0.1 --port 4174 --strictPort
//   node frontend/e2e/upload-smoke.mjs
// Uses the already installed sync-agent Playwright; no dependency installation.
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from '../../sync-agent/node_modules/playwright/index.mjs'

const baseURL = process.env.ARRIVAL_SMOKE_URL || 'http://127.0.0.1:4174'
const origin = new URL(baseURL).origin
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname), 'Only loopback preview URLs are allowed')
const assets = await readdir(new URL('../dist/assets/', import.meta.url))
const workers = assets.filter((name) => /^barcode\.worker-.*\.js$/.test(name))
assert.equal(workers.length, 1, 'Build frontend/dist before running this test')
const workerPath = `/assets/${workers[0]}`
const nginxTemplate = await readFile(new URL('../../deploy/nginx/default.conf.template', import.meta.url), 'utf8')
const productionCSP = nginxTemplate.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1]
assert(productionCSP, 'Read the real production CSP from the deployment template')
assert(!productionCSP.includes('wasm-unsafe-eval'), 'This test must not relax production WASM restrictions')

async function deadline(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

async function poll(label, read, satisfied, milliseconds = 20_000) {
  const expires = Date.now() + milliseconds
  let latest
  while (Date.now() < expires) {
    latest = await deadline(read(), 5_000, label)
    if (satisfied(latest)) return latest
    await pause(50)
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(latest)}`)
}

async function localQueue(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('arrival-manager')
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const transaction = db.transaction('upload-queue', 'readonly')
      const request = transaction.objectStore('upload-queue').getAll()
      let rows = []
      request.onsuccess = () => {
        rows = request.result.map((item) => ({
          clientEventId: item.clientEventId, ownerUserId: item.ownerUserId,
          uploadState: item.uploadState, readyToUpload: item.readyToUpload,
          needsPreparation: item.needsPreparation, trackingNo: item.trackingNo,
          photoBytes: item.photo.size, attempts: item.attempts,
        }))
      }
      transaction.oncomplete = () => { db.close(); resolve(rows) }
      transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error || new Error('IDB smoke read failed')) }
    }
  }))
}

async function barcodeFixture(page, trackingNo) {
  // Standard Code 39 encodings. Generated pixels contain no private label data.
  const encodings = { '*': 0x094, S: 0x046, F: 0x058, Y: 0x190, T: 0x016,
    0: 0x034, 1: 0x121, 2: 0x061, 3: 0x160, 4: 0x031,
    5: 0x130, 6: 0x070, 7: 0x025, 8: 0x124, 9: 0x064 }
  const patterns = [...`*${trackingNo}*`].map((character) => encodings[character])
  assert(patterns.every(Number.isInteger))
  const fixture = await deadline(page.evaluate(async ({ patterns, workerPath }) => {
    const row = Array(40).fill(255)
    for (const pattern of patterns) {
      for (let bit = 8; bit >= 0; bit--) row.push(...Array(pattern & (1 << bit) ? 6 : 2).fill(bit % 2 === 0 ? 0 : 255))
      row.push(255, 255)
    }
    row.push(...Array(40).fill(255))
    const canvas = document.createElement('canvas')
    canvas.width = row.length * 2
    canvas.height = 240
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.fillStyle = 'white'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = 'black'
    row.forEach((value, x) => { if (value === 0) context.fillRect(x * 2, 24, 2, 192) })
    const png = canvas.toDataURL('image/png').split(',')[1]
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const startedAt = performance.now()
    const decoded = await new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, { type: 'module' })
      const finish = (value, error) => {
        clearTimeout(timer)
        worker.terminate()
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(null, new Error('Production worker timed out')), 7_000)
      worker.onmessage = (event) => finish(event.data?.trackingNo, null)
      worker.onerror = (event) => finish(null, new Error(event.message || 'Worker failed'))
      worker.postMessage({ width: pixels.width, height: pixels.height, buffer: pixels.data.buffer }, [pixels.data.buffer])
    })
    return { png, decoded, workerMilliseconds: Math.round(performance.now() - startedAt) }
  }, { patterns, workerPath }), 12_000, 'Real production worker recognition')
  assert.equal(fixture.decoded, trackingNo, 'The real built worker must decode the generated barcode')
  return fixture
}

async function smoke(name, browserType, cspMode) {
  let browser
  try { browser = await browserType.launch({ headless: true }) }
  catch (error) {
    if (name === 'webkit' && /Executable doesn't exist/.test(String(error.message))) {
      return { browser: name, cspMode, status: 'skipped', reason: 'Playwright WebKit binary is not installed; no download attempted' }
    }
    throw error
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const pageErrors = []
  const routingErrors = []
  const externalRequests = []
  const wasmResponses = []
  const wasmCompilations = []
  const consoleMessages = []
  const posts = []
  const pending = []
  const receipts = new Map()
  let mode = 'hold-next'
  let fixtureForPhoto = null
  page.on('pageerror', (error) => pageErrors.push(error.message))
  context.on('console', (message) => consoleMessages.push(message.text()))
  context.on('response', (response) => { if (/\/zbar-[^/]+\.wasm$/.test(response.url())) wasmResponses.push(response.status()) })

  // Observe compiled WebAssembly scripts without replacing library code or
  // changing CSP. A 200 response for .wasm alone does NOT prove compilation.
  let debuggerSession
  if (name === 'chromium') {
    debuggerSession = await context.newCDPSession(page)
    const pendingCommands = new Map()
    let commandId = 0
    const workerCommand = (sessionId, method) => new Promise((resolve, reject) => {
      const id = ++commandId
      pendingCommands.set(`${sessionId}:${id}`, { resolve, reject })
      void debuggerSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(reject)
    })
    debuggerSession.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
      const event = JSON.parse(message)
      if (event.id) {
        const command = pendingCommands.get(`${sessionId}:${event.id}`)
        pendingCommands.delete(`${sessionId}:${event.id}`)
        if (event.error) command?.reject(new Error(event.error.message))
        else command?.resolve(event.result)
      } else if (event.method === 'Debugger.scriptParsed' && event.params.scriptLanguage === 'WebAssembly') {
        wasmCompilations.push(event.params.url)
      }
    })
    debuggerSession.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
      void (async () => {
        if (targetInfo.type === 'worker') await workerCommand(sessionId, 'Debugger.enable')
        await workerCommand(sessionId, 'Runtime.runIfWaitingForDebugger')
      })().catch((error) => { if (!/closed|detached|No session/.test(error.message)) pageErrors.push(`Worker debugger: ${error.message}`) })
    })
    await debuggerSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false })
  }

  function receiptFor(post) {
    let receipt = receipts.get(post.eventId)
    if (!receipt) {
      receipt = { id: receipts.size + 1, client_event_id: post.eventId, tracking_no: post.trackingNo,
        captured_at: post.capturedAt, evidence_status: 'READY', match_status: 'UNMATCHED',
        operator_display_name: 'Smoke receiver', order_matches: [] }
      receipts.set(post.eventId, receipt)
    }
    return receipt
  }

  async function acknowledge(entry) {
    const replay = receipts.has(entry.post.eventId)
    const receipt = receiptFor(entry.post)
    await entry.route.fulfill({ status: replay ? 200 : 201, contentType: 'application/json',
      body: JSON.stringify({ receipt, created: !replay, idempotent_replay: replay }) })
  }

  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) {
      externalRequests.push(url.origin)
      await route.abort('blockedbyclient')
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      if (cspMode === 'production') {
        const response = await route.fetch({ maxRedirects: 0 })
        await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': productionCSP } })
      } else await route.continue()
      return
    }
    try {
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      if (url.pathname === '/api/auth/me') {
        await json({ user: { id: 5, username: 'smoke_receiver', display_name: 'Smoke receiver', role: 'RECEIVER' }, auth_required: true })
      } else if (url.pathname === '/api/receipts' && request.method() === 'POST') {
        const body = request.postDataBuffer()
        assert(body?.length, 'Upload must include multipart photo bytes')
        const form = await new Request(url, { method: 'POST', headers: { 'content-type': request.headers()['content-type'] }, body }).formData()
        const photo = form.get('photo')
        assert(photo && typeof photo !== 'string' && photo.size > 0, 'Multipart photo must be nonempty')
        const post = { eventId: form.get('client_event_id'), trackingNo: form.get('tracking_no'),
          capturedAt: form.get('captured_at'), photoBytes: photo.size, photoType: photo.type }
        assert.equal(typeof post.eventId, 'string')
        assert(post.eventId.length >= 8)
        posts.push(post)
        const entry = { route, post }
        if (mode === 'hold-next' || mode === 'accept-without-response') {
          if (mode === 'accept-without-response') receiptFor(post)
          pending.push(entry)
          mode = 'hold'
        } else if (mode === 'acknowledge') await acknowledge(entry)
        else pending.push(entry)
      } else if (url.pathname === '/api/receipts') {
        await json({ items: [...receipts.values()], total: receipts.size })
      } else if (url.pathname === '/api/dashboard/stats') {
        await json({ total_orders: 0, arrival_photos: receipts.size, matched_orders: 0, pending_orders: 0,
          unmatched_photos: receipts.size, account_count: 0 })
      } else if (/^\/api\/receipts\/[^/]+\/photo$/.test(url.pathname) && fixtureForPhoto) {
        await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(fixtureForPhoto, 'base64') })
      } else if (url.pathname === '/api/orders') {
        await json({ items: [], total: 0, limit: 20, offset: 0 })
      } else {
        throw new Error(`Unexpected mocked API request: ${request.method()} ${url.pathname}`)
      }
    } catch (error) {
      routingErrors.push(error.message)
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Smoke routing failed' }) }).catch(() => undefined)
    }
  })

  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
    const camera = page.locator('input[capture="environment"]')
    await poll('Camera available after local bootstrap', () => camera.isEnabled(), Boolean)
    const first = await barcodeFixture(page, 'SF1234567890')
    const second = await barcodeFixture(page, 'YT9876543210')
    const fixtureWasmCompilations = wasmCompilations.length
    const fixtureFallbackWarnings = consoleMessages.filter((message) => message.includes('RSS Expanded reader IS NOT ready')).length
    if (name === 'chromium' && cspMode === 'production') {
      assert.equal(fixtureWasmCompilations, 0, 'Production CSP must still prevent WASM compilation')
      assert(fixtureFallbackWarnings >= 2, 'Both worker fixtures must reach the real ZXing fallback under production CSP')
    } else if (name === 'chromium') {
      assert(fixtureWasmCompilations >= 2, 'Unrestricted local preview must actually compile the two real WASM modules')
      assert.equal(fixtureFallbackWarnings, 0, 'Preview fixture recognition must be resolved by ZBar before ZXing fallback')
    }
    fixtureForPhoto = first.png

    await camera.setInputFiles({ name: 'synthetic-first.png', mimeType: 'image/png', buffer: Buffer.from(first.png, 'base64') })
    await poll('First upload reaches held POST', async () => posts.length, (count) => count === 1)
    await poll('Camera enabled while first POST has no response', () => camera.isEnabled(), Boolean)
    assert.equal(pending.length, 1)
    assert.equal(receipts.size, 0)

    await camera.setInputFiles({ name: 'synthetic-second.png', mimeType: 'image/png', buffer: Buffer.from(second.png, 'base64') })
    const durable = await poll('Both originals durable before first acknowledgement', () => localQueue(page), (rows) => rows.length === 2)
    await poll('Camera enabled after second durable original', () => camera.isEnabled(), Boolean)
    assert.equal(posts.length, 1, 'Second capture must be accepted without needing the held first upload to finish')
    assert(durable.every((item) => item.photoBytes > 0 && item.ownerUserId === '5'))
    assert.equal(new Set(durable.map((item) => item.clientEventId)).size, 2)
    assert(durable.some((item) => item.uploadState === 'UPLOADING'))
    assert(durable.some((item) => item.uploadState === 'QUEUED' && item.needsPreparation))
    const layout = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowingControls: [...document.querySelectorAll('button, .camera-button, .gallery-button')]
        .map((element) => ({ text: element.textContent?.trim().slice(0, 60), rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1))
        .map(({ text }) => text),
    }))
    assert(layout.documentWidth <= layout.viewportWidth, 'The mobile page must not overflow horizontally')
    assert.deepEqual(layout.overflowingControls, [], 'Camera and other controls must fit the mobile viewport')
    let screenshot
    if (name === 'chromium' && cspMode === 'production') {
      await mkdir(new URL('../../artifacts/', import.meta.url), { recursive: true })
      screenshot = fileURLToPath(new URL('../../artifacts/upload-smoke-20260908.png', import.meta.url))
      await page.screenshot({ path: screenshot, fullPage: false })
      await page.screenshot({ path: fileURLToPath(new URL('../../artifacts/upload-smoke-20260908-full.png', import.meta.url)), fullPage: true })
    }

    mode = 'acknowledge'
    await acknowledge(pending.shift())
    await poll('Both confirmed uploads clear the real IndexedDB queue', () => localQueue(page), (rows) => rows.length === 0)
    assert.equal(receipts.size, 2)
    assert.equal(posts.length, 2)
    assert.deepEqual(new Set(posts.map((post) => post.eventId)), new Set(durable.map((item) => item.clientEventId)))
    assert.deepEqual(posts.map((post) => post.trackingNo), ['SF1234567890', 'YT9876543210'])

    // Simulate a server commit whose response never reached the phone. Reload
    // must replay the same durable event ID, not create a duplicate receipt.
    mode = 'accept-without-response'
    await camera.setInputFiles({ name: 'synthetic-refresh.png', mimeType: 'image/png', buffer: Buffer.from(first.png, 'base64') })
    await poll('Third request is accepted but its response is held', async () => posts.length, (count) => count === 3)
    const beforeReload = await localQueue(page)
    assert.equal(beforeReload.length, 1)
    const retriedEventId = beforeReload[0].clientEventId
    assert.equal(receipts.size, 3)
    mode = 'acknowledge'
    await page.reload({ waitUntil: 'domcontentloaded' })
    await poll('Reload replays and clears the original event', () => localQueue(page), (rows) => rows.length === 0)
    assert.equal(posts.filter((post) => post.eventId === retriedEventId).length, 2)
    assert.equal(receipts.size, 3, 'An uncertain-response replay must not create another receipt')
    for (const entry of pending.splice(0)) await entry.route.abort('aborted').catch(() => undefined)

    assert(wasmResponses.some((status) => status === 200), 'Real production WASM asset must load successfully')
    assert.deepEqual(externalRequests, [], 'No request may leave the local preview origin')
    assert.deepEqual(routingErrors, [], 'All mocked API routes must succeed')
    assert.deepEqual(pageErrors, [], 'No uncaught page exception is allowed')
    return { browser: name, cspMode, status: 'passed', viewport: '390x844', realWorker: workerPath,
      workerRecognitions: [first.decoded, second.decoded], workerMilliseconds: [first.workerMilliseconds, second.workerMilliseconds],
      wasmAssetLoaded: true, fixtureWasmCompilations, fixtureZXingFallbacks: fixtureFallbackWarnings,
      recognitionPath: cspMode === 'production' ? 'ZXing fallback; production CSP preserved' : 'ZBar WASM; local preview only',
      screenshot, horizontalOverflow: false,
      originalsDurableWhileFirstPostHung: durable.length, uniqueInitialEventIds: 2,
      postAttempts: posts.length, confirmedUniqueReceipts: receipts.size, reloadReusedEventId: true, finalQueueCount: 0 }
  } finally {
    if (debuggerSession) await debuggerSession.detach().catch(() => undefined)
    await context.close()
    await browser.close()
  }
}

const results = []
for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  for (const cspMode of ['preview', 'production']) {
    try { results.push(await smoke(name, browserType, cspMode)) }
    catch (error) { results.push({ browser: name, cspMode, status: 'failed', error: error.stack || error.message }); process.exitCode = 1 }
  }
}
console.log(JSON.stringify({ preview: origin, results }, null, 2))
