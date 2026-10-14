import {PoisonError} from './errors.js';

function assertIteratorResult(result) {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) {
    throw new TypeError('Async iterator methods must return an object.');
  }
}

function readIteratorResult(result) {
  assertIteratorResult(result);
  return result.done ? {done: true} : {done: false, value: result.value};
}

async function nextAsyncIterator(iterator, next, errorContext) {
  try {
    return readIteratorResult(await next.call(iterator));
  } catch (error) {
    throw PoisonError.wrap(error, errorContext, 'IteratorThrew');
  }
}

async function closeAsyncIterator(iterator) {
  const close = iterator.return;
  if (close != null) assertIteratorResult(await close.call(iterator));
}

export {assertIteratorResult, readIteratorResult, nextAsyncIterator, closeAsyncIterator};
