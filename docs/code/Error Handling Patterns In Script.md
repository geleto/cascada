# Error Handling Patterns In Script

This document collects practical Cascada Script patterns for handling dataflow
poison, sequential-path failures, and guard recovery.

It is intentionally example-focused. For the full language contract, see
`docs/cascada/script.md`; for implementation rules, see
`docs/code/Error Handling Guide.md` and
`docs/code/Poisoning - Implementation Principles.md`.

## Core Rules To Remember

- A failed value becomes an Error Value.
- Error Values propagate through dependent expressions.
- Unrelated work continues.
- Scripts fail only when the returned value is poisoned.
- Use `value is error` / `value is not error` to branch.
- Use `value#message` and related `#` peeks only after checking that the value
  is an error.
- Functions receive poisoned arguments and can handle them explicitly.
- Use `guard` when you need transactional rollback of channels, variables, or
  sequential paths.
- Use `!!` to repair a poisoned sequential path before cleanup or retry work.

## Partial Success From Parallel Work

Independent work can run in parallel. Collect successes and record failures
without letting a single failed source poison the returned result.

```javascript
data out

var profile = fetchProfile(userId)
var orders = fetchOrders(userId)
var recommendations = fetchRecommendations(userId)

if profile is not error
  out.profile = profile
else
  out.failures.push({ source: "profile", message: profile#message })
endif

if orders is not error
  out.orders = orders
else
  out.failures.push({ source: "orders", message: orders#message })
endif

if recommendations is not error
  out.recommendations = recommendations
else
  out.failures.push({ source: "recommendations", message: recommendations#message })
endif

return out.snapshot()
```

Use this shape when the final result can be useful even with missing optional
sections.

## Cascading Fallbacks

Repair a value by reassigning it to a fallback. Once repaired, downstream code
can use it normally.

```javascript
var data = fetchFromPrimaryCache(key)

if data is error
  data = fetchFromSecondaryCache(key)
endif

if data is error
  data = fetchFromDatabase(key)
endif

if data is error
  data = { key: key, value: none, source: "default" }
endif

return data
```

This pattern is usually better than wrapping every use site in a guard.

## Retry With Sequential Path Repair

Sequential paths become poisoned after a failed `!` operation. Use `!!` before
retrying the path or running cleanup through the same path.

```javascript
data out

var attempt = 0
var response = none

while attempt < 3
  context.api!!
  response = context.api!.send(payload)

  if response is not error
    break
  endif

  attempt = attempt + 1
  wait(100 * attempt)  {# host-provided delay; replace with your environment's sleep/delay function #}
endwhile

if response is error
  out.status = "failed"
  out.message = response#message
else
  out.status = "ok"
  out.response = response
endif

return out.snapshot()
```

The important part is `context.api!!` before each retry. Without it, later
`context.api!` operations will skip because the path is still poisoned.

## Transaction With Guard

Use `guard` for transactional workflows where output/channel state and
sequential paths should roll back on failure.

```javascript
data out
sequence db = context.db

guard out, db!
  db!.begin()
  var user = db!.insertUser(userData)
  var audit = db!.insertAudit({ action: "create_user", user: user.id })
  db!.commit()

  out.status = "created"
  out.user = user
  out.audit = audit
recover err
  db!!.rollback()
  out.status = "failed"
  out.message = err#message
endguard

return out.snapshot()
```

The guard captures the selected state. If the guarded body remains poisoned,
the selected state is restored before `recover` runs.

## Graceful Degradation With Nested Guards

Nested guards are useful when you want a high-quality path, then a cheaper
fallback, then a minimal fallback.

```javascript
data out

guard out
  var detailed = fetchDetailedUser(userId)
  out.level = "detailed"
  out.user = detailed
recover
  guard out
    var basic = fetchBasicUser(userId)
    out.level = "basic"
    out.user = basic
  recover
    out.level = "minimal"
    out.user = { id: userId }
  endguard
endguard

return out.snapshot()
```

Each guard protects `out` for only its own attempt.

## Batch Processing With Error Collection

For loops can run iterations in parallel. Use ordered channel assembly for the
final deterministic result instead of mutating shared JavaScript arrays.

```javascript
data out

for userId in userIds
  var user = fetchUser(userId)

  if user is error
    out.failed.push({ userId: userId, message: user#message })
  else
    out.users.push(user)
  endif
endfor

return out.snapshot()
```

The `data` channel preserves source-order assembly even though the fetches can
complete in a different order.

## Handling Poisoned Function Arguments

Functions are useful places to normalize optional poisoned values. They receive
Error Values as arguments and can inspect them explicitly.

```javascript
function profileSummary(profile)
  if profile is error
    return {
      available: false,
      message: profile#message
    }
  endif

  return {
    available: true,
    name: profile.name,
    role: profile.role
  }
endfunction

var profile = fetchProfile(userId)
return profileSummary(profile)
```

Do this when a domain-specific value should represent the failure instead of
letting poison reach the script return.

## Cleanup After Failed Work

For side-effecting resources, use sequential paths plus `!!` for cleanup that
must run even after earlier operations failed.

```javascript
data out

var opened = context.files!.open(path)
var written = context.files!.write(contents)

context.files!!.close()

if written is error
  out.status = "failed"
  out.message = written#message
else
  out.status = "written"
endif

return out.snapshot()
```

Use a guard as well if channel or variable state should be rolled back around
the resource operations.

## Converting Errors To A Stable Return

The safest top-level shape is often: do work, normalize errors, then return a
non-poisoned value.

```javascript
data out

var result = runWorkflow(input)

if result is error
  out.ok = false
  out.error = {
    message: result#message,
    source: result#source
  }
else
  out.ok = true
  out.result = result
endif

return out.snapshot()
```

If you instead `return result` while `result` is poisoned, the render fails with
that poison.

## Anti-Patterns

- Do not pass poison to context logging/reporting functions and expect those
  functions to run. Check `is error` first and pass ordinary strings/objects.
- Do not use `!!` on ordinary variables. It is for sequential paths.
- Do not use `!` on dynamic/template-local paths that the compiler cannot
  statically resolve.
- Do not manually push loop results into a shared JavaScript array when source
  order matters. Use `data` channel assembly.
- Do not rely on `#message` without an `is error` check; non-error values return
  `none` for `#` peeks.
- Do not use `guard *` around large regions unless you need full rollback; it
  can reduce parallelism by protecting more state than necessary.
