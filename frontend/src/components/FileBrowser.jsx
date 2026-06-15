import { useState, useEffect } from 'react';
import { remotes as api } from '../api.js';

export default function FileBrowser({
  remote,
  initialPath = '',
  onSelect,
  onClose,
  multiSelect = false,
}) {
  const [path, setPath]       = useState(initialPath);
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [checked, setChecked] = useState(new Set());

  const load = async (p, clearChecked = false) => {
    setLoading(true);
    setError('');
    try {
      const data = await api.browse(remote, p);
      if (data.error) throw new Error(data.error);
      setItems(data.filter(i => i.IsDir));
      setPath(p);
      if (clearChecked) setChecked(new Set());
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(initialPath); }, [remote]);

  const navigate = (name) => load(path ? `${path}/${name}` : name, true);

  const goUp = () => {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    load(parts.join('/'), true);
  };

  const toggleCheck = (fullPath) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
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
            onClick={() => load('', true)}
          >{remote}:</span>
          {breadcrumbs.map((crumb, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--muted)' }}>/</span>
              <span
                style={{ cursor: 'pointer', color: 'var(--primary)' }}
                onClick={() => load(breadcrumbs.slice(0, i + 1).join('/'), true)}
              >{crumb}</span>
            </span>
          ))}
        </div>

        {multiSelect && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            Check folders to select them · Click a folder name to navigate into it
          </div>
        )}

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
              {items.map(item => {
                const fullPath = path ? `${path}/${item.Name}` : item.Name;
                const isChecked = checked.has(fullPath);

                if (!multiSelect) {
                  return (
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
                  );
                }

                return (
                  <div
                    key={item.Path}
                    style={{
                      padding: '9px 14px',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: isChecked ? 'var(--surface2)' : 'transparent',
                      transition: 'background 0.1s',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleCheck(fullPath)}
                      style={{ width: 'auto', cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 15, flexShrink: 0 }}>📁</span>
                    <span
                      style={{ flex: 1, cursor: 'pointer', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={`Navigate into ${item.Name}`}
                      onClick={() => navigate(item.Name)}
                      onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                      onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                    >{item.Name}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>›</span>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {multiSelect ? (
          <>
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
              {checked.size === 0
                ? <span>No folders selected</span>
                : <span style={{ color: 'var(--text)' }}>{checked.size} folder{checked.size !== 1 ? 's' : ''} selected</span>
              }
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              <button
                className="btn-primary"
                disabled={checked.size === 0}
                onClick={() => onSelect(Array.from(checked))}
              >
                Confirm Selection{checked.size > 0 ? ` (${checked.size})` : ''}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
              Selected: <span style={{ color: 'var(--text)' }}>{remote}:{path || '/'}</span>
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={() => onSelect(path)}>
                Select this location
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
