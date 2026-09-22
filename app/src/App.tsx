import { useEffect } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './lib/db'
import { getSettings } from './lib/repo'
import { ToastProvider } from './components/ui'
import { SyncProvider } from './sync/SyncContext'
import Today from './pages/Today'
import Decks from './pages/Decks'
import Library from './pages/Library'
import Editor from './pages/Editor'
import Review from './pages/Review'
import Practice from './pages/Practice'
import Settings from './pages/Settings'

function useTheme() {
  const settings = useLiveQuery(() => db.settings.get('settings'))
  const theme = settings?.theme ?? 'auto'
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'auto' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

function useLayout() {
  const settings = useLiveQuery(() => db.settings.get('settings'))
  const layout = settings?.layout ?? 'auto'
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)')
    const apply = () => {
      const desktop = layout === 'desktop' || (layout === 'auto' && mq.matches)
      document.documentElement.dataset.layout = desktop ? 'desktop' : 'mobile'
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [layout])
}

export default function App() {
  useTheme()
  useLayout()
  useEffect(() => { void getSettings() }, [])
  const loc = useLocation()
  const fullscreen = loc.pathname.startsWith('/review') || loc.pathname.startsWith('/practice')
  return (
    <ToastProvider>
      <SyncProvider>
        <div className={fullscreen ? 'fullscreen' : ''}>
          <div className="app">
            <nav className="nav">
              <div className="brand">物理卡片</div>
              <NavLink to="/" end><span className="ico">☀</span><span>今日</span></NavLink>
              <NavLink to="/decks"><span className="ico">▤</span><span>文件夹</span></NavLink>
              <NavLink to="/library"><span className="ico">☰</span><span>卡片库</span></NavLink>
              <NavLink to="/settings"><span className="ico">⚙</span><span>设置</span></NavLink>
            </nav>
            <main className="main">
              <Routes>
                <Route path="/" element={<Today />} />
                <Route path="/decks" element={<Decks />} />
                <Route path="/library" element={<Library />} />
                <Route path="/edit/new" element={<Editor />} />
                <Route path="/edit/:id" element={<Editor />} />
                <Route path="/review" element={<Review />} />
                <Route path="/practice" element={<Practice />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Today />} />
              </Routes>
            </main>
          </div>
        </div>
      </SyncProvider>
    </ToastProvider>
  )
}
