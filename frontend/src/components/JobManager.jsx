import { useState, useEffect, useCallback } from 'react';
import { remotes as remotesApi, jobs as jobsApi, logs as logsApi } from '../api.js';
import FileBrowser from './FileBrowser.jsx';

const SCHEDULES = [
  { label: 'Manual only',       value: '' },
  { label: 'Every hour',        value: '0 * * * *' },
  { label: 'Every 6 hours',     value: '0 */6 * * *' },
  { label: 'Every 12 hours',    value: '0 */12 * * *' },
  { label: 'Daily at 2 AM',     value: '0 2 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Weekly (Sun 3 AM)', value: '0 3 * * 0' },
  { label: 'Custom cron…',      value: 'custom' },
];

const EMPTY_FORM = {
  name: '', type: 'mirror',
  sourceRemote: '', sourcePath: '', destRemote: '', destPath: '',
  schedule: '', customSchedule: '', enabled: true,
};

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
  const [browser,    setBrowser]    = useState(null);
  const [now,        setNow]        = useState(Date.now());

  const loadJobs    = useCallback(() => jobsApi.list().then(setJobList), []);
  const loadRemotes = useCallback(() => remotesApi.list().then(setRemoteList), []);

  useEffect(() => { loadJobs(); loadRemotes(); }, []);

  // Poll every 3s while any job is running
  useEffect(() => {
    const running = jobList.some(j => j.status === 'running');
    if (!running) return;
    const t = setTimeout(loadJobs, 3000);
    return () => clearTimeout(t);
  }, [jobList]);

  // Tick elapsed timer every second while any job is running
  useEffect(() => {
    const running = jobList.some(j => j.status === 'running');
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [jobList]);

  const openAdd = () => {
    setEditing(null); setForm(EMPTY_FORM); setError(''); setShowForm(true);
  };

  const openEdit = (job) => {
    setEditing(job.id);
    const preset = SCHEDULES.find(s => s.value === job.schedule && s.value !== 'custom');
    setForm({
      name: job.name, type: job.type,
      sourceRemote: job.sourceRemote, sourcePath: job.sourcePath || '',
      destRemote: job.destRemote,     destPath: job.destPath || '',
      schedule: preset ? job.schedule : 'custom',
      customSchedule: preset ? '' : (job.schedule || ''),
      enabled: job.enabled,
    });
    setError(''); setShowForm(true);
  };

  const submit = async () => {
    if (!form.name.trim()) return setError('Job name is required');
    if (!form.sourceRemote || !form.destRemote) return setError('Source and destination remotes are required');
    setSaving(true); setError('');
    const schedule = form.schedule === 'custom' ? form.customSchedule : form.schedule;
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
    setTimeout(loadJobs, 500);
  };

  const stopJob = async (id) => {
    await jobsApi.stop(id);
    setTimeout(loadJobs, 800);
  };

  const stopAll = async () => {
    await jobsApi.stopAll();
    setTimeout(loadJobs, 800);
  };

  const removeJob = async (id) => {
    if (!confirm('Delete this job?')) return;
    await jobsApi.remove(id);
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

  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));

  const scheduleLabel = (job) => {
    const preset = SCHEDULES.find(s => s.value === job.schedule && s.value !== '');
    return job.schedule ? (preset?.label || job.schedule) : 'Manual';
  };

  const anyRunning = jobList.some(j => j.status === 'running');

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
            const hasPercent = p && p.percent != null && p.percent > 0;
            return (
              <div key={job.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{job.name}</span>
                      <span className={`badge badge-${job.status || 'idle'}`}>{job.status || 'idle'}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4 }}>
                        {job.type}
                      </span>
                      {!job.enabled && <span style={{ fontSize: 11, color: 'var(--muted)' }}>disabled</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {job.sourceRemote}:{job.sourcePath || ''} → {job.destRemote}:{job.destPath || ''}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      Schedule: {scheduleLabel(job)}
                      {job.lastRun && ` · Last run: ${new Date(job.lastRun).toLocaleString()}`}
                    </div>
                    {job.lastError && job.status === 'failed' && (
                      <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 2 }}>{job.lastError}</div>
                    )}

                    {/* Progress section */}
                    {isRunning && (
                      <div style={{ marginTop: 8 }}>
                        <div className={`progress-bar${hasPercent ? '' : ' progress-bar-indeterminate'}`}>
                          <div className="progress-bar-fill" style={{ width: `${hasPercent ? p.percent : 0}%` }} />
                        </div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)', marginTop: 4, flexWrap: 'wrap' }}>
                          <span style={{ color: 'var(--text)', fontWeight: 500 }}>
                            {hasPercent ? `${p.percent}%` : 'Starting…'}
                          </span>
                          {p?.transferred && p?.total && (
                            <span>{p.transferred} / {p.total}</span>
                          )}
                          {p?.speed && <span>{p.speed}</span>}
                          {p?.eta && p.eta !== '-' && <span>ETA {p.eta}</span>}
                          {p?.startTime && (
                            <span>Elapsed {fmtElapsed(p.startTime)}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {isRunning ? (
                      <button className="btn-danger btn-sm" onClick={() => stopJob(job.id)}>Stop</button>
                    ) : (
                      <button className="btn-ghost btn-sm" onClick={() => runJob(job.id)}>Run</button>
                    )}
                    <button className="btn-ghost btn-sm" onClick={() => openLogs(job)}>Logs</button>
                    <button className="btn-ghost btn-sm" onClick={() => openEdit(job)} disabled={isRunning}>Edit</button>
                    <button className="btn-danger btn-sm" onClick={() => removeJob(job.id)} disabled={isRunning}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
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
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>Source Remote</label>
                <select value={form.sourceRemote} onChange={e => set('sourceRemote', e.target.value)}>
                  <option value="">Select remote…</option>
                  {remoteList.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Source Path</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={form.sourcePath} onChange={e => set('sourcePath', e.target.value)} placeholder="e.g. Media/Movies" />
                  <button type="button" className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    disabled={!form.sourceRemote}
                    onClick={() => setBrowser({ field: 'sourcePath', remote: form.sourceRemote })}>
                    Browse
                  </button>
                </div>
              </div>
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
            </div>

            <div className="field">
              <label>Schedule</label>
              <select value={form.schedule} onChange={e => set('schedule', e.target.value)}>
                {SCHEDULES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            {form.schedule === 'custom' && (
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
