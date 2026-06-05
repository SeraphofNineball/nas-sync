import { useState, useEffect, useCallback, useRef } from 'react';
import { remotes as remotesApi, jobs as jobsApi, logs as logsApi, reports as reportsApi } from '../api.js';
import FileBrowser from './FileBrowser.jsx';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Parse a stored cron string back into form fields for editing.
function parseCron(cron) {
  const def = { scheduleMode: 'manual', scheduleTime: '02:00', scheduleDow: '0', scheduleDom: '1', customSchedule: '' };
  if (!cron) return def;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...def, scheduleMode: 'custom', customSchedule: cron };
  const [min, hour, dom, , dow] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return { ...def, scheduleMode: 'custom', customSchedule: cron };
  const time = `${String(+hour).padStart(2, '0')}:${String(+min).padStart(2, '0')}`;
  if (dom === '*' && dow === '*')          return { ...def, scheduleMode: 'daily',   scheduleTime: time };
  if (dom === '*' && /^\d$/.test(dow))    return { ...def, scheduleMode: 'weekly',  scheduleTime: time, scheduleDow: dow };
  if (/^\d+$/.test(dom) && dow === '*')   return { ...def, scheduleMode: 'monthly', scheduleTime: time, scheduleDom: dom };
  return { ...def, scheduleMode: 'custom', customSchedule: cron };
}

// Build a cron string from form fields.
function buildCron(form) {
  const [hh, mm] = (form.scheduleTime || '00:00').split(':').map(Number);
  switch (form.scheduleMode) {
    case 'daily':   return `${mm} ${hh} * * *`;
    case 'weekly':  return `${mm} ${hh} * * ${form.scheduleDow}`;
    case 'monthly': return `${mm} ${hh} ${form.scheduleDom} * *`;
    case 'custom':  return form.customSchedule || '';
    default:        return '';
  }
}

// Human-readable label shown on the job card.
function describeSchedule(cron) {
  if (!cron) return 'Manual';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return cron;
  const time = `${String(+hour).padStart(2, '0')}:${String(+min).padStart(2, '0')}`;
  if (dom === '*' && dow === '*')        return `Daily at ${time}`;
  if (dom === '*' && /^\d$/.test(dow))  return `Weekly on ${DAYS[+dow]} at ${time}`;
  if (/^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${time}`;
  return cron;
}

const EMPTY_FORM = {
  name: '', type: 'mirror',
  sourceRemote: '', sourcePath: '', destRemote: '', destPath: '',
  scheduleMode: 'manual', scheduleTime: '02:00',
  scheduleDow: '0', scheduleDom: '1', customSchedule: '',
  enabled: true,
};

function isHashJob(type) { return type === 'hash-capture'; }

function fmtElapsed(startTime) {
  if (!startTime) return '';
  const s = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export default function JobManager() {
  const [jobList,    setJobList]    = useState([]);
  const [remoteList, setRemoteList] = useState([]);
  const [showForm,   setShowForm]   = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [error,      setError]      = useState('');
  const [saving,     setSaving]     = useState(false);
  const [logJob,     setLogJob]     = useState(null);
  const [logFiles,   setLogFiles]   = useState([]);
  const [logContent, setLogContent] = useState('');
  const [logFile,    setLogFile]    = useState('');
  const [reportJob,  setReportJob]  = useState(null);
  const [reportFiles, setReportFiles] = useState([]);
  const [reportFile, setReportFile] = useState('');
  const [browser,    setBrowser]    = useState(null);
  const [now,        setNow]        = useState(Date.now());
  const [confirmJob, setConfirmJob] = useState(null);

  const loadJobs    = useCallback(() => jobsApi.list().then(setJobList), []);
  const loadRemotes = useCallback(() => remotesApi.list().then(setRemoteList), []);

  // Track pending refresh timers so they can be cancelled if the component
  // unmounts before they fire, preventing state updates on unmounted components.
  const pendingTimers = useRef([]);
  useEffect(() => () => { pendingTimers.current.forEach(clearTimeout); }, []);

  const scheduleRefresh = useCallback((ms = 500) => {
    const id = setTimeout(() => {
      pendingTimers.current = pendingTimers.current.filter(t => t !== id);
      loadJobs();
    }, ms);
    pendingTimers.current.push(id);
  }, [loadJobs]);

  useEffect(() => { loadJobs(); loadRemotes(); }, []);

  // Poll every 3s while any job is running or simulating
  useEffect(() => {
    const busy = jobList.some(j => j.status === 'running' || j.simulating);
    if (!busy) return;
    const t = setTimeout(loadJobs, 3000);
    return () => clearTimeout(t);
  }, [jobList]);

  // Tick elapsed timer every second while any job is running or simulating
  useEffect(() => {
    const busy = jobList.some(j => j.status === 'running' || j.simulating);
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [jobList]);

  const openAdd = () => {
    setEditing(null); setForm(EMPTY_FORM); setError(''); setShowForm(true);
  };

  const openEdit = (job) => {
    setEditing(job.id);
    setForm({
      name: job.name, type: job.type,
      sourceRemote: job.sourceRemote || '', sourcePath: job.sourcePath || '',
      destRemote: job.destRemote || '',     destPath: job.destPath || '',
      ...parseCron(job.schedule),
      enabled: job.enabled,
    });
    setError(''); setShowForm(true);
  };

  const submit = async () => {
    if (!form.name.trim()) return setError('Job name is required');
    if (!form.sourceRemote) return setError('Source remote is required');
    if (!isHashJob(form.type) && !form.destRemote) return setError('Destination remote is required');
    setSaving(true); setError('');
    const schedule = buildCron(form);
    const payload = {
      name: form.name.trim(), type: form.type,
      sourceRemote: form.sourceRemote, sourcePath: form.sourcePath,
      destRemote: form.destRemote,     destPath: form.destPath,
      schedule, enabled: form.enabled,
    };
    const res = editing ? await jobsApi.update(editing, payload) : await jobsApi.create(payload);
    setSaving(false);
    if (res.error) return setError(res.error);
    setShowForm(false); loadJobs();
  };

  const runJob = async (id) => {
    await jobsApi.run(id);
    scheduleRefresh(500);
  };

  const simulateJob = async (id) => {
    await jobsApi.simulate(id);
    scheduleRefresh(500);
  };

  const stopJob = async (id) => {
    await jobsApi.stop(id);
    scheduleRefresh(800);
  };

  const stopAll = async () => {
    await jobsApi.stopAll();
    scheduleRefresh(800);
  };

  const removeJob = async (id) => {
    await jobsApi.remove(id);
    setConfirmJob(null);
    loadJobs();
  };

  const openLogs = async (job) => {
    setLogJob(job); setLogContent(''); setLogFile('');
    const files = await logsApi.list(job.id);
    setLogFiles(files);
    if (files.length > 0) loadLog(job.id, files[0]);
  };

  const loadLog = async (jobId, filename) => {
    setLogFile(filename);
    const res = await logsApi.get(jobId, filename);
    setLogContent(res.content || '');
  };

  const openReports = async (job) => {
    setReportJob(job); setReportFile('');
    const files = await reportsApi.list(job.id);
    setReportFiles(files);
    if (files.length > 0) setReportFile(files[0]);
  };

  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));

  const scheduleLabel = (job) => describeSchedule(job.schedule);

  const anyRunning = jobList.some(j => j.status === 'running' || j.simulating);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18 }}>Jobs</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {anyRunning && (
            <button className="btn-danger btn-sm" onClick={stopAll}>Stop All</button>
          )}
          <button className="btn-primary" onClick={openAdd}>+ New Job</button>
        </div>
      </div>

      {jobList.length === 0 ? (
        <div className="card" style={{ color: 'var(--muted)', textAlign: 'center', padding: 40 }}>
          No jobs yet. Create one to start syncing.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {jobList.map(job => {
            const p = job.progress;
            const isRunning = job.status === 'running';
            const isSimulating = !!job.simulating;
            const isBusy = isRunning || isSimulating;
            const hasPercent = p && p.percent != null && p.percent > 0;
            const badgeKind = isSimulating ? 'running' : (job.status || 'idle');
            const badgeLabel = isSimulating ? 'simulating' : (job.status || 'idle');
            return (
              <div key={job.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{job.name}</span>
                      <span className={`badge badge-${badgeKind}`}>{badgeLabel}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4 }}>
                        {job.type}
                      </span>
                      {!job.enabled && <span style={{ fontSize: 11, color: 'var(--muted)' }}>disabled</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {isHashJob(job.type)
                        ? `${job.sourceRemote}:${job.sourcePath || ''}`
                        : `${job.sourceRemote}:${job.sourcePath || ''} → ${job.destRemote}:${job.destPath || ''}`
                      }
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      Schedule: {scheduleLabel(job)}
                      {job.lastRun && ` · Last run: ${new Date(job.lastRun).toLocaleString()}`}
                    </div>
                    {job.lastError && job.status === 'failed' && (
                      <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 2 }}>{job.lastError}</div>
                    )}

                    {/* Progress section */}
                    {isBusy && (
                      <div style={{ marginTop: 8 }}>
                        <div className={`progress-bar${hasPercent ? '' : ' progress-bar-indeterminate'}`}>
                          <div className="progress-bar-fill" style={{ width: `${hasPercent ? p.percent : 0}%` }} />
                        </div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)', marginTop: 4, flexWrap: 'wrap' }}>
                          {isSimulating && (
                            <span style={{ color: 'var(--warning)', fontWeight: 600 }}>DRY-RUN</span>
                          )}
                          <span style={{ color: 'var(--text)', fontWeight: 500 }}>
                            {hasPercent ? `${p.percent}%` : 'Starting…'}
                          </span>
                          {p?.transferred && p?.total && (
                            <span>{p.transferred} / {p.total}</span>
                          )}
                          {p?.speed && (
                            <span style={{ color: 'var(--running)', fontWeight: 500 }}>↑ {p.speed}</span>
                          )}
                          {p?.files != null && p?.totalFiles != null && (
                            <span>{p.files.toLocaleString()} / {p.totalFiles.toLocaleString()} files</span>
                          )}
                          {p?.errors > 0 && (
                            <span style={{ color: 'var(--danger)' }}>{p.errors} errors</span>
                          )}
                          {p?.eta && p.eta !== '-' && <span>ETA {p.eta}</span>}
                          {p?.startTime && (
                            <span>Elapsed {fmtElapsed(p.startTime)}</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Last summary (post-run) */}
                    {!isBusy && job.lastSummary && job.lastSummary.jobKind === 'hash-capture' && (
                      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)', marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {job.lastSummary.isFirstRun ? (
                          <span style={{ color: 'var(--info, #1565C0)', fontWeight: 600 }}>Baseline established</span>
                        ) : job.lastSummary.hasChanges ? (
                          <span style={{ color: 'var(--danger)', fontWeight: 700 }}>CHANGES DETECTED</span>
                        ) : (
                          <span style={{ color: 'var(--success)', fontWeight: 600 }}>Clean — no changes</span>
                        )}
                        <span>{job.lastSummary.totalFiles.toLocaleString()} files</span>
                        {!job.lastSummary.isFirstRun && job.lastSummary.modified > 0 && (
                          <span style={{ color: 'var(--danger)' }}>{job.lastSummary.modified} modified</span>
                        )}
                        {!job.lastSummary.isFirstRun && job.lastSummary.added > 0 && (
                          <span style={{ color: 'var(--warning)' }}>{job.lastSummary.added} added</span>
                        )}
                        {!job.lastSummary.isFirstRun && job.lastSummary.deleted > 0 && (
                          <span style={{ color: 'var(--warning)' }}>{job.lastSummary.deleted} deleted</span>
                        )}
                      </div>
                    )}
                    {!isBusy && job.lastSummary && job.lastSummary.jobKind !== 'hash-capture' && (
                      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)', marginTop: 6, flexWrap: 'wrap' }}>
                        <span>Copied {job.lastSummary.copied.toLocaleString()}</span>
                        <span>Deleted {job.lastSummary.deleted.toLocaleString()}</span>
                        {job.lastSummary.updated > 0 && <span>Updated {job.lastSummary.updated.toLocaleString()}</span>}
                        {job.lastSummary.errors > 0 && (
                          <span style={{ color: 'var(--danger)' }}>{job.lastSummary.errors} errors</span>
                        )}
                        {job.lastSummary.integrity && (
                          <span style={{ color: job.lastSummary.integrity.ok ? 'var(--success)' : 'var(--danger)', fontWeight: 500 }}>
                            Integrity: {job.lastSummary.integrity.ok ? '✓ pass' : `✗ ${job.lastSummary.integrity.differences + job.lastSummary.integrity.missing} diff`}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Last simulation summary */}
                    {!isBusy && job.lastSimulation && (
                      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)', marginTop: 4, flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--warning)', fontWeight: 600 }}>SIM</span>
                        <span>Would copy {job.lastSimulation.wouldCopy.toLocaleString()}</span>
                        <span>Would delete {job.lastSimulation.wouldDelete.toLocaleString()}</span>
                        {job.lastSimulation.wouldUpdate > 0 && <span>Would update {job.lastSimulation.wouldUpdate.toLocaleString()}</span>}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {isBusy ? (
                      <button className="btn-danger btn-sm" onClick={() => stopJob(job.id)}>Stop</button>
                    ) : (
                      <>
                        <button className="btn-ghost btn-sm" onClick={() => runJob(job.id)}>Run</button>
                        {!isHashJob(job.type) && (
                          <button className="btn-ghost btn-sm" onClick={() => simulateJob(job.id)} title="Dry run — show what would change without modifying anything">Simulate</button>
                        )}
                      </>
                    )}
                    <button className="btn-ghost btn-sm" onClick={() => openReports(job)}>Report</button>
                    <button className="btn-ghost btn-sm" onClick={() => openLogs(job)}>Logs</button>
                    <button className="btn-ghost btn-sm" onClick={() => openEdit(job)} disabled={isBusy}>Edit</button>
                    <button className="btn-danger btn-sm" onClick={() => setConfirmJob(job.id)}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmJob && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setConfirmJob(null)}>
          <div className="modal">
            <div className="modal-header">
              <h2>Delete Job</h2>
              <button className="modal-close" onClick={() => setConfirmJob(null)}>×</button>
            </div>
            <p>Delete this job? This cannot be undone.</p>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setConfirmJob(null)}>Cancel</button>
              <button className="btn-danger" onClick={() => removeJob(confirmJob)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Job form modal */}
      {showForm && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setShowForm(false)}>
          <div className="modal">
            <div className="modal-header">
              <h2>{editing ? 'Edit Job' : 'New Job'}</h2>
              <button className="modal-close" onClick={() => setShowForm(false)}>×</button>
            </div>

            <div className="field">
              <label>Job Name</label>
              <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Mirror Media to WD NAS" />
            </div>

            <div className="field">
              <label>Type</label>
              <select value={form.type} onChange={e => set('type', e.target.value)}>
                <option value="mirror">Mirror — exact copy, deletions included</option>
                <option value="sync">Sync — copy new/changed, no deletions</option>
                <option value="backup">Backup — versioned, keeps deleted files</option>
                <option value="hash-capture">Hash Monitor — detect file tampering via SHA-256</option>
              </select>
            </div>

            {isHashJob(form.type) && (
              <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--surface2)', fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                Scans the source directory with rclone hashsum SHA-256 and stores a snapshot. Each run compares against the previous snapshot and flags modified, added, or deleted files.
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>{isHashJob(form.type) ? 'Remote' : 'Source Remote'}</label>
                <select value={form.sourceRemote} onChange={e => set('sourceRemote', e.target.value)}>
                  <option value="">Select remote…</option>
                  {remoteList.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="field">
                <label>{isHashJob(form.type) ? 'Directory to Monitor' : 'Source Path'}</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={form.sourcePath} onChange={e => set('sourcePath', e.target.value)} placeholder="e.g. Media/Movies" />
                  <button type="button" className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    disabled={!form.sourceRemote}
                    onClick={() => setBrowser({ field: 'sourcePath', remote: form.sourceRemote })}>
                    Browse
                  </button>
                </div>
              </div>
              {!isHashJob(form.type) && (
                <>
                  <div className="field">
                    <label>Destination Remote</label>
                    <select value={form.destRemote} onChange={e => set('destRemote', e.target.value)}>
                      <option value="">Select remote…</option>
                      {remoteList.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>Destination Path</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input value={form.destPath} onChange={e => set('destPath', e.target.value)} placeholder="e.g. Backups/Media" />
                      <button type="button" className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                        disabled={!form.destRemote}
                        onClick={() => setBrowser({ field: 'destPath', remote: form.destRemote })}>
                        Browse
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="field">
              <label>Schedule</label>
              <select value={form.scheduleMode} onChange={e => set('scheduleMode', e.target.value)}>
                <option value="manual">Manual only</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom cron…</option>
              </select>
            </div>
            {(form.scheduleMode === 'daily' || form.scheduleMode === 'weekly' || form.scheduleMode === 'monthly') && (
              <div style={{ display: 'grid', gridTemplateColumns: form.scheduleMode === 'manual' ? '1fr' : 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                {form.scheduleMode === 'weekly' && (
                  <div className="field">
                    <label>Day of Week</label>
                    <select value={form.scheduleDow} onChange={e => set('scheduleDow', e.target.value)}>
                      {DAYS.map((d, i) => <option key={i} value={String(i)}>{d}</option>)}
                    </select>
                  </div>
                )}
                {form.scheduleMode === 'monthly' && (
                  <div className="field">
                    <label>Day of Month</label>
                    <select value={form.scheduleDom} onChange={e => set('scheduleDom', e.target.value)}>
                      {Array.from({ length: 31 }, (_, i) => (
                        <option key={i + 1} value={String(i + 1)}>{i + 1}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label>Time</label>
                  <input type="time" value={form.scheduleTime} onChange={e => set('scheduleTime', e.target.value)} />
                </div>
              </div>
            )}
            {form.scheduleMode === 'custom' && (
              <div className="field">
                <label>Cron Expression</label>
                <input value={form.customSchedule} onChange={e => set('customSchedule', e.target.value)} placeholder="0 2 * * *" />
              </div>
            )}

            <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="enabled" style={{ width: 'auto' }} checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
              <label htmlFor="enabled" style={{ margin: 0, cursor: 'pointer' }}>Enabled</label>
            </div>

            {error && <p className="error-msg">{error}</p>}
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn-primary" onClick={submit} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Job'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* File browser modal */}
      {browser && (
        <FileBrowser
          remote={browser.remote}
          initialPath={form[browser.field] || ''}
          onSelect={path => { set(browser.field, path); setBrowser(null); }}
          onClose={() => setBrowser(null)}
        />
      )}

      {/* Report viewer modal */}
      {reportJob && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setReportJob(null)}>
          <div className="modal" style={{ width: '90vw', maxWidth: 1100, height: '90vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h2>Report — {reportJob.name}</h2>
              <button className="modal-close" onClick={() => setReportJob(null)}>×</button>
            </div>
            {reportFiles.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No reports yet. Run the job and let it complete.</p>
            ) : (
              <>
                <div className="field">
                  <label>Run</label>
                  <select value={reportFile} onChange={e => setReportFile(e.target.value)}>
                    {reportFiles.map(f => {
                      const isSim  = f.startsWith('sim-');
                      const isHash = f.startsWith('hash-');
                      const ts = f.replace(/^(sim-|hash-)/, '').replace(`${reportJob.id}-`, '').replace('.html', '');
                      const prefix = isSim ? '[Simulation] ' : isHash ? '[Hash] ' : '';
                      return <option key={f} value={f}>{prefix}{ts}</option>;
                    })}
                  </select>
                </div>
                <iframe
                  title="report"
                  src={reportFile ? reportsApi.url(reportJob.id, reportFile) : 'about:blank'}
                  style={{ flex: 1, width: '100%', border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
                />
              </>
            )}
            <div className="modal-footer">
              {reportFile && (
                <a className="btn-ghost btn-sm" href={reportsApi.url(reportJob.id, reportFile)} target="_blank" rel="noreferrer"
                   style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
                  Open in new tab
                </a>
              )}
              <button className="btn-ghost" onClick={() => setReportJob(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Log viewer modal */}
      {logJob && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setLogJob(null)}>
          <div className="modal" style={{ width: 700 }}>
            <div className="modal-header">
              <h2>Logs — {logJob.name}</h2>
              <button className="modal-close" onClick={() => setLogJob(null)}>×</button>
            </div>
            {logFiles.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>No logs yet. Run the job first.</p>
            ) : (
              <>
                <div className="field">
                  <label>Log File</label>
                  <select value={logFile} onChange={e => loadLog(logJob.id, e.target.value)}>
                    {logFiles.map(f => <option key={f} value={f}>{f.split('-').slice(1).join('-').replace('.log', '')}</option>)}
                  </select>
                </div>
                <textarea readOnly value={logContent}
                  style={{ height: 300, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }} />
              </>
            )}
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setLogJob(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
