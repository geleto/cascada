/** A requested resource was absent from every loader in the chain. */
class NotFoundError extends Error {
  constructor(resourceName) {
    super(`Resource not found: ${resourceName}`);
    this.name = 'NotFoundError';
    this.resourceName = resourceName;
  }
}

export {NotFoundError};
