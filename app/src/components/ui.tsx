import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

// ---------- Toast ----------
const ToastCtx = createContext<(msg: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((m: string) => {
    setMsg(m)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(null), 2600)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  )
}

// ---------- Dialog ----------
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** 简单确认框 */
export function ConfirmDialog({ title, message, confirmText = '确定', danger, onConfirm, onClose }: {
  title: string; message: ReactNode; confirmText?: string; danger?: boolean; onConfirm: () => void; onClose: () => void
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div style={{ marginBottom: 16 }}>{message}</div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => { onConfirm(); onClose() }}>{confirmText}</button>
      </div>
    </Dialog>
  )
}

/** 文本输入框 */
export function PromptDialog({ title, label, initial = '', onSubmit, onClose }: {
  title: string; label?: string; initial?: string; onSubmit: (v: string) => void; onClose: () => void
}) {
  const [v, setV] = useState(initial)
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onSubmit(v.trim()); onClose() } }}>
        <div className="field" style={{ marginBottom: 16 }}>
          {label && <label>{label}</label>}
          <input className="input" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={!v.trim()}>确定</button>
        </div>
      </form>
    </Dialog>
  )
}

/** 判断当前焦点是否在可编辑元素中（用于屏蔽复习快捷键） */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtTime(ts).slice(0, 5)}`
}
