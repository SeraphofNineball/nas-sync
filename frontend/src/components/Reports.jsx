import { useState, useEffect, useCallback, useRef } from 'react';
import { jobs as jobsApi, reports as reportsApi } from '../api.js';

const PAGE_SIZE = 15;

const STATUS_META = {
  success:  { label: 'Success',  color: 'var(--success)' },
  failed:   { label: 'Failed',   color: 'var(--danger)'  },
  stopped:  { label: 'Stopped',  color: 'var(--warning)' },
  baseline: { label: 'Baseline', color: 'var(--primary)' },
  changes:  { label: 'Changes',  color: '#f97316'        },
  clean:    { label: 'Clean',    color: 'var(--success)'  },
};

const TYPE_META = {
  Run:        { color: 'var(--success)' },
  Simulation: { color: 'var(--warning)' },
  Hash:       { color: 'var(--primary)' },
};

function Badge({ label, color }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
      background: color + '22', color, letterSpacing: '0.04em', whiteSpace: 'nowrap',
    }}>{label.toUpperCase()}</span>
  );
}

function parseTs(raw) {
  const fixed = raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/, 'T$1:$2:$3.$4Z');
  const d = new Date(fixed);
  return isNaN(d) ? raw : d.toLocaleString();
}

export default function Reports() {
  const [rows,       setRows]       = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [viewing,    setViewing]    = useState(null);
  const [confirmDel, setConfirmDel] = useState(null); // null | { kind: 'single', row } | { kind: 'bulk' }
  const [deleting,   setDeleting]   = useState(false);
  const [selected,   setSelected]   = useState(new Set());
  const [page,       setPage]       = useState(0);
  const [filters,    setFilters]    = useState({ job: '', type: '', status: '', dateFrom: '', dateTo: '' });

  const headerCheckRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const jobList = await jobsApi.list();
      const collected = [];
      await Promise.all(jobList.map(async job => {
        const items = await reportsApi.list(job.id);
        items.forEach(({ filename, status }) => {
          const isSim  = filename.startsWith('sim-');
          const isHash = filename.startsWith('hash-');
          const type = isSim ? 'Simulation' : isHash ? 'Hash' : 'Run';
          const raw = filename
            .replace(/^(sim-|hash-)/, '')
            .replace(`${job.id}-`, '')
            .replace('.html', '');
          collected.push({ jobId: job.id, jobName: job.name, filename, type, raw, ts: parseTs(raw), status });
        });
      }));
      collected.sort((a, b) => b.raw.localeCompare(a.raw));
      setRows(collected);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Derived filter options from loaded data
  const jobNames = [...new Set(rows.map(r => r.jobName))].sort();
  const knownStatuses = [...new Set(rows.map(r => r.status).filter(Boolean))].sort();

  const setFilter = (key, val) => {
    setFilters(prev => ({ ...prev, [key]: val }));
    setPage(0);
  };
  const clearFilters = () => {
    setFilters({ job: '', type: '', status: '', dateFrom: '', dateTo: '' });
    setPage(0);
  };
  const hasFilters = Object.values(filters).some(Boolean);

  // Apply filters
  const filtered = rows.filter(r => {
    if (filters.job    && r.jobName !== filters.job)   return false;
    if (filters.type   && r.type    !== filters.type)  return false;
    if (filters.status && r.status  !== filters.status) return false;
    if (filters.dateFrom && r.raw.slice(0, 10) < filters.dateFrom) return false;
    if (filters.dateTo   && r.raw.slice(0, 10) > filters.dateTo)   return false;
    return true;
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage  = Math.min(page, pageCount - 1);
  const pageRows  = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const pageKeys  = new Set(pageRows.map(r => r.filename));
  const allPageSelected  = pageRows.length > 0 && pageRows.every(r => selected.has(r.filename));
  const somePageSelected = !allPageSelected && pageRows.some(r => selected.has(r.filename));

  // Drive the indeterminate state imperatively — React doesn't support it as a prop
  useEffect(() => {
    if (headerCheckRef.current) {
      headerCheckRef.current.indeterminate = somePageSelected;
    }
  }, [somePageSelected]);

  const toggleRow = (filename) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(filename) ? next.delete(filename) : next.add(filename);
      return next;
    });
  };

  const togglePage = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allPageSelected) {
        pageKeys.forEach(k => next.delete(k));
      } else {
        pageKeys.forEach(k => next.add(k));
      }
      return next;
    });
  };

  const doDelete = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    try {
      if (confirmDel.kind === 'single') {
        await reportsApi.remove(confirmDel.row.jobId, confirmDel.row.filename);
        setRows(prev => prev.filter(r => r.filename !== confirmDel.row.filename));
        setSelected(prev => { const n = new Set(prev); n.delete(confirmDel.row.filename); return n; });
      } else {
        const toDelete = rows.filter(r => selected.has(r.filename));
        await Promise.all(toDelete.map(r => reportsApi.remove(r.jobId, r.filename)));
        const gone = new Set(toDelete.map(r => r.filename));
        setRows(prev => prev.filter(r => !gone.has(r.filename)));
        setSelected(new Set());
      }
    } finally {
      setDeleting(false);
      setConfirmDel(null);
    }
  };

  const selCount = selected.size;

  const thStyle = {
    padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600,
    color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
  };

  return (
    <>
      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Reports</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {selCount > 0 && (
            <button className="btn-danger btn-sm" onClick={() => setConfirmDel({ kind: 'bulk' })}>
              Delete Selected ({selCount})
            </button>
          )}
          <button className="btn-ghost btn-sm" onClick={load} disabled={loading}>Refresh</button>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={filters.job} onChange={e => setFilter('job', e.target.value)} style={{ minWidth: 140 }}>
            <option value="">All Jobs</option>
            {jobNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>

          <select value={filters.type} onChange={e => setFilter('type', e.target.value)} style={{ minWidth: 130 }}>
            <option value="">All Types</option>
            <option value="Run">Run</option>
            <option value="Simulation">Simulation</option>
            <option value="Hash">Hash</option>
          </select>

          <select value={filters.status} onChange={e => setFilter('status', e.target.value)} style={{ minWidth: 140 }}>
            <option value="">All Statuses</option>
            {knownStatuses.map(s => (
              <option key={s} value={s}>{STATUS_META[s]?.label ?? s}</option>
            ))}
          </select>

          <input
            type="date" value={filters.dateFrom}
            onChange={e => setFilter('dateFrom', e.target.value)}
            title="Date from" style={{ width: 140 }}
          />
          <input
            type="date" value={filters.dateTo}
            onChange={e => setFilter('dateTo', e.target.value)}
            title="Date to" style={{ width: 140 }}
          />

          {hasFilters && (
            <button className="btn-ghost btn-sm" onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
          {rows.length === 0 ? (
            <>
              <p style={{ margin: 0, fontSize: 15 }}>No reports yet.</p>
              <p style={{ margin: '8px 0 0', fontSize: 13 }}>Reports are generated when a job finishes running.</p>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 15 }}>No reports match the active filters.</p>
          )}
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '10px 12px', width: 36 }}>
                    <input
                      type="checkbox"
                      ref={headerCheckRef}
                      checked={allPageSelected}
                      onChange={togglePage}
                    />
                  </th>
                  <th style={thStyle}>Job Name</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(row => {
                  const typeMeta   = TYPE_META[row.type]   || { color: 'var(--muted)' };
                  const statusMeta = STATUS_META[row.status];
                  return (
                    <tr key={row.filename} style={{
                      borderBottom: '1px solid var(--border)',
                      background: selected.has(row.filename) ? 'var(--surface2)' : undefined,
                    }}>
                      <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={selected.has(row.filename)}
                          onChange={() => toggleRow(row.filename)}
                        />
                      </td>
                      <td style={{ padding: '10px 16px', fontWeight: 500 }}>{row.jobName}</td>
                      <td style={{ padding: '10px 16px' }}>
                        <Badge label={row.type} color={typeMeta.color} />
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        {statusMeta
                          ? <Badge label={statusMeta.label} color={statusMeta.color} />
                          : <span style={{ color: 'var(--muted)' }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 16px', fontSize: 13, color: 'var(--muted)' }}>{row.ts}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn-ghost btn-sm" style={{ marginRight: 6 }}
                          onClick={() => setViewing(row)}>View</button>
                        <button className="btn-danger btn-sm"
                          onClick={() => setConfirmDel({ kind: 'single', row })}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination + summary */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>
              {filtered.length} report{filtered.length !== 1 ? 's' : ''}
              {selCount > 0 && ` · ${selCount} selected`}
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn-ghost btn-sm"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={safePage === 0}
              >← Prev</button>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                Page {safePage + 1} of {pageCount}
              </span>
              <button
                className="btn-ghost btn-sm"
                onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
              >Next →</button>
            </div>
          </div>
        </>
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
              <a className="btn-ghost btn-sm"
                href={reportsApi.url(viewing.jobId, viewing.filename)}
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
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && !deleting && setConfirmDel(null)}>
          <div className="modal">
            <div className="modal-header">
              <h2>Delete {confirmDel.kind === 'bulk' ? 'Reports' : 'Report'}</h2>
              <button className="modal-close" onClick={() => !deleting && setConfirmDel(null)}>×</button>
            </div>
            {confirmDel.kind === 'bulk' ? (
              <p>Delete {selCount} selected report{selCount !== 1 ? 's' : ''}? This cannot be undone.</p>
            ) : (
              <>
                <p>Delete this report? This cannot be undone.</p>
                <p style={{ fontSize: 13, color: 'var(--muted)', margin: '-8px 0 0' }}>
                  {confirmDel.row.jobName} — {confirmDel.row.ts}
                </p>
              </>
            )}
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
