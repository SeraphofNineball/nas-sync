import { useState, useEffect } from 'react';
import { remotes as api } from '../api.js';

const TYPES = {
  local:  { label: 'Local / Mounted Path', fields: [] },
  smb:    { label: 'SMB / Windows Share', fields: [
    { key: 'host', label: 'Host / IP', required: true },
    { key: 'user', label: 'Username' },
    { key: 'pass', label: 'Password', type: 'password' },
    { key: 'domain', label: 'Domain (optional)' },
  ]},
  sftp:   { label: 'SFTP', fields: [
    { key: 'host', label: 'Host / IP', required: true },
    { key: 'port', label: 'Port', placeholder: '22' },
    { key: 'user', label: 'Username' },
    { key: 'pass', label: 'Password', type: 'password' },
  ]},
  ftp:    { label: 'FTP', fields: [
    { key: 'host', label: 'Host / IP', required: true },
    { key: 'port', label: 'Port', placeholder: '21' },
    { key: 'user', label: 'Username' },
    { key: 'pass', label: 'Password', type: 'password' },
  ]},
  webdav: { label: 'WebDAV', fields: [
    { key: 'url',    label: 'URL', required: true, placeholder: 'http://host/webdav' },
    { key: 'vendor', label: 'Vendor', placeholder: 'other' },
    { key: 'user',   label: 'Username' },
    { key: 'pass',   label: 'Password', type: 'password' },
  ]},
  s3:     { label: 'S3 / Compatible', fields: [
    { key: 'provider',          label: 'Provider', placeholder: 'AWS' },
    { key: 'access_key_id',     label: 'Access Key ID', required: true },
    { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
    { key: 'region',            label: 'Region', placeholder: 'us-east-1' },
    { key: 'endpoint',          label: 'Endpoint URL (optional)' },
  ]},
};

export default function RemoteManager() {
  const [list, setList]       = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]       = useState({ name: '', type: 'smb', config: {} });
  const [error, setError]     = useState('');
  const [saving, setSaving]   = useState(false);

  const load = () => api.list().then(setList);
  useEffect(() => { load(); }, []);

  const setConfig = (key, value) =>
    setForm(f => ({ ...f, config: { ...f.config, [key]: value } }));

  const submit = async () => {
    if (!form.name.trim()) return setError('Name is required');
    setSaving(true); setError('');
    const res = await api.add({ name: form.name.trim(), type: form.type, config: form.config });
    setSaving(false);
    if (res.error) return setError(res.error);
    setShowForm(false);
    setForm({ name: '', type: 'smb', config: {} });
    load();
  };

  const remove = async (name) => {
    if (!confirm(`Remove remote "${name}"?`)) return;
    await api.remove(name);
    load();
  };

  const fields = TYPES[form.type]?.fields || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18 }}>Remotes</h2>
        <button className="btn-primary" onClick={() => { setShowForm(true); setError(''); }}>+ Add Remote</button>
      </div>

      {list.length === 0 ? (
        <div className="card" style={{ color: 'var(--muted)', textAlign: 'center', padding: 40 }}>
          No remotes configured. Add one to get started.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map(name => (
            <div key={name} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 500 }}>{name}</span>
              <button className="btn-danger btn-sm" onClick={() => remove(name)}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setShowForm(false)}>
          <div className="modal">
            <div className="modal-header">
              <h2>Add Remote</h2>
              <button className="modal-close" onClick={() => setShowForm(false)}>×</button>
            </div>

            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. ugreen-nas" />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value, config: {} }))}>
                {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>

            {fields.map(f => (
              <div key={f.key} className="field">
                <label>{f.label}{f.required ? ' *' : ''}</label>
                <input
                  type={f.type || 'text'}
                  placeholder={f.placeholder || ''}
                  value={form.config[f.key] || ''}
                  onChange={e => setConfig(f.key, e.target.value)}
                />
              </div>
            ))}

            {error && <p className="error-msg">{error}</p>}
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn-primary" onClick={submit} disabled={saving}>
                {saving ? 'Saving…' : 'Add Remote'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
