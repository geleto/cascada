# Streaming

Cascada supports streaming inputs through JavaScript iterables and async iterables. A stream source can be consumed by `for` or `each`, and the body can write to normal `data` and `text` channels.

Dedicated script stream channels such as `stream`, `textStream`, `@stream`, `@textStream`, and result types such as `:stream` are future design ideas, not current syntax.

## Async Iterable Inputs

Any JavaScript async iterable can be passed through the script context and used as a loop source:

```javascript
data result

for item in source
  result.items.push(process(item))
endfor

return result.snapshot()
```

The loop reads the iterable as values become available. As with other Cascada loops, independent loop iterations may run concurrently, while channel writes are assembled in deterministic source order.

Use `each` when the loop body must execute sequentially:

```javascript
text body

each chunk in source
  body(chunk)
endeach

return body.snapshot()
```

## Loop Metadata

Streaming sources may not know their full length up front. For async iterables, avoid relying on `loop.length`, `loop.revindex`, or `loop.last` unless the source has already been materialized into an array.

Stable forward indexes such as `loop.index` and `loop.index0` remain the useful loop metadata for streaming inputs.

## Producing Streamed Results

Current scripts materialize streamed work through channels and explicit snapshots:

```javascript
data rows

for row in readRows()
  rows.push(transform(row))
endfor

return rows.snapshot()
```

This gives deterministic, source-ordered results even when `readRows()` yields asynchronously and `transform(row)` resolves out of order.

## Future Stream Channels

Earlier drafts proposed first-class stream channels with direct read helpers, index access, and chunk-level text streams. Those ideas are not part of the current script surface. Until they are implemented, use JavaScript async iterables as inputs and `data` / `text` channels as the supported output mechanism.
