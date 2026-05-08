function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

const path = {
  sep: '/',

  dirname(value) {
    const normalized = normalizePath(value);
    const index = normalized.lastIndexOf('/');
    return index === -1 ? '.' : normalized.slice(0, index) || '/';
  },

  join(...parts) {
    return normalizePath(parts.filter(Boolean).join('/'));
  },

  normalize(value) {
    return normalizePath(value);
  },

  resolve(...parts) {
    return normalizePath(parts.filter(Boolean).join('/'));
  },

  relative(from, to) {
    const normalizedFrom = normalizePath(from);
    const normalizedTo = normalizePath(to);
    return normalizedTo.startsWith(normalizedFrom)
      ? normalizedTo.slice(normalizedFrom.length).replace(/^\//, '')
      : normalizedTo;
  }
};

export default path;
