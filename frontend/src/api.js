const BASE = '/api';

async function req(url, opts = {}) {
  const res = await fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

export const remotes = {
  list: () => req('/remotes'),
  get: (name) => req(`/remotes/${encodeURIComponent(name)}`),
  add: (data) => req('/remotes', { method: 'POST', body: data }),
  update: (name, data) => req(`/remotes/${encodeURIComponent(name)}`, { method: 'PUT', body: data }),
  remove: (name) => req(`/remotes/${name}`, { method: 'DELETE' }),
  browse: (name, path = '') => req(`/remotes/${encodeURIComponent(name)}/browse?path=${encodeURIComponent(path)}`),
  status: () => req('/remotes/status'),
};

export const jobs = {
  list: () => req('/jobs'),
  create: (data) => req('/jobs', { method: 'POST', body: data }),
  update: (id, data) => req(`/jobs/${id}`, { method: 'PUT', body: data }),
  remove: (id) => req(`/jobs/${id}`, { method: 'DELETE' }),
  run: (id) => req(`/jobs/${id}/run`, { method: 'POST' }),
  simulate: (id) => req(`/jobs/${id}/simulate`, { method: 'POST' }),
  stop: (id) => req(`/jobs/${id}/stop`, { method: 'POST' }),
  stopAll: () => req('/jobs/stop-all', { method: 'POST' }),
};

export const logs = {
  list: (jobId) => req(`/logs/${jobId}`),
  get: (jobId, filename) => req(`/logs/${jobId}/${filename}`),
};

export const reports = {
  list:   (jobId) => req(`/logs/${jobId}/reports`),
  url:    (jobId, filename) => `${BASE}/logs/${jobId}/reports/${filename}`,
  remove: (jobId, filename) => req(`/logs/${jobId}/reports/${filename}`, { method: 'DELETE' }),
};
