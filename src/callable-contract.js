'use strict';

const lib = require('./lib');

function formatCallableContract(name, contract) {
  const args = (contract && contract.inputNames ? contract.inputNames : []).join(', ');
  const contextSuffix = contract && contract.withContext ? ' with context' : '';
  return `${name}(${args})${contextSuffix}`;
}

function validateCallableContractCompatibility(kind, name, overridingContract, parentContract) {
  if (!overridingContract || !parentContract) {
    return;
  }

  const overridingNames = overridingContract.inputNames || [];
  const parentNames = parentContract.inputNames || [];
  const sameLength = overridingNames.length === parentNames.length;
  const sameNames = sameLength && overridingNames.every((value, index) => value === parentNames[index]);
  const sameContextMode = !!overridingContract.withContext === !!parentContract.withContext;
  if (sameNames && sameContextMode) {
    return;
  }

  throw new lib.TemplateError(
    `${kind} "${name}" signature mismatch: overriding ${kind} declares ${formatCallableContract(name, overridingContract)} but parent declares ${formatCallableContract(name, parentContract)}`
  );
}

module.exports = {
  validateCallableContractCompatibility
};
