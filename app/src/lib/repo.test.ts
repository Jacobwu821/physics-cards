import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { CardsDB, db } from './db'
import { createCard, createDeck, createFolder, deleteFolder, moveDeckToFolder, renameFolder } from './repo'

describe('文件夹与牌组', () => {
  beforeEach(async () => {
    await Promise.all([db.folders.clear(), db.decks.clear(), db.cards.clear(), db.states.clear()])
  })

  it('原有未归类牌组可移动；删除文件夹只解除归属，不删除卡片和进度', async () => {
    const deck = await createDeck('原有牌组')
    const card = await createCard({ deckId: deck.id, type: 'concept', front: '问题', back: '答案' })
    const state = await db.states.get(card.id)
    const folder = await createFolder('量子光学')
    await renameFolder(folder.id, '量子信息')
    await moveDeckToFolder(deck.id, folder.id)
    expect((await db.decks.get(deck.id))?.folderId).toBe(folder.id)
    expect((await db.folders.get(folder.id))?.name).toBe('量子信息')

    await deleteFolder(folder.id)
    expect((await db.folders.get(folder.id))?.deleted).toBe(1)
    expect((await db.decks.get(deck.id))?.folderId).toBeNull()
    expect(await db.cards.get(card.id)).toMatchObject({ deckId: deck.id, deleted: 0 })
    expect(await db.states.get(card.id)).toEqual(state)
  })

  it('不允许移动到已删除的文件夹', async () => {
    const deck = await createDeck('牌组')
    const folder = await createFolder('旧文件夹')
    await deleteFolder(folder.id)
    await expect(moveDeckToFolder(deck.id, folder.id)).rejects.toThrow('目标文件夹不存在')
    expect((await db.decks.get(deck.id))?.folderId).toBeNull()
  })

  it('旧数据库升级后保留原有牌组和卡片', async () => {
    const name = `legacy-folders-${crypto.randomUUID()}`
    const old = new Dexie(name)
    old.version(1).stores({
      decks: 'id, name, updatedAt, dirty, deleted',
      cards: 'id, deckId, type, *tags, updatedAt, dirty, deleted, favorite, suspended',
      states: 'cardId, due, state, dirty', logs: 'id, cardId, reviewedAt, dirty, undone',
      images: 'id, dirty', drafts: 'key, cardId, updatedAt', sessions: 'id', settings: 'id', kv: 'key',
    })
    await old.table('decks').put({ id: 'd-old', name: '原牌组', deleted: 0 })
    await old.table('cards').put({ id: 'c-old', deckId: 'd-old', front: '旧问题', deleted: 0 })
    old.close()

    const upgraded = new CardsDB(name)
    expect((await upgraded.decks.get('d-old'))?.name).toBe('原牌组')
    expect((await upgraded.cards.get('c-old'))?.front).toBe('旧问题')
    expect(await upgraded.folders.count()).toBe(0)
    upgraded.close()
    await Dexie.delete(name)
  })
})
