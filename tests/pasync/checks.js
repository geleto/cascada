const expect = require('expect.js');
const { Frame } = require('../../src/runtime/frame');
const { ENABLE_FRAME_BALANCE_CHECK } = require('../../src/runtime/checks');
const {
  ENABLE_READVARS_VALIDATION,
  trackActualRead,
  markReadVarPassThrough,
  validateReadVarsConsistency
} = require('../../src/compiler/validation');

describe('Frame Balance Validation', function () {
  it('should validate balanced push/pop operations', function () {
    if (!ENABLE_FRAME_BALANCE_CHECK) {
      this.skip();
      return;
    }

    // Simulate runtime environment initialization logic if needed
    // The frame itself should handle its own depth tracking if initialized correctly

    // Root frame usually has undefined depth initially, but let's see how push handles it
    // push adds 1 to (this._runtimeDepth || 0)

    const root = new Frame(null, false);
    // Manually init root depth as runtime would do?
    // Actually runtime doesn't init root depth implicitly unless we modify Frame constructor.
    // But push() handles undefined by defaulting to 0.

    // So:
    // root._runtimeDepth undefined -> 0
    // child._runtimeDepth = 0 + 1 = 1
    const child = root.push(false, true);

    expect(child._runtimeDepth).to.be(1);

    // When popping child:
    // child._runtimeDepth is 1.
    // expected parent depth is 0.
    // root._runtimeDepth is undefined.
    // 0 !== undefined.

    // WAIT! If root._runtimeDepth is undefined, the check logic:
    // if (frame._runtimeDepth !== undefined && parent._runtimeDepth !== undefined)

    // So if parent doesn't have depth tracked, check is skipped?
    // Let's verify this behavior in checks.js

    // "if (frame._runtimeDepth !== undefined && parent._runtimeDepth !== undefined)"

    // So I need to verify if root frame gets depth initialized.
    // Frame constructor does NOT init it.

    // I should initialize it manually for the test to ensure validation happens.
    root._runtimeDepth = 0;

    const child2 = root.push(false, true);
    expect(child2._runtimeDepth).to.be(1);

    const popped = child2.pop();
    expect(popped).to.be(root);
  });

  it('should detect frame depth mismatch', function () {
    if (!ENABLE_FRAME_BALANCE_CHECK) {
      this.skip();
      return;
    }

    const root = new Frame(null, false);
    root._runtimeDepth = 0;

    const child = root.push(false, true);
    expect(child._runtimeDepth).to.be(1);

    // Manually corrupt depth to simulate imbalance
    child._runtimeDepth = 5;

    expect(() => {
      child.pop();
    }).to.throwException(/Frame depth mismatch/);
  });

  it('should detect pop without parent (root pop)', function () {
    if (!ENABLE_FRAME_BALANCE_CHECK) {
      this.skip();
      return;
    }

    const root = new Frame(null, false);
    root._runtimeDepth = 0;

    // Root has no parent, so pop should throw "Frame pop without parent"
    expect(() => {
      root.pop();
    }).to.throwException(/Frame pop without parent/);
  });

  it('should handle nested frames correctly', function () {
    if (!ENABLE_FRAME_BALANCE_CHECK) {
      this.skip();
      return;
    }

    const root = new Frame(null, false);
    root._runtimeDepth = 0;

    const l1 = root.push(false, true);
    const l2 = l1.push(false, true);
    const l3 = l2.push(false, true);

    expect(l3._runtimeDepth).to.be(3);

    const p2 = l3.pop();
    expect(p2).to.be(l2);

    const p1 = p2.pop();
    expect(p1).to.be(l1);

    const p0 = p1.pop();
    expect(p0).to.be(root);
  });

  it('should track depth in pushAsyncBlock', function () {
    if (!ENABLE_FRAME_BALANCE_CHECK) {
      this.skip();
      return;
    }
    const { AsyncFrame } = require('../../src/runtime/frame');
    const root = new AsyncFrame(null, false);
    root._runtimeDepth = 0;

    // pushAsyncBlock takes (reads, writeCounters, sequentialLoopBody)
    const child = root.pushAsyncBlock([], {});

    expect(child._runtimeDepth).to.be(1);
  });
  describe('ReadVars Consistency Validation', function () {
    it('should fail when a non-local declared variable is read but not registered in readVars', function () {
      if (!ENABLE_READVARS_VALIDATION) {
        this.skip();
        return;
      }

      const { AsyncFrame } = require('../../src/runtime/frame');
      const prevCompilerContext = AsyncFrame.inCompilerContext;
      AsyncFrame.inCompilerContext = true;

      try {
        const root = new AsyncFrame(null, false, true);
        root.declaredVars = new Set(['count']);

        const child = root.push(false, false);

        const compiler = {
          asyncMode: true,
          _isDeclared(f, name) {
            while (f) {
              if (f.declaredVars && f.declaredVars.has(name)) {
                return true;
              }
              f = f.parent;
            }
            return false;
          },
          fail(msg) {
            throw new Error(msg);
          }
        };

        const node = { lineno: 9, colno: 2 };
        trackActualRead(child, 'count', compiler, node);

        expect(() => {
          validateReadVarsConsistency(child, compiler, node);
        }).to.throwException(/not registered in readVars/);
      } finally {
        AsyncFrame.inCompilerContext = prevCompilerContext;
      }
    });

    it('should allow pass-through readVars without flagging unused snapshots', function () {
      if (!ENABLE_READVARS_VALIDATION) {
        this.skip();
        return;
      }

      const { AsyncFrame } = require('../../src/runtime/frame');
      const prevCompilerContext = AsyncFrame.inCompilerContext;
      AsyncFrame.inCompilerContext = true;

      try {
        const root = new AsyncFrame(null, false, true);
        root.declaredVars = new Set(['count']);

        const mid = root.push(false, false);
        mid.readVars = new Set(['count']);
        markReadVarPassThrough(mid, 'count');

        const compiler = {
          asyncMode: true,
          _isDeclared(f, name) {
            while (f) {
              if (f.declaredVars && f.declaredVars.has(name)) {
                return true;
              }
              f = f.parent;
            }
            return false;
          },
          fail(msg) {
            throw new Error(msg);
          }
        };

        const node = { lineno: 3, colno: 1 };
        validateReadVarsConsistency(mid, compiler, node);

        expect(compiler._validationWarnings || []).to.have.length(0);
      } finally {
        AsyncFrame.inCompilerContext = prevCompilerContext;
      }
    });
  });
});
