import type {
  CachedCommandResponse,
  CommandReceipt,
  PersistedRoom,
  RoomStateStore,
  RoomStoreMutation,
} from './store'

export class InMemoryRoomStateStore implements RoomStateStore {
  readonly backend = 'memory' as const
  private readonly rooms = new Map<string, PersistedRoom>()
  private readonly receipts = new Map<string, CommandReceipt>()
  private nextReceiptCleanupAt = 0

  async initialize(): Promise<void> {}

  async loadActiveRooms(now: number): Promise<readonly PersistedRoom[]> {
    for (const [roomId, room] of this.rooms) {
      if (room.expiresAt <= now) {
        this.rooms.delete(roomId)
      }
    }

    return [...this.rooms.values()].map((room) => structuredClone(room))
  }

  async findReceipt(
    key: string,
    now: number,
  ): Promise<CachedCommandResponse | null> {
    if (now >= this.nextReceiptCleanupAt) {
      for (const [receiptKey, candidate] of this.receipts) {
        if (candidate.expiresAt <= now) {
          this.receipts.delete(receiptKey)
        }
      }
      this.nextReceiptCleanupAt = now + 60_000
    }

    const receipt = this.receipts.get(key)

    if (!receipt) {
      return null
    }

    if (receipt.expiresAt <= now) {
      this.receipts.delete(key)
      return null
    }

    return structuredClone(receipt.response)
  }

  async commit(mutation: RoomStoreMutation): Promise<void> {
    if (mutation.deleteRoomId) {
      this.rooms.delete(mutation.deleteRoomId)
    }

    if (mutation.upsert) {
      this.rooms.set(
        mutation.upsert.id,
        structuredClone(mutation.upsert),
      )
    }

    if (mutation.receipt) {
      this.receipts.set(
        mutation.receipt.key,
        structuredClone(mutation.receipt),
      )
    }
  }

  async close(): Promise<void> {}
}
