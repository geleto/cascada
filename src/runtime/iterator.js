import {PoisonError} from './errors.js';

function assertIteratorResult(result) {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) {
    throw new TypeError('Iterator methods must return an object.');
  }
}

function readIteratorResult(result) {
  assertIteratorResult(result);
  return result.done ? {done: true} : {done: false, value: result.value};
}

async function asyncIteratorNext(iterator, next, errorContext) {
  try {
    return readIteratorResult(await next.call(iterator));
  } catch (error) {
    throw PoisonError.wrap(error, errorContext, 'IteratorThrew');
  }
}

function iteratorClose(iterator) {
  const close = iterator.return;
  if (close != null) assertIteratorResult(close.call(iterator));
}

async function asyncIteratorClose(iterator) {
  const close = iterator.return;
  if (close != null) assertIteratorResult(await close.call(iterator));
}

export {assertIteratorResult, readIteratorResult, asyncIteratorNext, iteratorClose, asyncIteratorClose};
