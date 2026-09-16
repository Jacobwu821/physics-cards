import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import 'katex/dist/katex.min.css'
import './styles.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)

// 离线应用壳：仅生产构建、且处于安全上下文（https 或 localhost）时注册。
// 每次打开都主动检查更新；新版本接管后刷新一次，保证运行的代码与缓存一致。
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      void reg.update().catch(() => {})
      let reloaded = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return
        reloaded = true
        // 复习/编辑进行中时不打断：只在首页或设置页自动刷新，其余页面下次打开生效
        const h = location.hash
        if (h === '' || h === '#/' || h.startsWith('#/settings')) location.reload()
      })
    } catch (e) {
      console.warn('Service Worker 注册失败', e)
    }
  })
}
