import {RuntimeFatalError} from '../errors.js';

// TODO(Step 8): Deduplicate with macro keyword/positional argument mapping
// once inherited callables and macros share one runtime argument-frame helper.
function getInvocationArgs(args) {
  const values = Array.isArray(args) ? args.slice() : [];
  const lastValue = values[values.length - 1];
  const kwargs = lastValue?.__hasKeywordArgs === true ? values.pop() : {};
  return { values, kwargs };
}

function createInheritanceCallableArgumentFrame(
  methodData,
  args,
  errorContext
) {
  const argNames = methodData.signature.argNames;
  const invocationArgs = getInvocationArgs(args);
  const values = invocationArgs.values;
  const kwargs = invocationArgs.kwargs;

  if (values.length > argNames.length) {
    throw new RuntimeFatalError(
      `Inherited callable '${methodData.name}' received too many arguments`,
      errorContext
    );
  }

  const argumentFrame = {};
  values.forEach((value, index) => {
    argumentFrame[argNames[index]] = value;
  });
  argNames.forEach((name) => {
    if (
      !Object.prototype.hasOwnProperty.call(argumentFrame, name) &&
      Object.prototype.hasOwnProperty.call(kwargs, name)
    ) {
      argumentFrame[name] = kwargs[name];
    }
  });
  return argumentFrame;
}

export {
  createInheritanceCallableArgumentFrame
};
