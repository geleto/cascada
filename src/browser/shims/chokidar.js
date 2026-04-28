const chokidar = {
  watch() {
    return {
      on() {
        return this;
      }
    };
  }
};

export default chokidar;
