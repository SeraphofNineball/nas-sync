import { useState, useEffect } from 'react';
import { jobs as jobsApi, remotes as remotesApi } from '../api.js';

function fmtDate(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Dashboard() {
  const [jobList,      setJobList]      = useState([]);
  const [remoteStatus, setRemoteStatus] = useState([]);
  const [checking,     setChecking]     = useState(false);

  const loadJobs = () => jobsApi.list().then(setJobList);

  const checkRemotes = async () => {
    setChecking(true);
    setRemoteStatus(prev => prev.map(r => ({ ...r, status: 'checking' })));
    try {
      const results = await remotesApi.status();
      setRemoteStatus(results);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    loadJobs();
    // Kick off remote check without blocking mount
    remotesApi.status().then(setRemoteStatus).catch(() => {});
  }, []);

  // Poll while any job is running
  useEffect(() => {
    const running = jobList.some(j => j.status === 'running');
    if (!running) return;
    const t = setTimeout(loadJobs, 3000);
    return () => clearTimeout(t);
  }, [jobList]);

  const total   = jobList.length;
  const running = jobList.filter(j => j.status === 'running').length;
  const success = jobList.filter(j => j.status === 'success').length;
  const failed  = jobList.filter(j => j.status === 'failed').length;
  const online  = remoteStatus.filter(r => r.status === 'online').length;

  const statCards = [
    { label: 'Total Jobs',      value: total,   color: 'var(--text)' },
    { label: 'Running',         value: running, color: running > 0 ? 'var(--running)' : 'var(--text)' },
    { label: 'Last Succeeded',  value: success, color: success > 0 ? 'var(--success)' : 'var(--text)' },
    { label: 'Last Failed',     value: failed,  color: failed  > 0 ? 'var(--danger)'  : 'var(--text)' },
    { label: 'Remotes Online',  value: remoteStatus.length > 0 ? `${online}/${remoteStatus.length}` : '—',
      color: remoteStatus.length > 0 && online === remoteStatus.length ? 'var(--success)'
           : remoteStatus.length > 0 && online < remoteStatus.length  ? 'var(--warning)'
           : 'var(--text)' },
  ];

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 20 }}>Dashboard</h2>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 28 }}>
        {statCards.map(c => (
          <div key={c.label} className="stat-card">
            <div className="stat-card-value" style={{ color: c.color }}>{c.value}</div>
            <div className="stat-card-label">{c.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* Remote status */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div className="section-label">Remote Status</div>
            <button className="btn-ghost btn-sm" onClick={checkRemotes} disabled={checking}>
              {checking ? 'Checking…' : 'Refresh'}
            </button>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {remoteStatus.length === 0 ? (
              <div style={{ padding: '20px', color: 'var(--muted)', textAlign: 'center', fontSize: 13 }}>
                {checking ? 'Checking remotes…' : 'No remotes configured'}
              </div>
            ) : (
              remoteStatus.map((r, i) => (
                <div key={r.name} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px',
                  borderBottom: i < remoteStatus.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <span className={`status-dot status-dot-${r.status}`} />
                  <span style={{ flex: 1, fontWeight: 500 }}>{r.name}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 600,
                    color: r.status === 'online' ? 'var(--success)'
                         : r.status === 'checking' ? 'var(--muted)'
                         : 'var(--danger)',
                  }}>{r.status}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Job overview */}
        <div>
          <div className="section-label" style={{ marginBottom: 10 }}>Job Overview</div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {jobList.length === 0 ? (
              <div style={{ padding: '20px', color: 'var(--muted)', textAlign: 'center', fontSize: 13 }}>
                No jobs configured
              </div>
            ) : (
              jobList.map((job, i) => (
                <div key={job.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 14px',
                  borderBottom: i < jobList.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <span className={`badge badge-${job.status || 'idle'}`}>{job.status || 'idle'}</span>
                  <span style={{ flex: 1, fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.name}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
                    {fmtDate(job.lastRun)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
