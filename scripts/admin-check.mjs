import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4173/'
const operatorKey = process.env.ADMIN_API_KEY
const outputDirectory =
  process.env.VISUAL_OUTPUT ?? '/private/tmp/tic-tac-toe-admin'
const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean)
const executablePath = chromeCandidates.find((candidate) =>
  existsSync(candidate),
)

assert(operatorKey, 'ADMIN_API_KEY is required for the admin check')
assert(executablePath, 'Chrome or Chromium is required for the admin check')
await mkdir(outputDirectory, { recursive: true })

const browser = await chromium.launch({
  executablePath,
  headless: true,
})
const browserErrors = []

function monitorPage(page, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(`${label}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    browserErrors.push(`${label}: ${error.message}`)
  })
}

async function readLayout(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    metricCount: document.querySelectorAll('.history-metric').length,
    eventRows: document.querySelectorAll('.history-events tbody tr').length,
  }))
}

try {
  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  const desktopPage = await desktopContext.newPage()
  monitorPage(desktopPage, 'desktop')
  await desktopPage.goto(new URL('/admin', baseUrl).toString(), {
    waitUntil: 'networkidle',
  })
  await desktopPage.getByLabel('Operator key').fill(operatorKey)
  await desktopPage
    .getByRole('button', { name: 'Open history', exact: true })
    .click()
  await desktopPage
    .getByRole('heading', { name: 'Match activity', exact: true })
    .waitFor()
  const desktopLayout = await readLayout(desktopPage)
  assert.equal(desktopLayout.metricCount, 8)
  assert(desktopLayout.eventRows >= 1)
  assert(desktopLayout.documentWidth <= desktopLayout.viewportWidth)
  await desktopPage.screenshot({
    path: `${outputDirectory}/desktop-history.png`,
    fullPage: true,
  })

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const mobilePage = await mobileContext.newPage()
  monitorPage(mobilePage, 'mobile')
  await mobilePage.addInitScript(
    ([storageKey, key]) => {
      window.sessionStorage.setItem(storageKey, key)
    },
    ['tic-tac-toe:operator-key', operatorKey],
  )
  await mobilePage.goto(new URL('/admin', baseUrl).toString(), {
    waitUntil: 'networkidle',
  })
  await mobilePage
    .getByRole('heading', { name: 'Match activity', exact: true })
    .waitFor()
  const mobileLayout = await readLayout(mobilePage)
  assert.equal(mobileLayout.metricCount, 8)
  assert(mobileLayout.documentWidth <= mobileLayout.viewportWidth)
  await mobilePage.screenshot({
    path: `${outputDirectory}/mobile-history.png`,
    fullPage: true,
  })

  assert.deepEqual(browserErrors, [])
  await mobileContext.close()
  await desktopContext.close()

  console.log(
    JSON.stringify(
      {
        outputDirectory,
        desktop: desktopLayout,
        mobile: mobileLayout,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
