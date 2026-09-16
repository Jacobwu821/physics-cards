import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { getSettings } from '../lib/repo'
import { syncNow, SyncError, type SyncResult } from './client'
import { isSyncConfigured } from './backend'

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'ok' | 'error' | 'offline'

interface SyncCtx {
  status: SyncStatus
  message: string
  lastSyncAt: number | null
  pendingCount: number
  notices: string[]
  clearNotices: () => void
  sync: (reason?: string) => Promise<SyncResult | null>
}

const Ctx = createContext<SyncCtx>({
  status: 'off', message: '', lastSyncAt: null, pendingCount: 0, notices: [], clearNotices: () => {}, sync: async () => null,
})
export const useSync = () => useContext(Ctx)

export function SyncProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>('off')
  const [message, setMessage] = useState('')
  const [notices, setNotices] = useState<string[]>([])
  const settings = useLiveQuery(() => db.settings.get('settings'))
  const configured = !!settings && isSyncConfigured({ syncBackend: settings.syncBackend ?? 'server', syncUrl: settings.syncUrl, syncToken: settings.syncToken, ghToken: settings.ghToken ?? '', ghRepo: settings.ghRepo ?? '' })
  const pendingCount = useLiveQuery(async () => {
    const [a, b, c, d, e] = await Promise.all([
      db.decks.where('dirty').equals(1).count(), db.cards.where('dirty').equals(1).count(),
      db.states.where('dirty').equals(1).count(), db.logs.where('dirty').equals(1).count(),
      db.images.where('dirty').equals(1).count(),
    ])
    return a + b + c + d + e
  }, [], 0)

  const sync = useCallback(async (): Promise<SyncResult | null> => {
    const s = await getSettings()
    if (!isSyncConfigured(s)) { setStatus('off'); return null }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus('offline'); setMessage('离线，改动已保存在本机，联网后自动同步')
      return null
    }
    setStatus('syncing'); setMessage('同步中…')
    try {
      const r = await syncNow()
      setStatus('ok')
      setMessage(r.conflicts ? `已同步，处理了 ${r.conflicts} 处冲突` : '已同步')
      if (r.notices.length) setNotices((n) => [...n, ...r.notices])
      return r
    } catch (e) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setStatus('offline'); setMessage('离线，改动已保存在本机，联网后自动同步')
        return null
      }
      setStatus('error')
      setMessage(e instanceof SyncError ? e.message : '同步失败：' + (e instanceof Error ? e.message : String(e)))
      return null
    }
  }, [])

  // 网络恢复时立即同步
  useEffect(() => {
    const onOnline = () => void sync()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [sync])

  // 启动时、配置变化时、每 5 分钟、窗口重新可见时同步；本地有改动时延迟 3 秒后同步
  useEffect(() => {
    if (!configured) { setStatus('off'); setMessage(''); return }
    setStatus((s) => (s === 'off' ? 'idle' : s))
    void sync()
    const iv = window.setInterval(() => void sync(), 5 * 60 * 1000)
    const onVis = () => { if (document.visibilityState === 'visible') void sync() }
    document.addEventListener('visibilitychange', onVis)
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
  }, [configured, sync])

  const debounce = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!configured || !pendingCount) return
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => void sync(), 3000)
    return () => window.clearTimeout(debounce.current)
  }, [pendingCount, configured, sync])

  return (
    <Ctx.Provider value={{
      status, message, lastSyncAt: settings?.lastSyncAt ?? null, pendingCount: pendingCount ?? 0,
      notices, clearNotices: () => setNotices([]), sync,
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function SyncBadge() {
  const { status, message, pendingCount } = useSync()
  if (status === 'off') return <span className="badge">未配置同步</span>
  const cls = status === 'error' ? 'danger' : status === 'ok' ? 'ok' : status === 'syncing' ? 'accent' : status === 'offline' ? 'warn' : ''
  const text = status === 'idle' ? (pendingCount ? `${pendingCount} 项待同步` : '已同步') : status === 'offline' ? (pendingCount ? `离线 · ${pendingCount} 项待同步` : '离线') : message
  return <span className={`badge ${cls}`} title={message}>{text}{status === 'ok' && pendingCount ? `（${pendingCount} 项待同步）` : ''}</span>
}
