const enabled = process.env.NO_COLOR !== '1' && process.env.NO_COLOR !== 'true';

function color(code, message) {
  return enabled ? `\u001b[${code}m${message}\u001b[39m` : message;
}

const colors = {
  blue: (message) => color(34, message),
  cyan: (message) => color(36, message),
  dim(message) {
    return enabled ? `\u001b[2m${message}\u001b[22m` : message;
  },
  green: (message) => color(32, message),
  red: (message) => color(31, message),
  yellow: (message) => color(33, message)
};

export {colors};
