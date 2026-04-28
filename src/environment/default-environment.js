
let EnvironmentClass = null;
let AsyncEnvironmentClass = null;

function setDefaultEnvironmentClasses(Environment, AsyncEnvironment) {
  EnvironmentClass = Environment;
  AsyncEnvironmentClass = AsyncEnvironment;
}

function createDefaultEnvironment(asyncMode = false) {
  const EnvClass = asyncMode ? AsyncEnvironmentClass : EnvironmentClass;
  if (!EnvClass) {
    throw new Error('No default environment class has been registered');
  }
  return new EnvClass();
}

export {createDefaultEnvironment, setDefaultEnvironmentClasses};
