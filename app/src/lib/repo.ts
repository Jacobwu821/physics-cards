// 数据仓库层：所有对 IndexedDB 的读写都经过这里。
import { db } from './db'
import { uid } from './id'
import type {
  Card, CardSource, CardState, CardTypeId, Deck, Draft, ImageRecord, Rating, ReviewLog, ReviewSession, Settings,
} from './types'
import { applyRating, makeScheduler, newState, undoRating } from '../scheduler/scheduler'

const now = () => Date.now()

// ---------- 设置 ----------
export const DEFAULT_SETTINGS: Settings = {
  id: 'settings', dailyNew: 15, dailyReview: 200, theme: 'auto', layout: 'auto',
  deviceId: '', syncBackend: 'server', syncUrl: '', syncToken: '',
  ghToken: '', ghRepo: '', ghBranch: 'main', lastSeq: 0, lastSyncAt: null,
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings')
  if (s) return { ...DEFAULT_SETTINGS, ...s }
  const fresh = { ...DEFAULT_SETTINGS, deviceId: uid() }
  await db.settings.put(fresh)
  return fresh
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings()
  const next = { ...cur, ...patch, id: 'settings' as const }
  await db.settings.put(next)
  return next
}

// ---------- 牌组 ----------
export async function createDeck(name: string, sample: 0 | 1 = 0): Promise<Deck> {
  const t = now()
  const deck: Deck = { id: uid(), name: name.trim(), sample, createdAt: t, updatedAt: t, rev: 0, dirty: 1, deleted: 0 }
  await db.decks.put(deck)
  return deck
}

export async function renameDeck(id: string, name: string): Promise<void> {
  await db.decks.update(id, { name: name.trim(), updatedAt: now(), dirty: 1 })
}

export type DeleteDeckMode = { mode: 'deleteCards' } | { mode: 'moveTo'; deckId: string }

export async function deleteDeck(id: string, how: DeleteDeckMode): Promise<void> {
  const t = now()
  await db.transaction('rw', db.decks, db.cards, db.states, async () => {
    const cards = await db.cards.where('deckId').equals(id).filter((c) => !c.deleted).toArray()
    if (how.mode === 'deleteCards') {
      for (const c of cards) await db.cards.update(c.id, { deleted: 1, updatedAt: t, dirty: 1 })
    } else {
      for (const c of cards) await db.cards.update(c.id, { deckId: how.deckId, updatedAt: t, dirty: 1 })
    }
    await db.decks.update(id, { deleted: 1, updatedAt: t, dirty: 1 })
  })
}

export async function liveDecks(): Promise<Deck[]> {
  return (await db.decks.filter((d) => !d.deleted).toArray()).sort((a, b) => a.createdAt - b.createdAt)
}

// ---------- 卡片 ----------
export interface CardInput {
  deckId: string
  type: CardTypeId
  front: string
  back: string
  tags?: string[]
  source?: CardSource
  sample?: 0 | 1
}

export function normalizeTags(tags: string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of tags ?? []) {
    const t = raw.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

export function cleanSource(s: CardSource | undefined): CardSource {
  const out: CardSource = {}
  for (const k of ['title', 'location', 'link', 'note'] as const) {
    const v = s?.[k]?.trim()
    if (v) out[k] = v
  }
  return out
}

export async function createCard(input: CardInput): Promise<Card> {
  const t = now()
  const card: Card = {
    id: uid(), deckId: input.deckId, type: input.type, front: input.front, back: input.back,
    tags: normalizeTags(input.tags), source: cleanSource(input.source),
    favorite: 0, suspended: 0, sample: input.sample ?? 0,
    createdAt: t, updatedAt: t, rev: 0, dirty: 1, deleted: 0,
  }
  await db.transaction('rw', db.cards, db.states, async () => {
    await db.cards.put(card)
    await db.states.put(newState(card.id, t))
  })
  return card
}

export async function updateCard(id: string, patch: Partial<Omit<Card, 'id' | 'createdAt' | 'rev' | 'dirty'>>): Promise<void> {
  const p: Partial<Card> = { ...patch, updatedAt: now(), dirty: 1 }
  if (patch.tags) p.tags = normalizeTags(patch.tags)
  if (patch.source) p.source = cleanSource(patch.source)
  await db.cards.update(id, p)
}

export async function deleteCard(id: string): Promise<void> {
  await db.cards.update(id, { deleted: 1, updatedAt: now(), dirty: 1 })
}

export async function duplicateCard(id: string): Promise<Card | undefined> {
  const c = await db.cards.get(id)
  if (!c) return undefined
  return createCard({ deckId: c.deckId, type: c.type, front: c.front, back: c.back, tags: c.tags, source: c.source })
}

export async function moveCards(ids: string[], deckId: string): Promise<void> {
  const t = now()
  await db.transaction('rw', db.cards, async () => {
    for (const id of ids) await db.cards.update(id, { deckId, updatedAt: t, dirty: 1 })
  })
}

export async function liveCards(): Promise<Card[]> {
  return db.cards.filter((c) => !c.deleted).toArray()
}

export async function allTags(): Promise<string[]> {
  const cards = await liveCards()
  const set = new Set<string>()
  for (const c of cards) for (const t of c.tags) set.add(t)
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
}

// ---------- 调度状态 ----------
export async function ensureState(cardId: string): Promise<CardState> {
  const s = await db.states.get(cardId)
  if (s) return s
  const fresh = newState(cardId, now())
  await db.states.put(fresh)
  return fresh
}

export async function statesMap(): Promise<Map<string, CardState>> {
  const all = await db.states.toArray()
  return new Map(all.map((s) => [s.cardId, s]))
}

const scheduler = makeScheduler()

/** 评分：写日志 + 更新状态（原子）。返回日志 id 用于撤销。 */
export async function rateCard(cardId: string, rating: Rating, mode: ReviewLog['mode'] = 'review'): Promise<ReviewLog> {
  const settings = await getSettings()
  const t = now()
  return db.transaction('rw', db.states, db.logs, async () => {
    const s = await ensureState(cardId)
    const { state, log } = applyRating(s, rating, t, settings.deviceId, mode, scheduler)
    await db.logs.put(log)
    await db.states.put(state)
    return log
  })
}

/** 撤销一次评分：标记日志 undone，恢复评分前状态 */
export async function undoLog(logId: string): Promise<boolean> {
  const t = now()
  return db.transaction('rw', db.states, db.logs, async () => {
    const log = await db.logs.get(logId)
    if (!log || log.undone) return false
    const s = await ensureState(log.cardId)
    await db.logs.put({ ...log, undone: 1, updatedAt: t, dirty: 1 })
    await db.states.put(undoRating(s, log, t))
    return true
  })
}

export async function recentLogs(sinceMs: number): Promise<ReviewLog[]> {
  return db.logs.where('reviewedAt').aboveOrEqual(sinceMs).toArray()
}

// ---------- 草稿 ----------
export const draftKey = (cardId: string | null, deckId: string) => (cardId ? `card:${cardId}` : `new:${deckId}`)

export async function saveDraft(d: Omit<Draft, 'updatedAt'>): Promise<void> {
  await db.drafts.put({ ...d, updatedAt: now() })
}
export async function loadDraft(key: string): Promise<Draft | undefined> {
  return db.drafts.get(key)
}
export async function deleteDraft(key: string): Promise<void> {
  await db.drafts.delete(key)
}

// ---------- 复习会话 ----------
export async function getSession(): Promise<ReviewSession | undefined> {
  return db.sessions.get('review')
}
export async function saveSession(s: Omit<ReviewSession, 'id' | 'updatedAt'>): Promise<void> {
  await db.sessions.put({ ...s, id: 'review', updatedAt: now() })
}
export async function clearSession(): Promise<void> {
  await db.sessions.delete('review')
}

// ---------- 图片 ----------
const urlCache = new Map<string, string>()

export async function saveImage(blob: Blob): Promise<ImageRecord> {
  const rec: ImageRecord = { id: uid(), mime: blob.type || 'image/png', size: blob.size, blob, createdAt: now(), dirty: 1 }
  await db.images.put(rec)
  return rec
}

export async function imageUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return cached
  const rec = await db.images.get(id)
  if (!rec?.blob) return null
  const url = URL.createObjectURL(rec.blob)
  urlCache.set(id, url)
  return url
}

/** 缩放图片（最长边 1600px），减小体积 */
export async function shrinkImage(file: File, maxSide = 1600): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
    if (scale === 1 && file.size < 1_500_000) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, 0.88))
  } catch {
    return file
  }
}

// ---------- 示例数据 ----------
export const SAMPLE_DECK_NAME = '示例·量子光学'

export async function loadSampleData(): Promise<void> {
  const existing = await db.decks.filter((d) => d.sample === 1 && !d.deleted).first()
  if (existing) return
  const deck = await createDeck(SAMPLE_DECK_NAME, 1)
  const items: Array<Omit<CardInput, 'deckId' | 'sample'>> = [
    {
      type: 'formula',
      front: '二能级原子与单模光场的 **Jaynes–Cummings 哈密顿量**如何表达？',
      back: '在旋波近似下：\n\n$$H = \\hbar\\omega_c a^\\dagger a + \\tfrac{1}{2}\\hbar\\omega_a \\sigma_z + \\hbar g\\left(a^\\dagger\\sigma_- + a\\,\\sigma_+\\right)$$\n\n- $g$：单光子耦合强度\n- 适用条件：$|\\omega_c-\\omega_a| \\ll \\omega_c+\\omega_a$，<u>近共振</u>',
      tags: ['双能级系统', '近似条件'],
      source: { title: 'Haroche & Raimond, Exploring the Quantum', location: 'Ch. 3' },
    },
    {
      type: 'magnitude',
      front: '780 nm 附近、腔长约 2 cm 的 Fabry–Pérot 腔，自由光谱范围 $\\nu_\\mathrm{FSR}$ 大约多大？',
      back: '$\\nu_\\mathrm{FSR} = c/(2L) \\approx 3\\times10^8 / (2\\times 0.02) \\approx 7.5\\ \\mathrm{GHz}$\n\n估算方法：先记住 $c/2 = 1.5\\times10^8\\ \\mathrm{m/s}$，再除以腔长。',
      tags: ['数量级', '腔'],
    },
    {
      type: 'condition',
      front: '旋波近似（RWA）什么时候成立？',
      back: '- 假设：耦合强度远小于跃迁频率，$g \\ll \\omega_a$\n- 近共振：失谐 $\\Delta = \\omega_c - \\omega_a$ 满足 $|\\Delta| \\ll \\omega_a$\n- 失效情形：超强耦合 $g/\\omega_c \\gtrsim 0.1$，需保留反旋波项',
      tags: ['近似条件', '待加强'],
    },
    {
      type: 'compare',
      front: '**强耦合**与**弱耦合**腔 QED 有什么区别？',
      back: '共同点：都由 $g$、腔衰减率 $\\kappa$、原子自发辐射率 $\\gamma$ 决定。\n\n差异：\n1. 强耦合 $g \\gg \\kappa, \\gamma$：出现真空拉比劈裂 $2g$\n2. 弱耦合 $g \\ll \\kappa$：Purcell 效应，辐射率增强因子 $F_P = \\frac{3}{4\\pi^2}\\left(\\frac{\\lambda}{n}\\right)^3\\frac{Q}{V}$\n\n判断依据：比较协同参数 $C = g^2/(\\kappa\\gamma)$ 与 1。',
      tags: ['腔', '双能级系统'],
    },
  ]
  for (const it of items) await createCard({ ...it, deckId: deck.id, sample: 1 })
}

export async function removeSampleData(): Promise<void> {
  const decks = await db.decks.filter((d) => d.sample === 1 && !d.deleted).toArray()
  for (const d of decks) await deleteDeck(d.id, { mode: 'deleteCards' })
}

// ---------- 统计 ----------
export async function deckStats(): Promise<Map<string, { total: number; due: number; fresh: number; suspended: number }>> {
  const cards = await liveCards()
  const states = await statesMap()
  const cutoff = (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime() })()
  const m = new Map<string, { total: number; due: number; fresh: number; suspended: number }>()
  for (const c of cards) {
    const e = m.get(c.deckId) ?? { total: 0, due: 0, fresh: 0, suspended: 0 }
    e.total++
    if (c.suspended) e.suspended++
    else {
      const s = states.get(c.id)
      if (!s || s.state === 0) e.fresh++
      else if (s.due <= cutoff) e.due++
    }
    m.set(c.deckId, e)
  }
  return m
}
