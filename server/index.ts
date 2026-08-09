import { createGameServer } from './game-server'

const parsedPort = Number.parseInt(process.env.PORT ?? '3001', 10)
const port = Number.isFinite(parsedPort) ? parsedPort : 3001
const host = process.env.HOST ?? '0.0.0.0'
const server = createGameServer()
const address = await server.listen(port, host)

console.log(`Tic Tac Toe server listening on ${address.host}:${address.port}`)

async function shutDown(): Promise<void> {
  await server.close()
  process.exit(0)
}

process.once('SIGINT', () => {
  void shutDown()
})
process.once('SIGTERM', () => {
  void shutDown()
})
