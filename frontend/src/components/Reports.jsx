import { useState, useEffect, useCallback } from 'react';
import { jobs as jobsApi, reports as reportsApi } from '../api.js';

function parseTs(raw) {
  const fixed = raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/, 'T$1:$2:$3.$4Z');
  const d = new Date(fixed);
  return isNaN(d) ? raw : d.toLocaleString();
}

function typeBadge(type) {
  const colors = { Run: 'var(--success)', Simulation: 'var(--warning)', Hash: 'var(--primary)' };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
      background: colors[type] + '22', color: colors[type], letterSpacing: '0.04em',
    }}>{type.toUpperCase()}</span>
  );
}

export default function Reports() {
  const [rows,      setRows]      = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [viewing,   setViewing]   = useState(null);  // {jobId, jobName, filename, ts}
  const [confirmDel, setConfirmDel] = useState(null); // same shape
  const [deleting,  setDeleting]  = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const jobList = await jobsApi.list();
      const collected = [];
      await Promise.all(jobList.map(async job => {
        const files = await reportsApi.list(job.id);
        files.forEach(filename => {
          const isSim  = filename.startsWith('sim-');
          const isHash = filename.startsWith('hash-');
          const type = isSim ? 'Simulation' : isHash ? 'Hash' : 'Run';
          const raw = filename
            .replace(/^(sim-|hash-)/, '')
            .replace(`${job.id}-`, '')
            .replace('.html', '');
          collected.push({ jobId: job.id, jobName: job.name, filename, type, raw, ts: parseTs(raw) });
        });
      }));
      collected.sort((a, b) => b.raw.localeCompare(a.raw));
      setRows(collected);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const confirmDelete = (row) => setConfirmDel(row);

  const doDelete = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    await reportsApi.remove(confirmDel.jobId, confirmDel.filename);
    setDeleting(false);
    setRows(prev => prev.filter(r => r.filename !== confirmDel.filename));
    setConfirmDel(null);
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Reports</h1>
        <button className="btn-ghost btn-sm" onClick={load} disabled={loading}>Refresh</button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
          <p style={{ margin: 0, fontSize: 15 }}>No reports yet.</p>
          <p style={{ margin: '8px 0 0', fontSize: 13 }}>Reports are generated when a job finishes running.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Job', 'Type', 'Date', ''].map(h => (
                  <th key={h} style={{
                    padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600,
                    color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.filename} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 16px', fontWeight: 500 }}>{row.jobName}</td>
                  <td style={{ padding: '10px 16px' }}>{typeBadge(row.type)}</td>
                  <td style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted)' }}>{row.ts}</td>
                  <td style={{ padding: '10px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn-ghost btn-sm" style={{ marginRight: 6 }}
                      onClick={() => setViewing(row)}>View</button>
                    <button className="btn-danger btn-sm"
                      onClick={() => confirmDelete(row)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Report viewer modal */}
      {viewing && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setViewing(null)}>
          <div className="modal" style={{ width: '90vw', maxWidth: 1100, height: '90vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h2>{viewing.jobName} — {viewing.ts}</h2>
              <button className="modal-close" onClick={() => setViewing(null)}>×</button>
            </div>
            <iframe
              title="report"
              src={reportsApi.url(viewing.jobId, viewing.filename)}
              style={{ flex: 1, width: '100%', border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
            />
            <div className="modal-footer">
              <a className="btn-ghost btn-sm" href={reportsApi.url(viewing.jobId, viewing.filename)}
                target="_blank" rel="noreferrer"
                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
                Open in new tab
              </a>
              <button className="btn-ghost" onClick={() => setViewing(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {confirmDel && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setConfirmDel(null)}>
          <div className="modal">
            <div className="modal-header">
              <h2>Delete Report</h2>
              <button className="modal-close" onClick={() => setConfirmDel(null)}>×</button>
            </div>
            <p>Delete this report? This cannot be undone.</p>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '-8px 0 0' }}>{confirmDel.jobName} — {confirmDel.ts}</p>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setConfirmDel(null)} disabled={deleting}>Cancel</button>
              <button className="btn-danger" onClick={doDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
