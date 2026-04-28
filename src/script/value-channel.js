/**
 * ValueChannelTarget captures the value provided in the command.
 * It is designed to handle commands like value(123) or value = 123.
 */
class ValueChannelTarget {
  /**
   * Creates a new ValueChannelTarget instance.
   * @param {Object} context - The runtime context.
   * @returns {Function} A callable channel function.
   */
  constructor(context) {
    this.value = undefined;
    void context;

    // The channel instance is a function that updates the value.
    // This allows syntax like value(10) to work directly.
    const channel = (val) => {
      this.value = val;
    };

    /**
     * Returns the captured value as the result of this channel.
     * This method is called by the runtime to finalize the channel value.
     */
    channel.getReturnValue = () => this.value;

    return channel;
  }
}

export {ValueChannelTarget};
