// Run with npm run test:types (also included in npm test).
import {AsyncEnvironment, createSharedAsyncIterable} from '../../src/index.js';
import {AsyncEnvironment as PrecompiledEnvironment, createSharedAsyncIterable as precompiledShare} from '../../src/precompiled/index.js';

new AsyncEnvironment(null, {replayAsyncIterables: false});
new PrecompiledEnvironment(null, {replayAsyncIterables: false});
// @ts-expect-error The native-mode switch is boolean.
new AsyncEnvironment(null, {replayAsyncIterables: 'false'});
// @ts-expect-error Both entries have the same option type.
new PrecompiledEnvironment(null, {replayAsyncIterables: 'false'});

for (const share of [createSharedAsyncIterable, precompiledShare]) {
  const source = {label: 'native', async *[Symbol.asyncIterator]() { yield 1; }};
  const shared = share(source);
  const iterable: AsyncIterable<number> = shared;
  const cleanup: Promise<void> = shared.dispose();
  const disposable: Promise<void> = shared[Symbol.asyncDispose]();
  // @ts-expect-error Replay preserves the element type.
  const wrongIterable: AsyncIterable<string> = shared;
  // @ts-expect-error A shared iterable does not forward native properties.
  shared.label;
  // @ts-expect-error Only cursors expose next().
  shared.next();
  // @ts-expect-error Only cursors expose return().
  shared.return();
  // @ts-expect-error Source injection is not part of the replay protocol.
  shared.throw(new Error());
  // @ts-expect-error Require an async iterable.
  share({});

  const callable = share(Object.assign((n: number) => n * 2, source));
  const callableItems: AsyncIterable<number> = callable;
  // @ts-expect-error The explicit replay iterable is not callable.
  callable(21);
  void [iterable, cleanup, disposable, wrongIterable, callableItems];
}
