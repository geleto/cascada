
#### Common Error Handling Patterns

Here are practical patterns for handling errors in real-world Cascada scripts:

##### Pattern: Retry with Exponential Backoff

```javascript
var attempt = 0
var data

while attempt < 5
  context.api!!  // Repair path before each attempt
  data = context.api!.sendRequest(payload)

  if data is not error
    break
  endif

  sleep(100 * (2 ** attempt))  // Exponential backoff
  attempt = attempt + 1
endwhile

@data.result = data is not error ? data : none
@data.status = data is not error ? "success" : "failed"
```

##### Pattern: Parallel Operations with Partial Success

```javascript
// Fetch from multiple sources in parallel
var source1 = fetchFromSource1()
var source2 = fetchFromSource2()
var source3 = fetchFromSource3()

// Collect only successes
if source1 is not error
  @data.sources.push({ name: "source1", data: source1 })
endif
if source2 is not error
  @data.sources.push({ name: "source2", data: source2 })
endif
if source3 is not error
  @data.sources.push({ name: "source3", data: source3 })
endif
```

##### Pattern: Transaction with Rollback

```javascript
context.db!.beginTransaction()
var result = context.db!.insert("users", userData)

if context.db! is error
  context.db!!.rollback()  // Cleanup despite poison

  guard @data
    @data.result = result  // Would poison
  recover
    @data.status = "failed"
    @data.error = context.db!#message
  endguard
else
  context.db!.commit()
  @data.status = "success"
endif
```

##### Pattern: Cascading Fallbacks

```javascript
var data = fetchFromPrimaryCache(key)

if data is error
  data = fetchFromSecondaryCache(key)
  if data is error
    data = fetchFromDatabase(key)
    if data is error
      data = getStaticDefault(key)
    endif
  endif
endif

@data.value = data
```

##### Pattern: Graceful Degradation

```javascript
var fullData = fetchDetailedData(id)

guard @data
  @data.result = fullData
  @data.level = "full"
recover
  var basicData = fetchBasicData(id)

  guard @data
    @data.result = basicData
    @data.level = "basic"
  recover
    @data.result = { id: id }
    @data.level = "minimal"
  endguard
endguard
```

##### Pattern: Batch Processing with Error Collection

```javascript
var userIds = [101, 102, 103, 104, 105]

for userId in userIds
  var user = fetchUser(userId)

  if user is not error
    @data.users.push(user)
  else
    @data.failed.push({ userId: userId, error: user#message })
  endif
endfor

@data.summary = {
  processed: @data.users | length,
  failed: @data.failed | length
}
```

##### Pattern: Retry Loop with Guard

```javascript
var attempts = 0
var success = false

while attempts < 3 and not success
  guard @data
    context.api!!
    var result = context.api!.fetchData()
    @data.result = result
    @data.status = "success"
    success = true
  recover
    attempts = attempts + 1
  endguard
endwhile

if not success
  @data.status = "failed_after_retries"
  @data.attempts = attempts
endif
```

##### Pattern: Resource Cleanup

```javascript
var resource = context.resources!.acquire(id)

context.resources!.initialize()
var workResult = context.resources!.doWork(data)

// Always release, even if work failed
context.resources!!.release()

guard @data
  @data.result = workResult
recover
  @data.error = "Work failed"
endguard
```