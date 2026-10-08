
import {Loader} from './loader.js';
import {PrecompiledLoader} from './precompiled-loader.js';

class WebLoader extends Loader {
  constructor(baseURL, opts) {
    super();
    this.baseURL = baseURL || '.';
    opts = opts || {};

    // By default, the cache is turned off because there's no way
    // to "watch" templates over HTTP, so they are re-downloaded
    // and compiled each time. (Remember, PRECOMPILE YOUR
    // TEMPLATES in production!)
    this.useCache = !!opts.useCache;
    this.cachePolicy = this.useCache ? 'cache' : 'reload';

    // We default `async` to false so that the simple synchronous
    // API can be used when you aren't doing anything async in
    // your templates (which is most of the time). This performs a
    // sync ajax request, but that's ok because it should *only*
    // happen in development. PRECOMPILE YOUR TEMPLATES.
    this.async = !!opts.async;
  }

  resolve(from, to) {
    return this._getURL(to, this._getURL(from));
  }

  _getURL(name, from) {
    const pageURL = typeof document !== 'undefined' ? document.baseURI :
      (typeof window !== 'undefined' ? window.location.href : undefined);
    const baseURL = new URL(this.baseURL, pageURL);
    if (!baseURL.pathname.endsWith('/')) {
      baseURL.pathname += '/';
    }
    const url = new URL(name, from ?? baseURL);
    const namePath = name.split(/[?#]/, 1)[0];
    // Absolute source paths are useful for subsequent relative resolution, but
    // names must stay inside the configured template directory. Reject encoded
    // separators too: servers may decode them before normalizing a pathname.
    if (/^[\\/]{2}/.test(name) || url.origin !== baseURL.origin ||
        url.protocol !== baseURL.protocol || !url.pathname.startsWith(baseURL.pathname) ||
        url.username || url.password || /%2f|%5c|%00/i.test(namePath)) {
      throw new Error('Template URL is outside the WebLoader base URL: ' + url.href);
    }
    return url.href;
  }

  getSource(name, cb) {
    var useCache = this.useCache;
    var result;
    const url = this._getURL(name);
    this.fetch(url, (err, src) => {
      if (err) {
        if (err.status === 404) {
          result = null;
          if (cb) {
            cb(null, null);
          }
        } else {
          const error = new Error('HTTP ' + err.status + ' loading template: ' + url);
          error.status = err.status;
          error.url = url;
          error.responseText = err.content;
          if (cb) {
            cb(error);
          } else {
            throw error;
          }
        }
      } else {
        result = {
          src: src,
          path: url,
          noCache: !useCache
        };
        this.emit('load', name, result);
        if (cb) {
          cb(null, result);
        }
      }
    });

    // if this WebLoader isn't running asynchronously, the
    // fetch above would actually run sync and we'll have a
    // result here
    return result;
  }

  fetch(url, cb) {
    // Only in the browser please
    if (typeof window === 'undefined') {
      throw new Error('WebLoader can only by used in a browser');
    }

    const ajax = new XMLHttpRequest();
    let loading = true;

    ajax.onreadystatechange = () => {
      if (ajax.readyState === 4 && loading) {
        loading = false;
        if (ajax.status === 0 || ajax.status === 200) {
          cb(null, ajax.responseText);
        } else {
          cb({
            status: ajax.status,
            content: ajax.responseText
          });
        }
      }
    };

    url += (url.indexOf('?') === -1 ? '?' : '&') + 's=' +
    (new Date().getTime());

    ajax.open('GET', url, this.async);
    ajax.send();
  }
}

export { WebLoader, PrecompiledLoader };
