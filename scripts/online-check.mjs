import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173/'
const outputDirectory =
  process.env.VISUAL_OUTPUT ?? '/private/tmp/tic-tac-toe-online'
const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean)
const executablePath = chromeCandidates.find((candidate) =>
  existsSync(candidate),
)

assert(executablePath, 'Chrome or Chromium is required for online checks')
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

async function playMove(playerPage, observerPage, emptyName, markedName) {
  await playerPage
    .getByRole('gridcell', { name: emptyName, exact: true })
    .click()
  await observerPage
    .getByRole('gridcell', { name: markedName, exact: true })
    .waitFor()
}

try {
  const hostContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  const guestContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  const hostPage = await hostContext.newPage()
  const guestPage = await guestContext.newPage()
  monitorPage(hostPage, 'host')
  monitorPage(guestPage, 'guest')

  await hostPage.goto(baseUrl, { waitUntil: 'networkidle' })
  await hostPage.getByRole('tab', { name: 'Online', exact: true }).click()
  await hostPage
    .getByRole('heading', { name: 'Room directory', exact: true })
    .waitFor()
  await hostPage
    .getByRole('button', { name: 'Create room', exact: true })
    .click()
  const publicCreateDialog = hostPage.getByRole('dialog', {
    name: 'Create room',
  })
  await publicCreateDialog.getByLabel('Display name').fill('Alex')
  await publicCreateDialog.getByLabel('Room name').fill('Open table')
  await publicCreateDialog
    .getByRole('button', { name: 'Create room', exact: true })
    .click()
  await hostPage
    .getByRole('heading', { name: 'Waiting for opponent', exact: true })
    .waitFor()

  await guestPage.goto(baseUrl, { waitUntil: 'networkidle' })
  await guestPage.getByRole('tab', { name: 'Online', exact: true }).click()
  await guestPage
    .getByRole('heading', { name: 'Open table', exact: true })
    .waitFor()
  await guestPage.screenshot({
    path: `${outputDirectory}/public-directory.png`,
    fullPage: true,
  })

  const mobilePreviewContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const mobilePreviewPage = await mobilePreviewContext.newPage()
  monitorPage(mobilePreviewPage, 'mobile opponent preview')
  await mobilePreviewPage.goto(baseUrl, { waitUntil: 'networkidle' })
  await mobilePreviewPage
    .getByRole('tab', { name: 'Online', exact: true })
    .click()
  await mobilePreviewPage
    .getByRole('button', { name: 'Join Open table', exact: true })
    .click()
  const mobilePreviewDialog = mobilePreviewPage.getByRole('dialog', {
    name: 'Open table',
  })
  await mobilePreviewDialog
    .getByText('Opponent', { exact: true })
    .waitFor()
  const mobilePreviewLayout = await mobilePreviewPage.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  assert(
    mobilePreviewLayout.documentWidth <= mobilePreviewLayout.viewportWidth,
  )
  await mobilePreviewPage.screenshot({
    path: `${outputDirectory}/mobile-opponent-preview.png`,
    fullPage: true,
  })
  await mobilePreviewContext.close()

  await guestPage
    .getByRole('button', { name: 'Join Open table', exact: true })
    .click()
  const publicJoinDialog = guestPage.getByRole('dialog', {
    name: 'Open table',
  })
  await publicJoinDialog.getByText('Opponent', { exact: true }).waitFor()
  await publicJoinDialog.getByText('Alex', { exact: true }).waitFor()
  await publicJoinDialog.getByText('0W 0L 0D', { exact: true }).waitFor()
  await publicJoinDialog.getByLabel('Display name').fill('Sam')
  await publicJoinDialog
    .getByRole('button', { name: 'Join room', exact: true })
    .click()
  await Promise.all([
    hostPage.getByText('Both players connected', { exact: true }).waitFor(),
    guestPage.getByText('Both players connected', { exact: true }).waitFor(),
  ])

  await hostPage
    .getByRole('button', { name: 'Leave room', exact: true })
    .click()
  await Promise.all([
    hostPage
      .getByRole('heading', { name: 'Room directory', exact: true })
      .waitFor(),
    guestPage
      .getByRole('heading', { name: 'Room directory', exact: true })
      .waitFor(),
  ])

  await hostPage
    .getByRole('button', { name: 'Create room', exact: true })
    .click()
  const privateCreateDialog = hostPage.getByRole('dialog', {
    name: 'Create room',
  })
  await privateCreateDialog.getByLabel('Display name').fill('Alex')
  await privateCreateDialog.getByLabel('Room name').fill('Evening match')
  await privateCreateDialog
    .getByRole('button', { name: 'Private', exact: true })
    .click()
  await privateCreateDialog
    .getByLabel('Password')
    .fill('correct-horse')
  await privateCreateDialog
    .getByRole('button', { name: 'Create room', exact: true })
    .click()
  await hostPage
    .getByRole('heading', { name: 'Waiting for opponent', exact: true })
    .waitFor()

  const roomCode = await hostPage
    .locator('[data-room-code]')
    .getAttribute('data-room-code')
  assert(roomCode, 'Host room code was not rendered')
  assert.match(roomCode, /^[A-HJ-NP-Z2-9]{6}$/)
  await hostPage.screenshot({
    path: `${outputDirectory}/private-host-waiting.png`,
    fullPage: true,
  })
  await guestPage.getByRole('tab', { name: /Private/ }).click()
  await guestPage
    .getByRole('heading', { name: 'Evening match', exact: true })
    .waitFor()
  await guestPage
    .getByRole('button', {
      name: 'Join Evening match',
      exact: true,
    })
    .waitFor()
  await guestPage.screenshot({
    path: `${outputDirectory}/private-directory.png`,
    fullPage: true,
  })

  const inviteUrl = new URL(baseUrl)
  inviteUrl.searchParams.set('room', roomCode)
  await guestPage.goto(inviteUrl.toString(), { waitUntil: 'networkidle' })
  const privateJoinDialog = guestPage.getByRole('dialog', {
    name: 'Evening match',
  })
  await privateJoinDialog.waitFor()
  await privateJoinDialog.getByLabel('Display name').fill('Sam')
  await privateJoinDialog.getByLabel('Password').fill('wrong-password')
  await privateJoinDialog
    .getByRole('button', { name: 'Join room', exact: true })
    .click()
  await privateJoinDialog
    .getByText('That password is incorrect.', { exact: true })
    .waitFor()
  await guestPage.screenshot({
    path: `${outputDirectory}/private-password-error.png`,
    fullPage: true,
  })
  await privateJoinDialog.getByLabel('Password').fill('correct-horse')
  await privateJoinDialog
    .getByRole('button', { name: 'Join room', exact: true })
    .click()

  await hostPage
    .getByRole('heading', { name: 'Your move', exact: true })
    .waitFor()
  await guestPage
    .getByRole('heading', { name: 'Alex to move', exact: true })
    .waitFor()
  await hostPage.getByText('Both players connected', { exact: true }).waitFor()

  assert.equal(
    await hostPage
      .getByRole('gridcell', { name: 'Top left, empty', exact: true })
      .getAttribute('aria-disabled'),
    'false',
  )
  assert.equal(
    await guestPage
      .getByRole('gridcell', { name: 'Top left, empty', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  )

  await playMove(
    hostPage,
    guestPage,
    'Top left, empty',
    'Top left, X',
  )
  await playMove(
    guestPage,
    hostPage,
    'Middle left, empty',
    'Middle left, O',
  )
  await playMove(
    hostPage,
    guestPage,
    'Top center, empty',
    'Top center, X',
  )
  await playMove(
    guestPage,
    hostPage,
    'Center, empty',
    'Center, O',
  )
  await playMove(
    hostPage,
    guestPage,
    'Top right, empty',
    'Top right, X, winning square',
  )

  await Promise.all([
    hostPage
      .getByRole('heading', { name: 'Alex wins', exact: true })
      .waitFor(),
    guestPage
      .getByRole('heading', { name: 'Alex wins', exact: true })
      .waitFor(),
  ])
  await hostPage.getByLabel('Alex: 1 point').waitFor()
  await guestPage.getByLabel('Alex: 1 point').waitFor()
  await hostPage.getByText('X / 1W 0L 0D / You', { exact: true }).waitFor()
  await guestPage.getByText('X / 1W 0L 0D', { exact: true }).waitFor()
  const hostRivalry = hostPage.locator('.rivalry-record')
  await hostRivalry.getByText('All-time rivalry', { exact: true }).waitFor()
  assert.deepEqual(
    await hostRivalry.locator('strong').allTextContents(),
    ['1', '0', '0'],
  )
  await hostPage.waitForTimeout(800)
  await hostPage.screenshot({
    path: `${outputDirectory}/online-win.png`,
    fullPage: true,
  })
  await guestPage.setViewportSize({ width: 390, height: 844 })
  const mobileMatchLayout = await guestPage.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  assert(mobileMatchLayout.documentWidth <= mobileMatchLayout.viewportWidth)
  await guestPage.screenshot({
    path: `${outputDirectory}/mobile-online-win.png`,
    fullPage: true,
  })
  await guestPage.setViewportSize({ width: 1440, height: 1000 })

  await hostPage
    .getByRole('button', { name: 'Play again', exact: true })
    .click()
  await hostPage
    .getByRole('button', {
      name: 'Waiting for opponent',
      exact: true,
    })
    .waitFor()
  await guestPage
    .getByRole('button', { name: 'Play again', exact: true })
    .click()

  await Promise.all([
    hostPage
      .getByRole('heading', { name: 'Sam to move', exact: true })
      .waitFor(),
    guestPage
      .getByRole('heading', { name: 'Your move', exact: true })
      .waitFor(),
  ])

  await guestPage.reload({ waitUntil: 'networkidle' })
  await guestPage
    .getByRole('heading', { name: 'Your move', exact: true })
    .waitFor()
  await guestPage.getByLabel('Alex: 1 point').waitFor()

  const hostLayout = await hostPage.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    cells: document.querySelectorAll('[role="gridcell"]').length,
  }))
  assert.equal(hostLayout.cells, 9)
  assert(hostLayout.documentWidth <= hostLayout.viewportWidth)

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const mobilePage = await mobileContext.newPage()
  monitorPage(mobilePage, 'mobile')
  await mobilePage.goto(baseUrl, { waitUntil: 'networkidle' })
  await mobilePage.getByRole('tab', { name: 'Online', exact: true }).click()
  await mobilePage
    .getByRole('heading', { name: 'Room directory', exact: true })
    .waitFor()
  await mobilePage.getByRole('tab', { name: /Private/ }).click()
  await mobilePage
    .getByRole('heading', { name: 'Evening match', exact: true })
    .waitFor()
  await mobilePage
    .getByRole('button', {
      name: 'Evening match is full',
      exact: true,
    })
    .waitFor()
  const mobileLayout = await mobilePage.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  assert(mobileLayout.documentWidth <= mobileLayout.viewportWidth)
  await mobilePage.screenshot({
    path: `${outputDirectory}/mobile-lobby.png`,
    fullPage: true,
  })

  assert.deepEqual(browserErrors, [])

  await mobileContext.close()
  await guestContext.close()
  await hostContext.close()

  console.log(
    JSON.stringify(
      {
        outputDirectory,
        roomCode,
        hostLayout,
        mobileMatchLayout,
        mobileLayout,
        mobilePreviewLayout,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
