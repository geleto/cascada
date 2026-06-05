import {createPoison, poisonIfNaN, PoisonError} from './errors.js';
import {isArray, isObject, isString} from '../lib.js';

function inOperator(key, val, errorContext) {
  if (isArray(val) || isString(val)) {
    return val.indexOf(key) !== -1;
  }
  if (isObject(val)) {
    return key in val;
  }
  // No errorContext means the sync legacy compiler path; keep that path fatal.
  if (!errorContext) {
    throw new Error(`Cannot use "in" operator to search for "${key}" in unexpected types.`);
  }
  return createPoison(PoisonError.create(
    `Cannot use "in" operator to search in non-collection value ${formatOperand(val)}`,
    errorContext,
    'NotIterable'
  ));
}

function scriptArithmeticOperator(left, right, operator, errorContext) {
  if (!isArithmeticOperator(operator)) {
    throw new Error(`Unsupported script arithmetic operator '${operator}'`);
  }
  if (operator === '+' && isStringPair(left, right)) {
    return left + right;
  }
  if (!isNumericPair(left, right)) {
    return incompatibleOperands(operator, left, right, errorContext);
  }
  if (isBigIntDivideByZero(right, operator)) {
    return createPoison(PoisonError.create(
      `Operator '${operator}' cannot divide bigint by zero`,
      errorContext,
      'DivideByZero'
    ));
  }

  try {
    return poisonIfNaN(applyArithmetic(left, right, operator), errorContext);
  } catch (err) {
    return createPoison(PoisonError.wrap(err, errorContext, 'IncompatibleOperands'));
  }
}

function scriptComparisonOperator(left, right, operator, errorContext) {
  if (!isComparablePair(left, right)) {
    return incompatibleOperands(operator, left, right, errorContext);
  }

  switch (operator) {
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    default:
      throw new Error(`Unsupported script comparison operator '${operator}'`);
  }
}

function scriptCompareOperator(left, right, operator, errorContext) {
  switch (operator) {
    case '==':
    case '===':
      return left === right;
    case '!=':
    case '!==':
      return left !== right;
    case '<':
    case '>':
    case '<=':
    case '>=':
      return scriptComparisonOperator(left, right, operator, errorContext);
    default:
      throw new Error(`Unsupported script comparison operator '${operator}'`);
  }
}

function scriptConcatOperator(left, right, errorContext) {
  if (!isTextLikeOperand(left) || !isTextLikeOperand(right)) {
    return incompatibleOperands('~', left, right, errorContext);
  }
  return `${left}${right}`;
}

function isNumericPair(left, right) {
  const leftType = typeof left;
  const rightType = typeof right;
  return (leftType === 'number' && rightType === 'number') ||
    (leftType === 'bigint' && rightType === 'bigint');
}

function isStringPair(left, right) {
  return typeof left === 'string' && typeof right === 'string';
}

function isComparablePair(left, right) {
  const leftType = typeof left;
  const rightType = typeof right;
  return isNumericPair(left, right) ||
    (leftType === 'string' && rightType === 'string');
}

function isTextLikeOperand(value) {
  const type = typeof value;
  if (value === null || value === undefined) {
    return true;
  }
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return true;
  }
  if (type === 'object') {
    return value.toString && value.toString !== Object.prototype.toString;
  }
  return false;
}

function applyArithmetic(left, right, operator) {
  switch (operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return left / right;
    case '//':
      return typeof left === 'bigint' ? left / right : Math.floor(left / right);
    case '%':
      return left % right;
    case '**':
      return left ** right;
  }
}

function isArithmeticOperator(operator) {
  return operator === '+' ||
    operator === '-' ||
    operator === '*' ||
    operator === '/' ||
    operator === '//' ||
    operator === '%' ||
    operator === '**';
}

function isBigIntDivideByZero(right, operator) {
  return typeof right === 'bigint' &&
    right === 0n &&
    (operator === '/' || operator === '//' || operator === '%');
}

function incompatibleOperands(operator, left, right, errorContext) {
  return createPoison(PoisonError.create(
    `Operator '${operator}' cannot be applied to ${formatOperand(left)} and ${formatOperand(right)}`,
    errorContext,
    'IncompatibleOperands'
  ));
}

function formatOperand(value) {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  const type = typeof value;
  if (type === 'string') {
    return `"${value}"`;
  }
  if (type === 'symbol') {
    return String(value);
  }
  return `${type} ${String(value)}`;
}

export {
  inOperator,
  scriptArithmeticOperator,
  scriptCompareOperator,
  scriptComparisonOperator,
  scriptConcatOperator
};
