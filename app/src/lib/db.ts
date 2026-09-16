import Dexie, { type Table } from 'dexie'
import type {
  Card, CardState, Deck, Draft, ImageRecord, KV, ReviewLog, ReviewSession, Settings,
} from './types'

export class CardsDB extends Dexie {
  decks!: Table<Deck, string>
  cards!: Table<Card, string>
  states!: Table<CardState, string>
  logs!: Table<ReviewLog, string>
  images!: Table<ImageRecord, string>
  drafts!: Table<Draft, string>
  sessions!: Table<ReviewSession, string>
  settings!: Table<Settings, string>
  kv!: Table<KV, string>

  constructor(name = 'physics-cards') {
    super(name)
    this.version(1).stores({
      decks: 'id, name, updatedAt, dirty, deleted',
      cards: 'id, deckId, type, *tags, updatedAt, dirty, deleted, favorite, suspended',
      states: 'cardId, due, state, dirty',
      logs: 'id, cardId, reviewedAt, dirty, undone',
      images: 'id, dirty',
      drafts: 'key, cardId, updatedAt',
      sessions: 'id',
      settings: 'id',
      kv: 'key',
    })
  }
}

export const db = new CardsDB()
