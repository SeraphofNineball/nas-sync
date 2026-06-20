import { useState, useEffect } from 'react';
import RemoteManager from './components/RemoteManager.jsx';
import JobManager from './components/JobManager.jsx';
import Dashboard from './components/Dashboard.jsx';
import Reports from './components/Reports.jsx';

const THEMES = [
  { value: 'dark',          label: 'Dark' },
  { value: 'light',         label: 'Light' },
  { value: 'high-contrast', label: 'High Contrast' },
  { value: 'vscode',        label: 'VS Code' },
  { value: 'monokai',       label: 'Monokai' },
  { value: 'solarized',     label: 'Solarized' },
];

const TABS = ['dashboard', 'jobs', 'remotes', 'reports'];

export default function App() {
  const [tab,   setTab]   = useState('dashboard');
  const [theme, setTheme] = useState(() => localStorage.getItem('nas-sync-theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nas-sync-theme', theme);
  }, [theme]);

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        padding: '0 24px', display: 'flex', alignItems: 'center', gap: 24, height: 56,
      }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--primary)', flexShrink: 0 }}>NAS Sync</span>
        <nav style={{ display: 'flex', gap: 4, flex: 1 }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: tab === t ? 'var(--surface2)' : 'transparent',
              color: tab === t ? 'var(--text)' : 'var(--muted)',
              border: 'none', padding: '6px 14px', borderRadius: 6,
              fontWeight: 500, cursor: 'pointer', textTransform: 'capitalize',
            }}>{t}</button>
          ))}
        </nav>
        <select
          value={theme}
          onChange={e => setTheme(e.target.value)}
          style={{ width: 'auto', padding: '5px 8px', fontSize: 12, flexShrink: 0 }}
        >
          {THEMES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </header>
      <main style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'jobs'      && <JobManager />}
        {tab === 'remotes'   && <RemoteManager />}
        {tab === 'reports'   && <Reports />}
      </main>
    </div>
  );
}
