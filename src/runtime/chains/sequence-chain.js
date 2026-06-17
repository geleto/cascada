import {isPoison, PoisonError} from '../errors.js';
import {isObservableCommand} from '../commands/base.js';
import {thenValue} from '../resolve.js';
import {Chain} from './base.js';

class SequenceObjectChain extends Chain {
  constructor(buffer, chainName, context, sequencedObject) {
    super(buffer, chainName, context, 'sequence', undefined, null);
    this._sequencedObject = sequencedObject;
    this._sequencedObjectReady = false;
    this._sequencedObjectReadyPromise = null;
  }

  _resolveSequencedObject() {
    return this._sequencedObject;
  }

  _setSequencedObject(sequencedObject) {
    this._sequencedObject = sequencedObject;
    this._sequencedObjectReady = false;
    this._sequencedObjectReadyPromise = null;
    this._setTarget(undefined);
    return this._sequencedObject;
  }

  setInitialValue(sequencedObject) {
    return this._setSequencedObject(sequencedObject);
  }

  _ensureSequencedObjectResolved() {
    if (this._sequencedObjectReady) {
      return this._sequencedObject;
    }
    if (!this._sequencedObjectReadyPromise) {
      const sequencedObjectValue = this._resolveSequencedObject();
      if (!sequencedObjectValue || typeof sequencedObjectValue.then !== 'function') {
        this._sequencedObject = sequencedObjectValue;
        this._sequencedObjectReady = true;
        return this._sequencedObject;
      }
      this._sequencedObjectReadyPromise = sequencedObjectValue
        .then((resolvedSequencedObject) => {
          this._sequencedObject = resolvedSequencedObject;
          this._sequencedObjectReady = true;
          this._sequencedObjectReadyPromise = null;
          return resolvedSequencedObject;
        });
    }
    return this._sequencedObjectReadyPromise;
  }

  _beforeApplyCommand(cmd) {
    if (isObservableCommand(cmd)) {
      return undefined;
    }
    return this._ensureSequencedObjectResolved();
  }

  _getCurrentResult() {
    return this._sequencedObject;
  }

  _getSequencePoisonError() {
    return isPoison(this._target) ? PoisonError.group(this._target.errors) : null;
  }

  _computeTargetErrorState() {
    return this._getSequencePoisonError();
  }

  _isError() {
    return !!(this._fatalError || this._getSequencePoisonError());
  }

  _getErrors() {
    return this._fatalError || this._getSequencePoisonError();
  }

  _captureGuardState() {
    const sequencedObjectValue = this._ensureSequencedObjectResolved();
    const capture = (sequencedObject) => {
      if (!sequencedObject || typeof sequencedObject.snapshot !== 'function') {
        return undefined;
      }
      return sequencedObject.snapshot();
    };

    return thenValue(sequencedObjectValue, capture);
  }

  _restoreGuardState(state) {
    const sequencedObjectValue = this._ensureSequencedObjectResolved();
    const restore = (sequencedObject, recoveredState) => {
      this._setTarget(undefined);
      if (!sequencedObject || typeof sequencedObject.recover !== 'function') {
        return undefined;
      }
      return sequencedObject.recover(recoveredState);
    };

    const sequencedObjectIsPromise = !!(sequencedObjectValue && typeof sequencedObjectValue.then === 'function');
    const stateIsPromise = !!(state && typeof state.then === 'function');
    if (sequencedObjectIsPromise || stateIsPromise) {
      return restoreGuardStateAsync(sequencedObjectValue, state, restore);
    }
    return restore(sequencedObjectValue, state);
  }
}

async function restoreGuardStateAsync(sequencedObjectValue, state, restore) {
  const sequencedObjectResult = observeValueSettlement(sequencedObjectValue);
  const stateResult = observeValueSettlement(state);
  const results = await Promise.all([sequencedObjectResult, stateResult]);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }
  return restore(results[0].value, results[1].value);
}

function observeValueSettlement(value) {
  if (value && typeof value.then === 'function') {
    return value.then(
      resolved => ({ status: 'fulfilled', value: resolved }),
      reason => ({ status: 'rejected', reason })
    );
  }
  return { status: 'fulfilled', value };
}

class SequenceChain extends SequenceObjectChain {
  constructor(buffer, chainName, context, sequencedObject) {
    super(buffer, chainName, context, sequencedObject);
    this._chainType = 'sequence';
  }

  beginTransaction() {
    const sequencedObjectValue = this._ensureSequencedObjectResolved();
    const begin = (sequencedObject) => {
      if (!sequencedObject || typeof sequencedObject.begin !== 'function') {
        return { active: false, token: undefined };
      }
      const token = sequencedObject.begin();
      if (token && typeof token.then === 'function') {
        return token.then((resolvedToken) => ({ active: true, token: resolvedToken }));
      }
      return { active: true, token };
    };

    return thenValue(sequencedObjectValue, begin);
  }

  commitTransaction(tx) {
    if (!tx || !tx.active) {
      return undefined;
    }

    const sequencedObjectValue = this._ensureSequencedObjectResolved();
    const commit = (sequencedObject) => {
      if (!sequencedObject || typeof sequencedObject.commit !== 'function') {
        return undefined;
      }
      return sequencedObject.commit(tx.token);
    };
    return thenValue(sequencedObjectValue, commit);
  }

  rollbackTransaction(tx) {
    if (!tx || !tx.active) {
      return undefined;
    }

    const sequencedObjectValue = this._ensureSequencedObjectResolved();
    const rollback = (sequencedObject) => {
      if (!sequencedObject || typeof sequencedObject.rollback !== 'function') {
        return undefined;
      }
      return sequencedObject.rollback(tx.token);
    };
    return thenValue(sequencedObjectValue, rollback);
  }
}

export {SequenceObjectChain, SequenceChain};
