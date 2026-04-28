export function createRequire() {
  return {
    resolve(name) {
      return name;
    }
  };
}
