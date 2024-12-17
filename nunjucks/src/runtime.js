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
  constructor(parent, isolateWrites) {
    this.variables = Object.create(null);
    this.parent = parent;
    this.topLevel = false;
    // if this is true, writes (set) should never propagate upwards past
    // this frame to its parent (though reads may).
    this.isolateWrites = isolateWrites;
  }

  // nunjucks bug?, resolveUp is not used in recursive calls
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

class TimelineRecord {
  constructor() {
    this.variables = Object.create(null);
    this.frames = null;
  }
}

// A frame which instances can create snapshots of itself that
// can be used as regular frames. Further changes to the frame
// don't affect the snapshots, and vice-versa.
//@todo - frames that don't create scope should not host variables
class AsyncFrame {
  constructor(parent, isolateWrites, createScope=true) {
    this.timeline = [new TimelineRecord()];
    this.parent = parent;
    this.topLevel = false;

    if(AsyncFrame.inCompilerContext){
      if(!parent){
        this.idCounter = {value: 1};
      }
      else {
        this.idCounter = parent.idCounter;
      }
      //the compiler generates an unique id for each async block
      this.id = this.idCounter.value++;

      //variables set from the compiler side:

      //holds the current dependencies for each variable as the compiler traverses the AST
      //it is stored in the frame where the variable is first declared
      //the variable name is the key and the value is an id of the async block that last modifies the variable (@temp - todo an array of ids)
      //@todo - this should be an array with all the async blocks that MAY influence the variable (incl. from speculative branches) at this time of AST traversal
      this.varDependencies = null;

      //holds the write counts for each variable that CAN be modified in an async block or its children
      //this includes variables that are modified in branches that are not taken (e.g. both sides of an if)
      //the counts decrement is propagated upwards before the frame that has declared the variable
      this.writeCounts = null;

      //holds the dependencies for each variable read by an async block
      //the variable name is the key and the value is an array of ids of the async blocks that the variable depends on
      //stored at each aync block frame that either reads or it's children read the variable
      //propagated upwards before the frame that has declared the variable
      this.blockDependencies = null;

    } else {
      //holds the id of the async block, comes from the compiler as an argument to the snapshot method
      this.id = null;

      //holds promise data for each async block that modifies variables
      //the promise data holds a value - a promise (if block is active) or final value
      //as well as a resolve function to use once the block is done modifying the variable
      this.promiseDataById = parent ? parent.promiseDataById : new Map();

      //holds the write counters for each variable that is modified in an async block or its children
      //The decreminting is propagated upwards before the frame that has declared the variable
      //the variable name is the key and the value is the number of remaining writes (including missed writes due to branches)
      //once the counter reaches 0, the promise for the variable is resolved
      this.writeCounters = null;

      //holds the variables that are modified in an async block while it is active
      //the variable name is the key and the value is the value of the variable
      //once the block is done modifying a variable, the promise for the variable is resolved with this value
      this.asyncVars = null;
    }

    // if this is true, writes (set) should never propagate upwards past
    // this frame to its parent (though reads may).
    this.isolateWrites = isolateWrites;

    this.isSnapshot = false;
  }

  static inCompilerContext = false;

  set(name, val, resolveUp) {
    let lastTimelineRecord = this.timeline[this.timeline.length - 1];
    if(lastTimelineRecord.frames && lastTimelineRecord.frames.size > 0){
      //do not touch this snapshot as it has frames attached to it
      //create a new snapshot
      lastTimelineRecord = new TimelineRecord();
      this.timeline.push(lastTimelineRecord);
    }

    let parts = name.split('.');
    let obj = lastTimelineRecord.variables;
    let frame = this;

    if( this.asyncVars && parts[0] in this.asyncVars ){
      //when inside an async block, vars that are tracked are kept in asyncVars
      obj = this.asyncVars;
      resolveUp = false;
    }

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

    if( obj === this.asyncVars ){
      this._trackAsyncWrites(parts[0]);
    }
  }

  get(name) {
    for(let i = this.timeline.length - 1; i >= 0; i--){
      let timelineRecord = this.timeline[i];
      let val = timelineRecord.variables[name];
      if (val !== undefined) {
        return val;
      }
    }
    return null;
  }

  lookup(name, snapshotFrame = null) {
    var p = this.parent;
    let trIndex = snapshotFrame ? this._findSnapshotInTimeline(snapshotFrame) : this.timeline.length - 1;
    if(trIndex === -1){
      throw new Error('snapshotFrame not in the timeline');
    }
    for(let i = trIndex; i >= 0; i--){
      let timelineRecord = this.timeline[i];
      let asyncVal = this.asyncVars && this.asyncVars[name];
      if(asyncVal !== undefined){
        return asyncVal;
      }
      let val = timelineRecord.variables[name];
      if (val !== undefined) {
        return val;
      }
    }
    return p && p.lookup(name, snapshotFrame || (this.isSnapshot ? this : null));
  }

  resolve(name, forWrite, snapshotFrame = null) {
    var p = (forWrite && this.isolateWrites) ? undefined : this.parent;
    let trIndex = snapshotFrame ? this._findSnapshotInTimeline(snapshotFrame) : this.timeline.length - 1;
    if(trIndex === -1){
      throw new Error('snapshotFrame not in the timeline');
    }
    for (let i = trIndex; i >= 0; i--) {
      let timelineRecord = this.timeline[i];
      if (timelineRecord.variables[name] !== undefined) {
        return this;
      }
    }

    // If not found, check parent frame
    return p && p.resolve(name, forWrite, snapshotFrame || (this.isSnapshot ? this : null));
  }

  //@todo - frames that don't create scope should not host variables
  push(isolateWrites, createScope=true) {
    return new AsyncFrame(this, isolateWrites, createScope);
  }

  pop() {
    return this.parent;
  }

  new() {
    return new AsyncFrame();//undefined, this.isolateWrites);
  }

  //@todo - reenterWriteCounters
  //@todo audit snapshotFrame vs this
  snapshot(dependIds, id, writeCounters, reenterWriteCounters) {
    let snapshotFrame = new AsyncFrame(this, this.isolateWrites);//@todo - should isolateWrites be passed here?
    snapshotFrame.isSnapshot = true;
    this._addSnapshot(snapshotFrame);
    snapshotFrame._processDependencyData(dependIds, id, writeCounters, reenterWriteCounters);
    return snapshotFrame;
  }

  _processDependencyData(dependIds, id, writeCounters, reenterWriteCounters) {
    this.id = id;
    if(dependIds){
      for(let varName in dependIds) { // eslint-disable-line guard-for-in
        this._initVariablePromiseData(dependIds[varName], varName);
        this.asyncVars = this.asyncVars || {};
        this.asyncVars[varName] = this.get(varName);
      }
    }

    if(writeCounters) {
      this.writeCounters = writeCounters;
      for (let varName in writeCounters) { // eslint-disable-line guard-for-in
        //just create the promise data object, the promise will be created when the
        //first async block to read this variable is encountered
        this.promiseData = this.promiseDataById.get(id);
        if(!this.promiseData){
          this.promiseData = {};
          this.promiseDataById.set(id, this.promiseData);
        } else {
          if(reenterWriteCounters) {
            if( Object.keys(this.promiseData).length ){
              //re-entering the async block while it's still active
              this.promiseDataById = new Map();//a new promise data map
              this.promiseDataById.reenteredFrom = this.promiseDataById;
              //@todo - all local get variables should be queried from reenteredFrom
            }
          }
        }
        this.asyncVars = this.asyncVars || {};
        this.asyncVars[varName] = this.get(varName);//will use this value while the async block is active
      }
    }
  }

  _initVariablePromiseData(dependId, varName){
    //@todo - if reentering the async block, the writeCounters will be present
    let promiseData = this.promiseDataById.get(dependId);//should not be null
    if(promiseData && !promiseData[varName]){
      //create the promise for the variable
      //@todo - do not create the promise until it is needed by a read?
      let resolve;
      let value = new Promise((res)=>{
        resolve = res;
      });
      this.promiseDataById[dependId][varName] = { value, resolve };
    }
  }

  //when all assignments to a variable are done, resolve the promise for that variable
  _trackAsyncWrites(varName){
    if(this.writeCounters && varName in this.writeCounters){
      if(this.writeCounters[varName]===0) {
        throw new Error(`Variable ${varName} write counter turned negative in _trackAsyncWrites`);
      }
      this.writeCounters[varName]--;
      if(this.writeCounters[varName]===0){
        this._resolveAsyncVar(varName);
      }
    }
    if(this.parent && this.parent.parent && !this.parent.isolateWrites){
      this.parent._trackAsyncWrites(varName);
    }
  }

  _resolveAsyncVar(varName){
    //this variable will no longer be modified, time to resolve it
    let value = this.asyncVars[varName];

    if(!this.promiseData) {
      this.promiseData = this.promiseDataById.get(this.id);
      if(!this.promiseData) {
        this.promiseData = {};
        this.promiseDataById.set(this.promiseData);
      }
    }

    if(this.promiseData[varName]){
      this.promiseData[varName].resolve(value);
      this.promiseData[varName].value = value;//no longer promise wrapped
    } else {
      //no async block has requested to read this var yet - set it to the final value
      this.promiseData[varName] = { value };
    }
  }

  //A branch is active that skips some assignment, track them as if they are performed
  trackMissedAsyncWrites(varCounts){
    if(!this.writeCounters ){
      throw new Error('Can not resolve vars: no set vars counts in this frame');
    }
    // eslint-disable-next-line guard-for-in
    for(let varName in varCounts){
      if(!(varName in this.writeCounters)){
        throw new Error('Can not resolve var: var not in set vars counts');
      }
      this.writeCounters[varName] -= varCounts[varName];
      if(this.writeCounters[varName]<0){
        throw new Error(`Variable ${varName} write counter turned negative in _trackMissedAssignments`);
      }
      if(this.writeCounters[varName]===0){
        this._resolveAsyncVar(varName);
      }
    }
    if(this.parent && this.parent.parent && !this.parent.isolateWrites){
      this.parent._trackMissedAssignments(varCounts);
    }
  }

  _addSnapshot(snapshotFrame) {
    let lastTimelineRecord = this.timeline[this.timeline.length - 1];
    if(!lastTimelineRecord.frames){
      lastTimelineRecord.frames = new Set();
    }
    lastTimelineRecord.frames.add(snapshotFrame);
    if(this.parent){
      this.parent._addSnapshot(snapshotFrame);
    }
  }


  dispose(snapshotFrame = null) {
    if(!snapshotFrame){
      if(!this.parent){
        throw new Error('Cannot dispose of root frame');
      }
      this.parent.dispose(this);
      return;
    }
    if(!snapshotFrame.isSnapshot){
      throw new Error('Cannot dispose a frame that is not a snapshot');
    }
    if(this.parent){
      this.parent.dispose(snapshotFrame);
    }
    //find the snapshot frame in the timeline and remove it
    let snapPos = this._findSnapshotInTimeline(snapshotFrame);
    if(snapPos==-1){
      throw new Error('snapshotFrame not in the timeline');
    }

    let timelineRecord = this.timeline[snapPos];
    timelineRecord.frames.delete(snapshotFrame);
    if(timelineRecord.frames.size === 0){
      if( snapPos>0 ){
        let previousRecord = this.timeline[snapPos - 1];
        Object.assign(previousRecord.variables, timelineRecord.variables);
        this.timeline.splice(snapPos, 1);
      }
      else if(this.timeline.length > 1){
        let nextRecord = this.timeline[snapPos + 1];
        Object.assign(timelineRecord.variables, nextRecord.variables);
        nextRecord.variables = timelineRecord.variables;
        this.timeline.splice(snapPos, 1);
      }
    }
  }

  //retruns a the index of the record in the timeline that has snapshotFrame
  _findSnapshotInTimeline(snapshotFrame){
    return this.timeline.findIndex(
      record => record.frames && record.frames.has(snapshotFrame)
    );
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
      if(astate && Object.keys(kwargs).length === 0){
        args.push({});//kwargs
      }
    }

    if(astate) {
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
  } else if (type === 'object' && val.then && typeof val.then === 'function'){
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
  if( val && typeof val.then === 'function'){
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
  return function(...args) {
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
  return async function(...args) {
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
    return (...args) => obj[val].apply(obj, args);
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

async function iterate(arr, loopBody, loopElse, frame, options = {}) {
  let didIterate = false;
  const loopVars = options.loopVars || [];
  const isAsync = options.async || false;

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
  iterate: iterate
};
