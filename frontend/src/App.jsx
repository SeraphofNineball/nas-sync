import { useState } from 'react';
import RemoteManager from './components/RemoteManager.jsx';
import JobManager from './components/JobManager.jsx';

export default function App() {
  const [tab, setTab] = useState('jobs');

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        padding: '0 24px', display: 'flex', alignItems: 'center', gap: 32, height: 56
      }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--primary)' }}>NAS Sync</span>
        <nav style={{ display: 'flex', gap: 4 }}>
          {['jobs', 'remotes'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: tab === t ? 'var(--surface2)' : 'transparent',
              color: tab === t ? 'var(--text)' : 'var(--muted)',
              border: 'none', padding: '6px 14px', borderRadius: 6,
              fontWeight: 500, cursor: 'pointer', textTransform: 'capitalize'
            }}>{t}</button>
          ))}
        </nav>
      </header>
      <main style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
        {tab === 'jobs' ? <JobManager /> : <RemoteManager />}
      </main>
    </div>
  );
}
