// 数据模型：所有时间用毫秒时间戳（number），便于跨时区与排序。

export type CardTypeId =
  | 'concept' | 'formula' | 'magnitude' | 'method' | 'paper'
  | 'logic' | 'condition' | 'compare' | 'figure' | 'pitfall'

export interface Deck {
  id: string
  name: string
  sample: 0 | 1          // 示例数据标记
  createdAt: number
  updatedAt: number
  rev: number            // 服务器版本号，0 表示从未同步
  dirty: 0 | 1           // 本地有未推送的修改
  deleted: 0 | 1         // 墓碑
}

export interface CardSource {
  title?: string     // 书名 / 论文标题
  location?: string  // 页码 / 章节
  link?: string      // 链接 / DOI
  note?: string      // 补充笔记
}

export interface Card {
  id: string
  deckId: string
  type: CardTypeId
  front: string      // Markdown + LaTeX 源码
  back: string
  tags: string[]
  source: CardSource
  favorite: 0 | 1
  suspended: 0 | 1
  sample: 0 | 1
  createdAt: number
  updatedAt: number
  rev: number
  dirty: 0 | 1
  deleted: 0 | 1
}

// FSRS 调度状态（与 ts-fsrs Card 字段一致，时间改为毫秒）
export interface CardState {
  cardId: string
  due: number
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: 0 | 1 | 2 | 3   // New, Learning, Review, Relearning
  last_review: number | null
  updatedAt: number
  dirty: 0 | 1
}

export type Rating = 1 | 2 | 3 | 4 // 忘记 困难 记得 轻松

export interface ReviewLog {
  id: string
  cardId: string
  rating: Rating
  mode: 'review' | 'practice'
  reviewedAt: number
  before: Omit<CardState, 'cardId' | 'updatedAt' | 'dirty'>
  after: Omit<CardState, 'cardId' | 'updatedAt' | 'dirty'>
  deviceId: string
  undone: 0 | 1
  updatedAt: number
  dirty: 0 | 1
}

export interface ImageRecord {
  id: string
  mime: string
  size: number
  blob?: Blob           // 本地保存的二进制；同步元数据时不带
  createdAt: number
  dirty: 0 | 1
}

export interface Draft {
  key: string            // 'card:<id>' 或 'new:<deckId>'
  cardId: string | null
  deckId: string
  type: CardTypeId
  front: string
  back: string
  tags: string[]
  source: CardSource
  updatedAt: number
}

export interface ReviewSession {
  id: 'review'
  deckId: string | null
  queue: string[]        // 待复习卡片 id
  done: number           // 已完成数量
  history: string[]      // 本次会话的评分日志 id（用于撤销）
  startedAt: number
  updatedAt: number
}

export interface Settings {
  id: 'settings'
  dailyNew: number
  dailyReview: number
  theme: 'auto' | 'light' | 'dark'
  layout: 'auto' | 'mobile' | 'desktop'
  deviceId: string
  syncBackend: 'server' | 'github'
  syncUrl: string        // 自托管服务器地址
  syncToken: string      // 自托管服务器令牌
  ghToken: string        // GitHub 细粒度令牌（仅对数据仓库的 Contents 读写权限）
  ghRepo: string         // owner/repo
  ghBranch: string       // 分支，默认 main
  lastSeq: number
  lastSyncAt: number | null
}

export interface KV {
  key: string
  value: unknown
}
