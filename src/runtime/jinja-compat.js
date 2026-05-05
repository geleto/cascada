
import * as lib from '../lib.js';
import {memberLookup} from './lookup.js';

function _hasOwnProp(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const JINJA_ARRAY_MEMBERS = {
  pop(index) {
    if (index === undefined) {
      return this.pop();
    }
    if (index >= this.length || index < 0) {
      throw new Error('KeyError');
    }
    return this.splice(index, 1);
  },
  append(element) {
    return this.push(element);
  },
  remove(element) {
    for (let i = 0; i < this.length; i++) {
      if (this[i] === element) {
        return this.splice(i, 1);
      }
    }
    throw new Error('ValueError');
  },
  count(element) {
    let count = 0;
    for (let i = 0; i < this.length; i++) {
      if (this[i] === element) {
        count++;
      }
    }
    return count;
  },
  index(element) {
    const index = this.indexOf(element);
    if (index === -1) {
      throw new Error('ValueError');
    }
    return index;
  },
  find(element) {
    return this.indexOf(element);
  },
  insert(index, elem) {
    return this.splice(index, 0, elem);
  }
};

const JINJA_OBJECT_MEMBERS = {
  items() {
    return lib._entries(this);
  },
  values() {
    return lib._values(this);
  },
  keys() {
    return lib.keys(this);
  },
  get(key, def) {
    let value = this[key];
    if (value === undefined) {
      value = def;
    }
    return value;
  },
  'has_key'(key) {
    return _hasOwnProp(this, key);
  },
  pop(key, def) {
    let value = this[key];
    if (value === undefined && def !== undefined) {
      value = def;
    } else if (value === undefined) {
      throw new Error('KeyError');
    } else {
      delete this[key];
    }
    return value;
  },
  popitem() {
    const keys = lib.keys(this);
    if (!keys.length) {
      throw new Error('KeyError');
    }
    const key = keys[0];
    const value = this[key];
    delete this[key];
    return [key, value];
  },
  setdefault(key, def = null) {
    if (!(key in this)) {
      this[key] = def;
    }
    return this[key];
  },
  update(kwargs) {
    lib._assign(this, kwargs);
    return null;
  }
};
JINJA_OBJECT_MEMBERS.iteritems = JINJA_OBJECT_MEMBERS.items;
JINJA_OBJECT_MEMBERS.itervalues = JINJA_OBJECT_MEMBERS.values;
JINJA_OBJECT_MEMBERS.iterkeys = JINJA_OBJECT_MEMBERS.keys;

function _sliceLookupJinjaCompat(obj, start, stop, step) {
  obj = obj || [];
  if (start === null) {
    start = (step < 0) ? (obj.length - 1) : 0;
  }
  if (stop === null) {
    stop = (step < 0) ? -1 : obj.length;
  } else if (stop < 0) {
    stop += obj.length;
  }

  if (start < 0) {
    start += obj.length;
  }

  const results = [];

  for (let i = start; ; i += step) {
    if (i < 0 || i > obj.length) {
      break;
    }
    if (step > 0 && i >= stop) {
      break;
    }
    if (step < 0 && i <= stop) {
      break;
    }
    results.push(memberLookupJinjaCompat(obj, i));
  }
  return results;
}

function memberLookupJinjaCompat(obj, val) {
  if (arguments.length === 4) {
    return _sliceLookupJinjaCompat.apply(this, arguments);
  }

  obj = obj || {};

  if (Array.isArray(obj) && _hasOwnProp(JINJA_ARRAY_MEMBERS, val)) {
    return JINJA_ARRAY_MEMBERS[val].bind(obj);
  }
  if (lib.isObject(obj) && _hasOwnProp(JINJA_OBJECT_MEMBERS, val)) {
    return JINJA_OBJECT_MEMBERS[val].bind(obj);
  }

  return memberLookup(obj, val);
}

export { memberLookupJinjaCompat };
