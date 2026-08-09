import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173/'
const outputDirectory =
  process.env.VISUAL_OUTPUT ?? '/private/tmp/tic-tac-toe-visual'
const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean)
const executablePath = chromeCandidates.find((candidate) =>
  existsSync(candidate),
)

assert(executablePath, 'Chrome or Chromium is required for visual checks')
await mkdir(outputDirectory, { recursive: true })

const browser = await chromium.launch({
  executablePath,
  headless: true,
})

async function openCheckedPage(name, viewport, options = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: options.isMobile ?? false,
    hasTouch: options.hasTouch ?? false,
  })
  const page = await context.newPage()
  const browserErrors = []

  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    browserErrors.push(error.message)
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('grid', { name: 'Tic tac toe board' }).waitFor()

  const layout = await page.evaluate(() => {
    const board = document.querySelector('.game-board')
    const boardRect = board?.getBoundingClientRect()

    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      boardWidth: boardRect?.width ?? 0,
      boardHeight: boardRect?.height ?? 0,
      cells: document.querySelectorAll('[role="gridcell"]').length,
    }
  })

  assert.equal(browserErrors.length, 0, `${name} emitted browser errors`)
  assert.equal(layout.cells, 9, `${name} should render nine cells`)
  assert(
    layout.documentWidth <= layout.viewportWidth,
    `${name} has horizontal overflow`,
  )
  assert(
    Math.abs(layout.boardWidth - layout.boardHeight) <= 1,
    `${name} board is not square`,
  )

  return { browserErrors, context, layout, page }
}

try {
  const desktop = await openCheckedPage('desktop', {
    width: 1440,
    height: 1000,
  })
  await desktop.page.screenshot({
    path: `${outputDirectory}/desktop-initial.png`,
    fullPage: true,
  })

  for (const cellName of [
    'Top left, empty',
    'Middle left, empty',
    'Top center, empty',
    'Center, empty',
    'Top right, empty',
  ]) {
    await desktop.page
      .getByRole('gridcell', { name: cellName, exact: true })
      .click()
  }

  await desktop.page
    .getByRole('heading', { name: 'Crosses win', exact: true })
    .waitFor()
  await desktop.page.getByLabel('Crosses: 1 point').waitFor()
  await desktop.page.waitForTimeout(800)
  await desktop.page.screenshot({
    path: `${outputDirectory}/desktop-win.png`,
    fullPage: true,
  })

  await desktop.page
    .getByRole('button', { name: 'Next round', exact: true })
    .click()
  await desktop.page
    .getByRole('heading', { name: 'Circles to move', exact: true })
    .waitFor()
  assert.equal(
    desktop.browserErrors.length,
    0,
    'desktop interactions emitted browser errors',
  )
  await desktop.context.close()

  const mobile = await openCheckedPage(
    'mobile',
    { width: 390, height: 844 },
    { isMobile: true, hasTouch: true },
  )
  await mobile.page.screenshot({
    path: `${outputDirectory}/mobile-viewport.png`,
  })
  await mobile.page.screenshot({
    path: `${outputDirectory}/mobile-full.png`,
    fullPage: true,
  })
  await mobile.context.close()

  const narrow = await openCheckedPage(
    'narrow mobile',
    { width: 320, height: 700 },
    { isMobile: true, hasTouch: true },
  )
  await narrow.context.close()

  console.log(
    JSON.stringify(
      {
        outputDirectory,
        desktop: desktop.layout,
        mobile: mobile.layout,
        narrow: narrow.layout,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
