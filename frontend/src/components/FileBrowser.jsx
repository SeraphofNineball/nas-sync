import { useState, useEffect } from 'react';
import { remotes as api } from '../api.js';

export default function FileBrowser({ remote, initialPath = '', onSelect, onClose }) {
  const [path, setPath]     = useState(initialPath);
  const [items, setItems]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');

  const load = async (p) => {
    setLoading(true);
    setError('');
    try {
      const data = await api.browse(remote, p);
      if (data.error) throw new Error(data.error);
      setItems(data.filter(i => i.IsDir));
      setPath(p);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(initialPath); }, [remote]);

  const navigate = (name) => {
    load(path ? `${path}/${name}` : name);
  };

  const goUp = () => {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    load(parts.join('/'));
  };

  const breadcrumbs = path ? path.split('/').filter(Boolean) : [];

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 560 }}>
        <div className="modal-header">
          <h2>Browse — {remote}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {/* Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, flexWrap: 'wrap', fontSize: 13 }}>
          <span
            style={{ cursor: 'pointer', color: 'var(--primary)' }}
            onClick={() => load('')}
          >{remote}:</span>
          {breadcrumbs.map((crumb, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--muted)' }}>/</span>
              <span
                style={{ cursor: 'pointer', color: 'var(--primary)' }}
                onClick={() => load(breadcrumbs.slice(0, i + 1).join('/'))}
              >{crumb}</span>
            </span>
          ))}
        </div>

        {/* File listing */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, height: 280, overflowY: 'auto' }}>
          {loading && (
            <div style={{ padding: 24, color: 'var(--muted)', textAlign: 'center' }}>Loading…</div>
          )}
          {error && (
            <div style={{ padding: 16, color: 'var(--danger)' }}>{error}</div>
          )}
          {!loading && !error && (
            <>
              {path && (
                <div
                  onClick={goUp}
                  style={{ padding: '9px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span>↩</span> ..
                </div>
              )}
              {items.length === 0 && (
                <div style={{ padding: 24, color: 'var(--muted)', textAlign: 'center' }}>No subfolders</div>
              )}
              {items.map(item => (
                <div
                  key={item.Path}
                  onClick={() => navigate(item.Name)}
                  style={{
                    padding: '9px 14px', cursor: 'pointer',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', gap: 8,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{ fontSize: 15 }}>📁</span>
                  <span>{item.Name}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
          Selected: <span style={{ color: 'var(--text)' }}>{remote}:{path || '/'}</span>
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => onSelect(path)}>
            Select this location
          </button>
        </div>
      </div>
    </div>
  );
}
