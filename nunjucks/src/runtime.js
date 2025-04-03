'use strict';

var lib = require('./lib');
var arrayFrom = Array.from;
var supportsIterators = (
  typeof Symbol === 'function' && Symbol.iterator && typeof arrayFrom === 'function'
);


// Frames keep track of scoping both at compile-time and run-time so
// we know how to access variables. Block tags can introduce special
// variables, for example.
class Frame {
  //isolateWrites - disables writing to parent frames
  constructor(parent, isolateWrites) {
    this.variables = Object.create(null);
    this.parent = parent;
    this.topLevel = false;
    // if this is true, writes (set) should never propagate upwards past
    // this frame to its parent (though reads may).
    this.isolateWrites = isolateWrites;
  }

  set(name, val, resolveUp) {
    // Allow variables with dots by automatically creating the
    // nested structure
    var parts = name.split('.');
    var obj = this.variables;
    var frame = this;

    if (resolveUp) {
      if ((frame = this.resolve(parts[0], true))) {
        frame.set(name, val);
        return;
      }
    }

    for (let i = 0; i < parts.length - 1; i++) {
      const id = parts[i];

      if (!obj[id]) {
        obj[id] = {};
      }
      obj = obj[id];
    }

    obj[parts[parts.length - 1]] = val;
  }

  get(name) {
    var val = this.variables[name];
    if (val !== undefined) {
      return val;
    }
    return null;
  }

  lookup(name) {
    var p = this.parent;
    var val = this.variables[name];
    if (val !== undefined) {
      return val;
    }
    return p && p.lookup(name);
  }

  resolve(name, forWrite) {
    var p = (forWrite && this.isolateWrites) ? undefined : this.parent;
    var val = this.variables[name];
    if (val !== undefined) {
      return this;
    }
    return p && p.resolve(name);
  }

  push(isolateWrites) {
    return new Frame(this, isolateWrites);
  }

  pop() {
    return this.parent;
  }

  new() {
    return new Frame();//undefined, this.isolateWrites);
  }
}

class AsyncFrame extends Frame {
  constructor(parent, isolateWrites, createScope = true) {
    super(parent, isolateWrites);

    this.createScope = createScope;

    if (AsyncFrame.inCompilerContext) {
      //holds the names of the variables declared at the frame
      this.declaredVars = undefined;

      //holds the write counts for each variable that CAN be modified by an async block or its children
      //this includes variables that are modified in branches that are not taken (e.g. count both sides of an if)
      //the counts are propagated upwards before the frame that has declared the variable
      //passed as argument to pushAsyncBlock in the template source
      this.writeCounts = undefined;

      //holds the names of the variables that are read in the frame or its children
      //used when making a snapshot of the frame state when entering an async block
      //passed as argument to pushAsyncBlock in the template source
      this.readVars = undefined;

    } else {
      //when an async block is entered, it creates a promise for all variables that it or it's children modify
      //the value of the variable in the parent(an asyncVar if it's async block, regular var with frame.set otherwise) is changed to the promise
      //the promise is resolved when the block is done modifying the variable and the value is set to the final value
      this.promiseResolves = undefined;

      //holds the write counters for each variable that is modified in an async block or its children
      //The decreminting is propagated upwards before the frame that has declared the variable
      //the variable name is the key and the value is the number of remaining writes (including missed writes due to branches)
      //once the counter reaches 0, the promise for the variable is resolved
      this.writeCounters = undefined;

      //holds the variables that are modified in an async block frame while it is active
      //once the block is done modifying a variable, the promise for the variable is resolved with this value
      //asyncVars[varName] is only used if the variable is not stored in the frame
      this.asyncVars = undefined;
    }

    // if this is true, writes (set) should never propagate upwards past
    // this frame to its parent (though reads may).
    this.isolateWrites = isolateWrites;

    this.isAsyncBlock = false;//not used
  }

  static inCompilerContext = false;

  new() {
    return new AsyncFrame();//undefined, this.isolateWrites);
  }

  //@todo - handle reentrant frames, count the writes even if the frame is the scope frame,
  //second parameter to pushAsyncBlock only for recursive frames
  //or maybe reentrant frames should keep vars in the parent scope, at least for loops
  set(name, val, resolveUp) {
    if (resolveUp) {
      //only set tags use resolveUp
      //set tags do not have variables with dots, so the name is the whole variable name
      if (name.indexOf('.') !== -1) {
        throw new Error('resolveUp should not be used with variables with dots');
      }
      let scopeFrame = this.resolve(name, true);

      if (!scopeFrame) {
        //add the variable here unless !createScope in which case try the root
        if (!this.createScope) {
          this.parent.set(name, val);
          scopeFrame = this.resolve(name, true);
          if (!scopeFrame) {
            throw new Error('Variable should have been added in a parent frame');
          }
        }
        else {
          scopeFrame = this;//create the variable in this frame
        }
      }

      let willResolve = false;
      let frame = this;
      let countdownPropagate = true;
      while (frame != scopeFrame) {
        if (frame.asyncVars[name] !== undefined) {
          //set the value in asyncVars, when the async block is done, the value will be resolved in the parent
          frame.asyncVars[name] = val;
          willResolve = true;
        }
        if (countdownPropagate && !frame._countdownAsyncWrites(name, 1)) {
          countdownPropagate = false;
          break;//has not reached zero yet, do not countdown up the chain
        }
        frame = frame.parent;
      }
      if (!willResolve) {
        //just assign the value in the scope frame with no async trickery
        scopeFrame.variables[name] = val;
      }
    } else {
      //not for set tags
      super.set(name, val);
      //@todo - handle for recursive frames
      //name = name.substring(0, name.indexOf('.'));
    }
  }

  //@todo when we start skipping block promisify - do complete get implementation here to check asyncVars at all levels
  get(name) {
    if (this.asyncVars && name in this.asyncVars) {
      return this.asyncVars[name];
    }
    return super.get(name);
  }

  lookup(name) {
    var val = (this.asyncVars && name in this.asyncVars) ? this.asyncVars[name] : this.variables[name];
    if (val !== undefined) {
      return val;
    }
    return this.parent && this.parent.lookup(name);
  }

  //when all assignments to a variable are done, resolve the promise for that variable
  _countdownAsyncWrites(varName, decrementVal = 1) {
    if (!this.writeCounters) {
      return true;//try up the chain
    }
    if (!this.writeCounters) {
      throw new Error('Can not count vars: no vars counts in this frame');
    }
    let count = this.writeCounters[varName];
    if (count < decrementVal) {
      throw new Error(`Variable ${varName} write counter ${count === undefined ? 'is undefined' : 'turned negative'} in _trackAsyncWrites`);
    }
    if (count === decrementVal) {//zero
      //this variable will no longer be modified, time to resolve it
      this._resolveAsyncVar(varName);
      return true;//propagate up the chain as a single write
    } else {
      this.writeCounters[varName] = count - decrementVal;//decrement
      return false;//more left to write, do not propagate up
    }
  }

  skipBranchWrites(varCounts) {
    for (let varName in varCounts) {
      let scopeFrame = this.resolve(varName, true);
      let frame = this;
      let count = varCounts[varName];
      while (frame != scopeFrame) {
        if (!frame._countdownAsyncWrites(varName, count))
          break;//has not reached zero yet, do not propagate up
        //reached zero, propagate up as a single write
        count = 1;
        frame = frame.parent;
      }
    }
  }

  /*
  _resolveAsyncVar(varName) {
    let value = this.asyncVars[varName];
    let resolveFunc = this.promiseResolves[varName];
    resolveFunc(value);
    //@todo - if the var is the same promise - set it to the value
    //this cleanup may not be needed:
    delete this.promiseResolves[varName];
    if (Object.keys(this.promiseResolves).length === 0) {
      this.promiseResolves = undefined;
    }
  }
  */

  _resolveAsyncVar(varName) {
    let value = this.asyncVars[varName];
    let resolveFunc = this.promiseResolves[varName];

    if (!resolveFunc) {
      console.error(`No resolve function for variable ${varName}`);
      return;
    }

    if (value && typeof value.then === 'function') {
      value.then(resolvedValue => {
        resolveFunc(resolvedValue);
      }).catch(err => {
        resolveFunc(Promise.reject(err));
      });
    } else {
      resolveFunc(value);
    }

    //@todo - if the var is the same promise - set it to the value
    //this cleanup may not be needed:
    // Cleanup
    delete this.promiseResolves[varName];
    if (Object.keys(this.promiseResolves).length === 0) {
      this.promiseResolves = undefined;
    }
  }

  push(isolateWrites) {
    return new AsyncFrame(this, isolateWrites);
  }

  pushAsyncBlock(reads, writeCounters) {
    let asyncBlockFrame = new AsyncFrame(this, false);//this.isolateWrites);//@todo - should isolateWrites be passed here?
    asyncBlockFrame.isAsyncBlock = true;
    if (reads || writeCounters) {
      asyncBlockFrame.asyncVars = {};
      if (reads) {
        asyncBlockFrame._snapshotVariables(reads);
      }
      if (writeCounters) {
        asyncBlockFrame._promisifyParentVariables(writeCounters);
      }
    }
    return asyncBlockFrame;
  }

  _snapshotVariables(reads) {
    for (const varName of reads) {
      this.asyncVars[varName] = this.lookup(varName);
    }
  }

  //@todo - skip promisify if parent has the same counts
  _promisifyParentVariables(writeCounters) {
    this.writeCounters = writeCounters;
    this.promiseResolves = {};
    let parent = this.parent;
    for (let varName in writeCounters) {
      //snapshot the value
      this.asyncVars[varName] = this.lookup(varName);
      //promisify the variable in the frame (parent of the new async frame)
      //these will be resolved when the async block is done with the variable
      if (parent.asyncVars && parent.asyncVars[varName] !== undefined) {
        this._promisifyParentVar(parent, parent.asyncVars, varName);
      } else if (parent.variables[varName] !== undefined) {
        this._promisifyParentVar(parent, parent.variables, varName);
      }
      else {
        throw new Error('Variable not found in parent frame');
      }
    }
  }

  _promisifyParentVar(parentFrame, parentVars, varName) {
    //use this value while the async block is active, then resolve it:
    this.asyncVars[varName] = parentVars[varName];
    let resolve;
    let promise = new Promise((res) => { resolve = res; });
    this.promiseResolves[varName] = resolve;
    parentVars[varName] = promise;
    if (parentFrame.topLevel) {
      //todo: modify the variable in the context
      //context.setVariable(varName, promise);
    }
  }
}

function makeMacro(argNames, kwargNames, func, astate) {
  return function macro(...macroArgs) {
    var argCount = numArgs(macroArgs);
    var args;
    var kwargs = getKeywordArgs(macroArgs);

    if (argCount > argNames.length) {
      args = macroArgs.slice(0, argNames.length);

      // Positional arguments that should be passed in as
      // keyword arguments (essentially default values)
      macroArgs.slice(args.length, argCount).forEach((val, i) => {
        if (i < kwargNames.length) {
          kwargs[kwargNames[i]] = val;
        }
      });
      args.push(kwargs);
    } else if (argCount < argNames.length) {
      args = macroArgs.slice(0, argCount);

      for (let i = argCount; i < argNames.length; i++) {
        const arg = argNames[i];

        // Keyword arguments that should be passed as
        // positional arguments, i.e. the caller explicitly
        // used the name of a positional arg
        args.push(kwargs[arg]);
        delete kwargs[arg];
      }
      args.push(kwargs);
    } else {
      args = macroArgs;
      if (astate && Object.keys(kwargs).length === 0) {
        args.push({});//kwargs
      }
    }

    if (astate) {
      args.push(astate.new());
    }
    return func.apply(this, args);
  };
}

function makeKeywordArgs(obj) {
  obj.__keywords = true;
  return obj;
}

function isKeywordArgs(obj) {
  return obj && Object.prototype.hasOwnProperty.call(obj, '__keywords');
}

function getKeywordArgs(args) {
  var len = args.length;
  if (len) {
    const lastArg = args[len - 1];
    if (isKeywordArgs(lastArg)) {
      return lastArg;
    }
  }
  return {};
}

function numArgs(args) {
  var len = args.length;
  if (len === 0) {
    return 0;
  }

  const lastArg = args[len - 1];
  if (isKeywordArgs(lastArg)) {
    return len - 1;
  } else {
    return len;
  }
}

// A SafeString object indicates that the string should not be
// autoescaped. This happens magically because autoescaping only
// occurs on primitive string objects.
function SafeString(val) {
  if (typeof val !== 'string') {
    return val;
  }

  this.val = val;
  this.length = val.length;
}

function newSafeStringAsync(val, lineno, colno) {
  if (Array.isArray(val)) {
    // append the function to the array, so it will be
    // called after the elements before it are joined
    val.push((v) => {
      return new SafeString(v, lineno, colno);
    });
    return val;
  }
  if (val && typeof val.then === 'function') {
    // it's a promise, return a promise that suppresses the value when resolved
    return (async (v) => {
      return new SafeString(await v, lineno, colno);
    })(val);
  }
  return new SafeString(val, lineno, colno);
}

SafeString.prototype = Object.create(String.prototype, {
  length: {
    writable: true,
    configurable: true,
    value: 0
  }
});
SafeString.prototype.valueOf = function valueOf() {
  return this.val;
};
SafeString.prototype.toString = function toString() {
  return this.val;
};

function copySafeness(dest, target) {
  if (dest instanceof SafeString) {
    return new SafeString(target);
  }
  return target.toString();
}

function markSafe(val) {
  var type = typeof val;

  if (type === 'string') {
    return new SafeString(val);
  } else if (type !== 'function') {
    return val;
  } else if (type === 'object' && val.then && typeof val.then === 'function') {
    return (async (v) => {
      return markSafe(await v);
    })(val);
  }
  else {
    return function wrapSafe(args) {
      var ret = val.apply(this, arguments);

      if (typeof ret === 'string') {
        return new SafeString(ret);
      }

      return ret;
    };
  }
}

function suppressValue(val, autoescape) {
  val = (val !== undefined && val !== null) ? val : '';

  if (autoescape && !(val instanceof SafeString)) {
    val = lib.escape(val.toString());
  }

  return val;
}

function suppressValueAsync(val, autoescape) {
  if (val && typeof val.then === 'function') {
    return val.then((v) => {
      return suppressValueAsync(v, autoescape);
    });
  }
  if (Array.isArray(val)) {
    if (autoescape) {
      // append the function to the array, so it will be
      // called after the elements before it are joined
      val.push((value) => {
        return suppressValue(value, true);
      });
    }
    return val;
  }
  if (val && typeof val.then === 'function') {
    // it's a promise, return a promise that suppresses the value when resolved
    return (async (v) => {
      return suppressValue(await v, autoescape);
    })(val);
  }
  return suppressValue(val, autoescape);
}

function ensureDefined(val, lineno, colno) {
  if (val === null || val === undefined) {
    throw new lib.TemplateError(
      'attempted to output null or undefined value',
      lineno + 1,
      colno + 1
    );
  }
  return val;
}

function ensureDefinedAsync(val, lineno, colno) {
  if (Array.isArray(val)) {
    // append the function to the array, so it will be
    // called after the elements before it are joined
    val.push((v) => {
      return ensureDefined(v, lineno, colno);
    });
    return val;
  }
  if (val && typeof val.then === 'function') {
    // it's a promise, return a promise that suppresses the value when resolved
    return (async (v) => {
      return ensureDefined(await v, lineno, colno);
    })(val);
  }
  return ensureDefined(val, lineno, colno);
}

function promisify(fn) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      const callback = (error, ...results) => {
        if (error) {
          reject(error);
        } else {
          resolve(results.length === 1 ? results[0] : results);
        }
      };

      fn(...args, callback);
    });
  };
}

// It's ok to use consequitive awaits when promises have been already in progress by the time you start awaiting them,
// Thus using sequential await in a loop does not introduce significant delays compared to Promise.all.
// not so if the promise is cteated right before the await, e.g. await fetch(url)
async function resolveAll(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] && typeof args[i].then === 'function') {
      args[i] = await args[i];
    }
  }
  return args;
}

async function resolveObjectProperties(obj) {
  for (const key in obj) {
    if (obj[key] && typeof obj[key].then === 'function') {
      obj[key] = await obj[key];
    }
  }
  return obj;
}

async function resolveDuo(arg1, arg2) {
  return [
    (arg1 && typeof arg1.then === 'function') ? await arg1 : arg1,
    (arg2 && typeof arg2.then === 'function') ? await arg2 : arg2
  ];
}

//@todo - no need for condition and false branch, if something breaks - check why, amybe it wants the then to not return a promise
function resolveSingle(value) {
  return value && typeof value.then === 'function' ? value : {
    then(onFulfilled) {
      return onFulfilled ? onFulfilled(value) : value;
    }
  };
}

async function resolveSingleArr(value) {
  return [
    (value && typeof value.then === 'function') ? await value : value
  ];
}

function resolveArguments(fn, skipArguments = 0) {
  return async function (...args) {
    const skippedArgs = args.slice(0, skipArguments);
    const remainingArgs = args.slice(skipArguments);
    await resolveAll(remainingArgs);
    const finalArgs = [...skippedArgs, ...remainingArgs];

    return fn.apply(this, finalArgs);
  };
}

function flattentBuffer(arr) {
  const result = arr.reduce((acc, item) => {
    if (Array.isArray(item)) {
      return acc + flattentBuffer(item);
    }
    if (typeof item === 'function') {
      return (item(acc) || '');
    }
    return acc + (item || '');
  }, '');
  return result;
}

function memberLookup(obj, val) {
  if (obj === undefined || obj === null) {
    return undefined;
  }

  if (typeof obj[val] === 'function') {
    return (...args) => obj[val](...args);
  }

  return obj[val];
}

function memberLookupAsync(obj, val) {
  return resolveDuo(obj, val).then(([resolvedOb, resolvedVal]) => {
    return memberLookup(resolvedOb, resolvedVal);
  });
}

function callWrap(obj, name, context, args) {
  if (!obj) {
    throw new Error('Unable to call `' + name + '`, which is undefined or falsey');
  } else if (typeof obj !== 'function') {
    throw new Error('Unable to call `' + name + '`, which is not a function');
  }

  return obj.apply(context, args);
}

function contextOrFrameLookup(context, frame, name) {
  var val = frame.lookup(name);
  return (val !== undefined) ?
    val :
    context.lookup(name);
}

function handleError(error, lineno, colno) {
  if (error.lineno) {
    return error;
  } else {
    return new lib.TemplateError(error, lineno, colno);
  }
}

function asyncEach(arr, dimen, iter, cb) {
  if (lib.isArray(arr)) {
    const len = arr.length;

    lib.asyncIter(arr, function iterCallback(item, i, next) {
      switch (dimen) {
        case 1:
          iter(item, i, len, next);
          break;
        case 2:
          iter(item[0], item[1], i, len, next);
          break;
        case 3:
          iter(item[0], item[1], item[2], i, len, next);
          break;
        default:
          item.push(i, len, next);
          iter.apply(this, item);
      }
    }, cb);
  } else {
    lib.asyncFor(arr, function iterCallback(key, val, i, len, next) {
      iter(key, val, i, len, next);
    }, cb);
  }
}

function asyncAll(arr, dimen, func, cb) {
  var finished = 0;
  var len;
  var outputArr;

  function done(i, output) {
    finished++;
    outputArr[i] = output;

    if (finished === len) {
      cb(null, outputArr.join(''));
    }
  }

  if (lib.isArray(arr)) {
    len = arr.length;
    outputArr = new Array(len);

    if (len === 0) {
      cb(null, '');
    } else {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];

        switch (dimen) {
          case 1:
            func(item, i, len, done);
            break;
          case 2:
            func(item[0], item[1], i, len, done);
            break;
          case 3:
            func(item[0], item[1], item[2], i, len, done);
            break;
          default:
            item.push(i, len, done);
            func.apply(this, item);
        }
      }
    }
  } else {
    const keys = lib.keys(arr || {});
    len = keys.length;
    outputArr = new Array(len);

    if (len === 0) {
      cb(null, '');
    } else {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        func(k, arr[k], i, len, done);
      }
    }
  }
}

function fromIterator(arr) {
  if (typeof arr !== 'object' || arr === null || lib.isArray(arr)) {
    return arr;
  } else if (supportsIterators && Symbol.iterator in arr) {
    return arrayFrom(arr);
  } else {
    return arr;
  }
}

function setLoopBindings(frame, index, len) {
  frame.set('loop.index', index + 1);
  frame.set('loop.index0', index);
  frame.set('loop.revindex', len - index);
  frame.set('loop.revindex0', len - index - 1);
  frame.set('loop.first', index === 0);
  frame.set('loop.last', index === len - 1);
  frame.set('loop.length', len);
}

async function iterate(arr, loopBody, loopElse, frame, loopVars = [], isAsync = false) {
  let didIterate = false;
  if (arr) {
    if (isAsync && typeof arr[Symbol.asyncIterator] === 'function') {
      const iterator = arr[Symbol.asyncIterator]();
      let result;
      const values = [];

      while ((result = await iterator.next()), !result.done) {
        values.push(result.value);
      }

      const len = values.length;
      for (let i = 0; i < len; i++) {
        didIterate = true;
        const value = values[i];

        if (loopVars.length === 1) {
          await loopBody(value, i, len);
        } else {
          if (!Array.isArray(value)) {
            throw new Error('Expected an array for destructuring');
          }
          await loopBody(...value.slice(0, loopVars.length), i, len);
        }
      }
    } else {
      arr = fromIterator(arr);

      if (Array.isArray(arr)) {
        const len = arr.length;

        for (let i = 0; i < len; i++) {
          didIterate = true;
          const value = arr[i];


          if (loopVars.length === 1) {
            loopBody(value, i, len);
          } else {
            if (!Array.isArray(value)) {
              throw new Error('Expected an array for destructuring');
            }
            loopBody(...value.slice(0, loopVars.length), i, len);
          }
        }
      } else {
        const keys = Object.keys(arr);
        const len = keys.length;

        for (let i = 0; i < len; i++) {
          didIterate = true;
          const key = keys[i];
          const value = arr[key];


          if (loopVars.length === 2) {
            loopBody(key, value, i, len);
          } else {
            throw new Error('Expected two variables for key/value iteration');
          }
        }
      }
    }
  }

  if (!didIterate && loopElse) {
    await loopElse();
  }
}

module.exports = {
  Frame: Frame,
  AsyncFrame: AsyncFrame,
  makeMacro: makeMacro,
  makeKeywordArgs: makeKeywordArgs,
  numArgs: numArgs,
  suppressValue: suppressValue,
  suppressValueAsync: suppressValueAsync,
  ensureDefined: ensureDefined,
  ensureDefinedAsync: ensureDefinedAsync,
  promisify: promisify,
  resolveAll: resolveAll,
  resolveDuo: resolveDuo,
  resolveSingle: resolveSingle,
  resolveSingleArr: resolveSingleArr,
  resolveObjectProperties: resolveObjectProperties,
  resolveArguments: resolveArguments,
  flattentBuffer: flattentBuffer,
  memberLookup: memberLookup,
  memberLookupAsync: memberLookupAsync,
  contextOrFrameLookup: contextOrFrameLookup,
  callWrap: callWrap,
  handleError: handleError,
  isArray: lib.isArray,
  keys: lib.keys,
  SafeString: SafeString,
  newSafeStringAsync: newSafeStringAsync,
  copySafeness: copySafeness,
  markSafe: markSafe,
  asyncEach: asyncEach,
  asyncAll: asyncAll,
  inOperator: lib.inOperator,
  fromIterator: fromIterator,
  iterate: iterate,
  setLoopBindings
};
