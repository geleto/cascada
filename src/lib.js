
var ArrayProto = Array.prototype;
var ObjProto = Object.prototype;
var escapeMap = {
  '&': '&amp;',
  '"': '&quot;',
  '\'': '&#39;',
  '<': '&lt;',
  '>': '&gt;',
  '\\': '&#92;',
};

var escapeRegex = /[&"'<>\\]/g;

function hasOwnProp(obj, k) {
  return ObjProto.hasOwnProperty.call(obj, k);
}


function lookupEscape(ch) {
  return escapeMap[ch];
}


function escape(val) {
  return val.replace(escapeRegex, lookupEscape);
}


function isFunction(obj) {
  return ObjProto.toString.call(obj) === '[object Function]';
}


function isArray(obj) {
  return ObjProto.toString.call(obj) === '[object Array]';
}


function isString(obj) {
  return ObjProto.toString.call(obj) === '[object String]';
}


function isObject(obj) {
  return ObjProto.toString.call(obj) === '[object Object]';
}

function isScalarPrimitive(value) {
  const type = typeof value;
  return value !== null &&
    value !== undefined &&
    type !== 'object' &&
    type !== 'function' &&
    type !== 'string';
}


/**
 * @param {string|number} attr
 * @returns {(string|number)[]}
 * @private
 */
function _prepareAttributeParts(attr) {
  if (!attr) {
    return [];
  }

  if (typeof attr === 'string') {
    return attr.split('.');
  }

  return [attr];
}

/**
 * @param {string}   attribute      Attribute value. Dots allowed.
 * @returns {function(Object): *}
 */
function getAttrGetter(attribute) {
  const parts = _prepareAttributeParts(attribute);

  return function attrGetter(item) {
    let _item = item;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      // If item is not an object, and we still got parts to handle, it means
      // that something goes wrong. Just roll out to undefined in that case.
      if (hasOwnProp(_item, part)) {
        _item = _item[part];
      } else {
        return undefined;
      }
    }

    return _item;
  };
}


function groupBy(obj, val, throwOnUndefined) {
  const result = {};
  const iterator = isFunction(val) ? val : getAttrGetter(val);
  for (let i = 0; i < obj.length; i++) {
    const value = obj[i];
    const key = iterator(value, i);
    if (key === undefined && throwOnUndefined === true) {
      throw new TypeError(`groupby: attribute "${val}" resolved to undefined`);
    }
    (result[key] || (result[key] = [])).push(value);
  }
  return result;
}


function toArray(obj) {
  return Array.prototype.slice.call(obj);
}


function without(array) {
  const result = [];
  if (!array) {
    return result;
  }
  const length = array.length;
  const contains = toArray(arguments).slice(1);
  let index = -1;

  while (++index < length) {
    if (indexOf(contains, array[index]) === -1) {
      result.push(array[index]);
    }
  }
  return result;
}


function repeat(char_, n) {
  var str = '';
  for (let i = 0; i < n; i++) {
    str += char_;
  }
  return str;
}


function each(obj, func, context) {
  if (obj == null) {
    return;
  }

  if (ArrayProto.forEach && obj.forEach === ArrayProto.forEach) {
    obj.forEach(func, context);
  } else if (obj.length === +obj.length) {
    for (let i = 0, l = obj.length; i < l; i++) {
      func.call(context, obj[i], i, obj);
    }
  }
}


function map(obj, func) {
  var results = [];
  if (obj == null) {
    return results;
  }

  if (ArrayProto.map && obj.map === ArrayProto.map) {
    return obj.map(func);
  }

  for (let i = 0; i < obj.length; i++) {
    results[results.length] = func(obj[i], i);
  }

  if (obj.length === +obj.length) {
    results.length = obj.length;
  }

  return results;
}


function asyncIter(arr, iter, cb) {
  let i = -1;

  function next() {
    i++;

    if (i < arr.length) {
      iter(arr[i], i, next, cb);
    } else {
      cb();
    }
  }

  next();
}


function asyncFor(obj, iter, cb) {
  const keys = keys_(obj || {});
  const len = keys.length;
  let i = -1;

  function next() {
    i++;
    const k = keys[i];

    if (i < len) {
      iter(k, obj[k], i, len, next);
    } else {
      cb();
    }
  }

  next();
}


function indexOf(arr, searchElement, fromIndex) {
  return Array.prototype.indexOf.call(arr || [], searchElement, fromIndex);
}


function keys_(obj) {
  const arr = [];
  for (let k in obj) {
    if (hasOwnProp(obj, k)) {
      arr.push(k);
    }
  }
  return arr;
}


function _entries(obj) {
  return keys_(obj).map((k) => [k, obj[k]]);
}


function _values(obj) {
  return keys_(obj).map((k) => obj[k]);
}


function extend(obj1, obj2) {
  obj1 = obj1 || {};
  keys_(obj2).forEach(k => {
    obj1[k] = obj2[k];
  });
  return obj1;
}

const _assign = extend;

function inOperator(key, val) {
  if (isArray(val) || isString(val)) {
    return val.indexOf(key) !== -1;
  } else if (isObject(val)) {
    return key in val;
  }
  throw new Error('Cannot use "in" operator to search for "'
    + key + '" in unexpected types.');
}


export {
  hasOwnProp,
  escape,
  isFunction,
  isArray,
  isString,
  isObject,
  isScalarPrimitive,
  getAttrGetter,
  groupBy,
  toArray,
  without,
  repeat,
  each,
  map,
  asyncIter,
  asyncFor,
  indexOf,
  keys_ as keys,
  _entries,
  _values,
  _assign,
  extend,
  inOperator
};
