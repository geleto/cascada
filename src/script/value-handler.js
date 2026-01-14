/**
 * ValueHandler class captures the value provided in the command.
 * It is designed to handle commands like @value(123) or @value = 123.
 */
class ValueHandler {
  /**
   * Creates a new ValueHandler instance.
   * @param {Object} context - The runtime context.
   * @returns {Function} A callable handler function.
   */
  constructor(context) {
    this.value = undefined;

    // The handler instance is a function that updates the value.
    // This allows syntax like @value(10) to work directly.
    const handler = (val) => {
      this.value = val;
    };

    /**
     * Returns the captured value as the result of this handler.
     * This method is called by the runtime to finalize the output object.
     */
    handler.getReturnValue = () => {
      return this.value;
    };

    return handler;
  }
}

module.exports = ValueHandler;
