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

export const posix = {
  dirname(value) {
    const index = value.lastIndexOf('/');
    return index === -1 ? '.' : value.slice(0, index) || '/';
  },

  join(...parts) {
    const value = parts.filter(Boolean).join('/');
    const absolute = value.startsWith('/');
    const segments = [];
    for (const segment of value.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..' && segments.length && segments[segments.length - 1] !== '..') segments.pop();
      else if (segment !== '..' || !absolute) segments.push(segment);
    }
    return (absolute ? '/' : '') + segments.join('/') || '.';
  }
};
