import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/index.js';
import {createPoison} from '../../src/runtime/runtime.js';

const delay = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));

describe('README examples', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  it('runs the data channel assembly example in source order', async function () {
    const script = `
      // Assume fetchProductDetails for ID 205 is the slowest.
      var productIds = [101, 205, 302]
      data report
      report.totalReviews = 0

      // Each iteration runs concurrently.
      for id in productIds
        var details = fetchProductDetails(id)
        var reviews = fetchProductReviews(id)

        report.products.push({
          id: details.id,
          name: details.name,
          reviewCount: reviews.length
        })
        report.totalReviews += reviews.length
      endfor

      return report.snapshot()
    `;
    const result = await env.renderScriptString(script, {
      fetchProductDetails(id) {
        const ms = id === 205 ? 15 : 1;
        return delay(ms, {id, name: `Product ${id}`});
      },
      fetchProductReviews(id) {
        const counts = {101: 1, 205: 3, 302: 2};
        return delay(5 - counts[id], Array.from({length: counts[id]}, (_, i) => i));
      }
    });

    expect(result).to.eql({
      totalReviews: 6,
      products: [
        {id: 101, name: 'Product 101', reviewCount: 1},
        {id: 205, name: 'Product 205', reviewCount: 3},
        {id: 302, name: 'Product 302', reviewCount: 2}
      ]
    });
  });

  it('runs the AI orchestration example with a post-loop snapshot', async function () {
    const script = `
      // 1. Generate a plan with an LLM call.
      data result
      var plan = makePlan(
        "Analyze competitor's new feature")
      result.plan = plan

      // 2. Each step runs concurrently.
      for step in plan.steps
        var stepResult =
          executeStep(step.instruction)
        result.stepResults.push({
          step: step.title,
          result: stepResult
        })
      endfor

      // 3. Summarize the results once the loop writes finish
      var steps = result.snapshot().stepResults
      result.summary = summarize(steps)
      return result.snapshot()
    `;
    const result = await env.renderScriptString(script, {
      makePlan() {
        return {
          steps: [
            {title: 'Research', instruction: 'find signals'},
            {title: 'Compare', instruction: 'score impact'}
          ]
        };
      },
      executeStep(instruction) {
        return delay(instruction === 'find signals' ? 10 : 1, `done: ${instruction}`);
      },
      summarize(steps) {
        return steps.map(step => step.step).join(', ');
      }
    });

    expect(result.stepResults).to.eql([
      {step: 'Research', result: 'done: find signals'},
      {step: 'Compare', result: 'done: score impact'}
    ]);
    expect(result.summary).to.be('Research, Compare');
  });

  it('runs the function summary example with concurrent user summaries', async function () {
    const script = `
      // Fetches a user's details and recent activity concurrently to build a summary.
      function buildUserSummary(userId)
        var details = fetchUserDetails(userId)
        var posts = fetchUserPosts(userId)
        var comments = fetchUserComments(userId)

        return {
          name: details.name,
          postCount: posts.length,
          commentCount: comments.length
        }
      endfunction

      var user1 = buildUserSummary(101)
      var user2 = buildUserSummary(102)

      return {
        report: {
          user1Summary: user1,
          user2Summary: user2
        }
      }
    `;
    const result = await env.renderScriptString(script, {
      fetchUserDetails(id) {
        return delay(id === 101 ? 10 : 1, {name: id === 101 ? 'Alice' : 'Bob'});
      },
      fetchUserPosts(id) {
        return id === 101 ? ['p1', 'p2'] : ['p3'];
      },
      fetchUserComments(id) {
        return id === 101 ? ['c1'] : ['c2', 'c3', 'c4'];
      }
    });

    expect(result).to.eql({
      report: {
        user1Summary: {name: 'Alice', postCount: 2, commentCount: 1},
        user2Summary: {name: 'Bob', postCount: 1, commentCount: 3}
      }
    });
  });

  it('runs the guard recover example on the recovery path', async function () {
    const script = `
      var result
      guard
        var image = generateImage(prompt)
        result = { imageUrl: image.url }
      recover err
        result = { error: "Failed: " + err.message }
      endguard
      return result
    `;
    const result = await env.renderScriptString(script, {
      prompt: 'mountain',
      generateImage() {
        return createPoison(new Error('image service unavailable'));
      }
    });

    expect(result.error).to.contain('Failed: ');
    expect(result.error).to.contain('image service unavailable');
  });

  it('runs the sequential side effects example without racing account methods', async function () {
    const script = `
      // The '!' on deposit() creates a sequence for the account path.
      account!.deposit(100)
      var status = account.getStatus()
      account!.withdraw(50)

      return { status: status, log: account.log }
    `;
    const account = {
      balance: 0,
      log: [],
      deposit(amount) {
        this.balance += amount;
        this.log.push(`deposit:${amount}`);
      },
      getStatus() {
        this.log.push(`status:${this.balance}`);
        return {balance: this.balance};
      },
      withdraw(amount) {
        this.balance -= amount;
        this.log.push(`withdraw:${amount}`);
      }
    };

    const result = await env.renderScriptString(script, {account});
    expect(result).to.eql({
      status: {balance: 100},
      log: ['deposit:100', 'status:100', 'withdraw:50']
    });
  });

  it('runs the text channel async iterator example', async function () {
    const script = `
      var post = fetchPost(42)

      text output
      for comment in fetchComments(post.id)
        output(comment.author + ": " + comment.body + "\\n")
      endfor

      return output.snapshot()
    `;
    const result = await env.renderScriptString(script, {
      fetchPost() {
        return delay(1, {id: 42, title: 'Async Post'});
      },
      async *fetchComments() {
        yield delay(5, {author: 'Ada', body: 'First'});
        yield delay(1, {author: 'Grace', body: 'Second'});
      }
    });

    expect(result).to.be('Ada: First\nGrace: Second\n');
  });
});
