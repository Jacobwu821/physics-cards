import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../lib/db'
import { createCard, createDeck, rateCard, saveImage, undoLog, updateSettings } from '../lib/repo'
import { exportBackup, importBackup, validateBackup } from './backup'

describe('备份与恢复', () => {
  beforeEach(async () => {
    await Promise.all([db.decks.clear(), db.cards.clear(), db.states.clear(), db.logs.clear(), db.images.clear(), db.settings.clear()])
  })

  it('导出后清空再导入，卡片内容、图片与复习进度一致', async () => {
    await updateSettings({ dailyNew: 7, dailyReview: 42 })
    const deck = await createDeck('量子光学')
    const img = await saveImage(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))
    const card = await createCard({
      deckId: deck.id, type: 'formula',
      front: '**Jaynes–Cummings** 哈密顿量？<u>旋波近似</u> $g \\ll \\omega$',
      back: `$$H = \\hbar g (a^\\dagger \\sigma_- + a \\sigma_+)$$\n\n![图](img://${img.id})`,
      tags: ['双能级系统', '待加强'], source: { title: 'Haroche', location: 'Ch.3', link: '10.1000/xyz', note: '注' },
    })
    await rateCard(card.id, 3, 'review')
    const undone = await rateCard(card.id, 1, 'review')
    await undoLog(undone.id)
    const stateBefore = await db.states.get(card.id)

    const backup = await exportBackup()
    const roundtrip = validateBackup(JSON.parse(JSON.stringify(backup)))
    expect(roundtrip.cards).toHaveLength(1)
    expect(roundtrip.images).toHaveLength(1)
    expect(roundtrip.logs).toHaveLength(2)

    await Promise.all([db.decks.clear(), db.cards.clear(), db.states.clear(), db.logs.clear(), db.images.clear()])
    expect(await db.cards.count()).toBe(0)

    const r = await importBackup(roundtrip, 'replace')
    expect(r).toEqual({ decks: 1, cards: 1, logs: 2, images: 1 })
    const c2 = await db.cards.get(card.id)
    expect(c2?.front).toBe(card.front)
    expect(c2?.back).toBe(card.back)
    expect(c2?.tags).toEqual(['双能级系统', '待加强'])
    expect(c2?.source).toEqual({ title: 'Haroche', location: 'Ch.3', link: '10.1000/xyz', note: '注' })
    expect(c2?.deckId).toBe(deck.id)
    const s2 = await db.states.get(card.id)
    expect(s2?.due).toBe(stateBefore?.due)
    expect(s2?.state).toBe(stateBefore?.state)
    expect(s2?.reps).toBe(stateBefore?.reps)
    const logs = await db.logs.toArray()
    expect(logs.filter((l) => l.undone).length).toBe(1)
    const im = await db.images.get(img.id)
    expect(im?.blob).toBeTruthy()
    expect(new Uint8Array(await im!.blob!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
    const s = await db.settings.get('settings')
    expect(s?.dailyNew).toBe(7)
    expect(s?.dailyReview).toBe(42)
  })

  it('合并导入：较新的记录胜出，旧记录不覆盖', async () => {
    const deck = await createDeck('A')
    const card = await createCard({ deckId: deck.id, type: 'concept', front: '新', back: '' })
    const backup = await exportBackup()
    backup.cards[0] = { ...backup.cards[0], front: '旧', updatedAt: card.updatedAt - 1000 }
    await importBackup(backup, 'merge')
    expect((await db.cards.get(card.id))?.front).toBe('新')
    backup.cards[0] = { ...backup.cards[0], front: '更新', updatedAt: card.updatedAt + 1000 }
    await importBackup(backup, 'merge')
    expect((await db.cards.get(card.id))?.front).toBe('更新')
  })

  it('拒绝无效文件', () => {
    expect(() => validateBackup({ foo: 1 })).toThrow()
    expect(() => validateBackup({ format: 'physics-cards-backup', version: 1, decks: [] })).toThrow()
  })
})
