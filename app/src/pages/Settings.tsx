import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { DEFAULT_SETTINGS, getSettings, loadSampleData, removeSampleData, updateSettings } from '../lib/repo'
import { backupFileName, exportBackup, importBackup, validateBackup, type BackupFile, type ImportMode } from '../backup/backup'
import { testConnection } from '../sync/client'
import { isSyncConfigured, makeBackend } from '../sync/backend'
import { useSync } from '../sync/SyncContext'
import { ConfirmDialog, Dialog, fmtDateTime, useToast } from '../components/ui'

export default function Settings() {
  // 只读查询：默认设置由 App 启动时的 getSettings() 创建，这里不能在 liveQuery 内写库
  const raw = useLiveQuery(() => db.settings.get('settings'))
  const settings = raw ? { ...DEFAULT_SETTINGS, ...raw } : undefined
  useEffect(() => { void getSettings() }, [])
  const sync = useSync()
  const toast = useToast()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [backendKind, setBackendKind] = useState<'server' | 'github'>('github')
  const [ghRepo, setGhRepo] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [ghBranch, setGhBranch] = useState('main')
  const [testing, setTesting] = useState<string | null>(null)
  const draftSettings = { syncBackend: backendKind, syncUrl: url.trim(), syncToken: token.trim(), ghToken: ghToken.trim(), ghRepo: ghRepo.trim(), ghBranch: ghBranch.trim() || 'main' }
  const draftConfigured = isSyncConfigured(draftSettings)
  const makeKey = (s: typeof draftSettings) => [s.syncBackend, s.syncUrl, s.ghRepo, s.ghBranch]
  const [pendingImport, setPendingImport] = useState<BackupFile | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const sampleDeck = useLiveQuery(() => db.decks.filter((d) => d.sample === 1 && !d.deleted).first())

  useEffect(() => {
    if (settings) {
      setUrl(settings.syncUrl); setToken(settings.syncToken); setBackendKind(settings.syncBackend)
      setGhRepo(settings.ghRepo); setGhToken(settings.ghToken); setGhBranch(settings.ghBranch || 'main')
    }
  }, [settings?.syncUrl, settings?.syncToken, settings?.syncBackend, settings?.ghRepo, settings?.ghToken, settings?.ghBranch])
  if (!settings) return null

  const doExport = async () => {
    const data = await exportBackup()
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = backupFileName()
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    toast(`已导出 ${data.cards.length} 张卡片、${data.logs.length} 条复习记录`)
  }
  const onPick = async (f: File | undefined) => {
    if (!f) return
    try {
      const b = validateBackup(JSON.parse(await f.text()))
      setPendingImport(b)
    } catch (e) { toast(e instanceof Error ? e.message : '读取失败') }
  }
  const doImport = async (mode: ImportMode) => {
    if (!pendingImport) return
    const r = await importBackup(pendingImport, mode)
    setPendingImport(null)
    toast(`已导入 ${r.decks} 个牌组、${r.cards} 张卡片、${r.logs} 条复习记录`)
  }

  return (
    <div className="stack">
      <h1>设置</h1>

      <div className="panel stack">
        <h2>每日目标</h2>
        <div className="row">
          <div className="field grow">
            <label>每日新卡上限</label>
            <input className="input" type="number" min={0} max={500} value={settings.dailyNew}
              onChange={(e) => updateSettings({ dailyNew: Math.max(0, Number(e.target.value) || 0) })} />
          </div>
          <div className="field grow">
            <label>每日复习目标（到期卡）</label>
            <input className="input" type="number" min={0} max={5000} value={settings.dailyReview}
              onChange={(e) => updateSettings({ dailyReview: Math.max(0, Number(e.target.value) || 0) })} />
          </div>
        </div>
        <p className="muted small">超出目标的到期卡不会被丢弃，完成本轮后可以继续开始复习。</p>
      </div>

      <div className="panel stack">
        <h2>外观</h2>
        <div className="field"><label>颜色</label>
          <div className="row">
            {(['auto', 'light', 'dark'] as const).map((t) => (
              <button key={t} className={`chip ${settings.theme === t ? 'on' : ''}`} onClick={() => updateSettings({ theme: t })}>
                {t === 'auto' ? '跟随系统' : t === 'light' ? '浅色' : '深色'}
              </button>
            ))}
          </div>
        </div>
        <div className="field"><label>布局（同一网址两种界面：手机版底部导航单手操作，桌面版侧栏双栏编辑）</label>
          <div className="row">
            {(['auto', 'mobile', 'desktop'] as const).map((t) => (
              <button key={t} className={`chip ${settings.layout === t ? 'on' : ''}`} onClick={() => updateSettings({ layout: t })}>
                {t === 'auto' ? '按屏幕宽度自动' : t === 'mobile' ? '手机版' : '桌面版'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel stack">
        <h2>同步</h2>
        <div className="row">
          {(['github', 'server'] as const).map((b) => (
            <button key={b} className={`chip ${backendKind === b ? 'on' : ''}`} onClick={() => setBackendKind(b)}>
              {b === 'github' ? 'GitHub 私有仓库' : '自托管服务器'}
            </button>
          ))}
        </div>
        {backendKind === 'github' ? (
          <>
            <p className="muted small">
              不需要任何服务器：数据存在你自己的 GitHub 私有仓库里（sync/data.json 与 sync/images/）。
              步骤：① 在 GitHub 新建一个<b>私有</b>仓库（例如 physics-cards-data）；② 在 Settings → Developer settings → Fine-grained tokens 新建令牌，Repository access 只选这个仓库，Permissions 里 Contents 设为 Read and write；③ 把令牌和仓库名填在下面。令牌只保存在本设备浏览器中。
            </p>
            <div className="field"><label>仓库（owner/repo）</label>
              <input className="input" value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} placeholder="你的用户名/physics-cards-data" autoCapitalize="off" autoCorrect="off" /></div>
            <div className="field"><label>GitHub 令牌</label>
              <input className="input" type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder="github_pat_…" autoCapitalize="off" autoCorrect="off" /></div>
            <div className="field"><label>分支</label>
              <input className="input" value={ghBranch} onChange={(e) => setGhBranch(e.target.value)} placeholder="main" autoCapitalize="off" autoCorrect="off" /></div>
          </>
        ) : (
          <>
            <p className="muted small">
              在一台电脑上运行同步服务（见 README），三台设备填写同一地址与令牌。出门使用需要 https 地址（如 Tailscale Serve）。
            </p>
            <div className="field"><label>服务器地址</label>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://你的电脑名.xxx.ts.net" autoCapitalize="off" autoCorrect="off" /></div>
            <div className="field"><label>同步令牌</label>
              <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="服务端启动时打印的令牌" autoCapitalize="off" autoCorrect="off" /></div>
          </>
        )}
        <div className="row">
          <button className="btn" disabled={!draftConfigured} onClick={async () => {
            setTesting('连接中…')
            try {
              const b = makeBackend(draftSettings)!
              const r = await testConnection(b)
              setTesting(`连接成功（${b.name} ${r.serverId.slice(0, 16)}）`)
            } catch (e) { setTesting(e instanceof Error ? e.message : '连接失败') }
          }}>测试连接</button>
          <button className="btn primary" onClick={async () => {
            const changed = JSON.stringify(makeKey(draftSettings)) !== JSON.stringify(makeKey(settings))
            await updateSettings({ ...draftSettings, lastSeq: changed ? 0 : settings.lastSeq })
            toast('同步设置已保存')
          }}>保存设置</button>
          <button className="btn" disabled={!isSyncConfigured(settings) || sync.status === 'syncing'} onClick={() => sync.sync()}>立即同步</button>
          {isSyncConfigured(settings) && (
            <button className="btn ghost" onClick={async () => {
              await updateSettings({ syncUrl: '', syncToken: '', ghToken: '', ghRepo: '', lastSeq: 0 })
              setUrl(''); setToken(''); setGhToken(''); setGhRepo(''); toast('已关闭同步')
            }}>关闭同步</button>
          )}
        </div>
        {testing && <div className="muted small">{testing}</div>}
        <div className="muted small">
          状态：{sync.status === 'off' ? '未配置' : sync.message || '空闲'}
          {sync.pendingCount ? ` · ${sync.pendingCount} 项待推送` : ''}
          {settings.lastSyncAt ? ` · 上次同步 ${fmtDateTime(settings.lastSyncAt)}` : ''}
          {' · 设备 ' + settings.deviceId.slice(0, 8)}
        </div>
        {sync.notices.length > 0 && (
          <div className="notice warn">
            {sync.notices.map((n, i) => <div key={i}>{n}</div>)}
            <button className="btn sm" style={{ marginTop: 6 }} onClick={sync.clearNotices}>知道了</button>
          </div>
        )}
      </div>

      <div className="panel stack">
        <h2>出门使用 / 离线</h2>
        <OfflineStatus />
      </div>

      <div className="panel stack">
        <h2>备份与恢复</h2>
        <p className="muted small">备份文件包含牌组、卡片（含格式与公式源码）、标签、来源、图片和全部复习记录。</p>
        <div className="row">
          <button className="btn" onClick={doExport}>导出备份（JSON）</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>导入备份…</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { void onPick(e.target.files?.[0]); e.target.value = '' }} />
        </div>
      </div>

      <div className="panel stack">
        <h2>示例数据</h2>
        <p className="muted small">示例牌组会带“示例数据”标记，与你自己的卡片分开，可随时移除。</p>
        <div className="row">
          {sampleDeck
            ? <button className="btn" onClick={async () => { await removeSampleData(); toast('已移除示例数据') }}>移除示例数据</button>
            : <button className="btn" onClick={async () => { await loadSampleData(); toast('已载入示例牌组') }}>载入示例数据</button>}
        </div>
      </div>

      <div className="panel stack">
        <h2>关于复习算法</h2>
        <p className="muted small">
          调度使用 FSRS（自由间隔重复调度器）：为每张卡估计记忆稳定性与难度，按遗忘曲线安排下一次复习。
          评“忘记”会进入短间隔重学，“轻松”会逐步拉长间隔。艾宾浩斯遗忘曲线说明了“先密后疏”的原理，
          但不存在适合每个人的唯一精确时间表，所以间隔由你的实际评分动态调整。
        </p>
      </div>

      <div className="panel stack">
        <h2>本地数据</h2>
        <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirmClear(true)}>清除本设备全部数据</button>
      </div>

      {pendingImport && (
        <Dialog title="导入备份" onClose={() => setPendingImport(null)}>
          <p>备份导出于 {fmtDateTime(pendingImport.exportedAt)}，包含 {pendingImport.decks.filter((d) => !d.deleted).length} 个牌组、{pendingImport.cards.filter((c) => !c.deleted).length} 张卡片、{pendingImport.logs.length} 条复习记录、{pendingImport.images.length} 张图片。</p>
          <div className="stack">
            <button className="btn" onClick={() => doImport('merge')}>合并到现有数据（按 id 合并，较新的记录胜出）</button>
            <button className="btn danger" onClick={() => doImport('replace')}>替换本设备全部数据</button>
            <button className="btn ghost" onClick={() => setPendingImport(null)}>取消</button>
          </div>
        </Dialog>
      )}
      {confirmClear && (
        <ConfirmDialog title="清除本设备数据" danger confirmText="清除" onClose={() => setConfirmClear(false)}
          message="将删除本设备上的全部牌组、卡片、图片和复习记录（不影响服务器和其他设备）。建议先导出备份。"
          onConfirm={async () => {
            await Promise.all([db.decks.clear(), db.cards.clear(), db.states.clear(), db.logs.clear(), db.images.clear(), db.drafts.clear(), db.sessions.clear()])
            await updateSettings({ lastSeq: 0 })
            toast('已清除本地数据')
          }} />
      )}
    </div>
  )
}

function OfflineStatus() {
  const [sw, setSw] = useState<'checking' | 'ready' | 'insecure' | 'unsupported' | 'none'>('checking')
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) { setSw('unsupported'); return }
    if (!window.isSecureContext) { setSw('insecure'); return }
    let alive = true
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!alive) return
      if (!reg || !reg.active) { setSw('none'); return }
      setSw('ready')
      const onMsg = (e: MessageEvent) => { if (e.data?.type === 'VERSION') setVersion(e.data.version) }
      navigator.serviceWorker.addEventListener('message', onMsg)
      reg.active.postMessage('GET_VERSION')
    })
    return () => { alive = false }
  }, [])
  const secure = typeof window !== 'undefined' && window.isSecureContext
  return (
    <div className="stack">
      <div className="muted small">当前地址：{typeof location !== 'undefined' ? location.origin : ''}{secure ? '（安全上下文）' : '（非 https，不能离线缓存）'}</div>
      {sw === 'ready' && <div className="notice ok">离线缓存已就绪{version ? `（版本 ${version}）` : ''}：没有网络时也能打开本应用并渲染公式；同步会在联网后自动进行。</div>}
      {sw === 'none' && <div className="notice warn">离线缓存尚未安装，刷新一次页面后再查看。</div>}
      {sw === 'insecure' && (
        <div className="notice warn">
          通过 http 局域网地址打开时浏览器不允许离线缓存，出门后打不开页面。请按 README 用 Tailscale Serve 或反向代理提供 https 地址，再用该地址「添加到主屏幕」。
        </div>
      )}
      {sw === 'unsupported' && <div className="notice warn">此浏览器不支持离线缓存。</div>}
      <p className="muted small">
        出门用流量时：页面由离线缓存提供；同步需要手机能访问同步服务器（家里电脑装 Tailscale 并开启 Tailscale Serve，或部署到有公网 https 的服务器），详见 README。
      </p>
    </div>
  )
}
