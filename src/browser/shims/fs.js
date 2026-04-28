const fs = {
  existsSync() {
    return false;
  },

  readFileSync() {
    throw new Error('fs.readFileSync is not available in browser ESM');
  },

  statSync() {
    throw new Error('fs.statSync is not available in browser ESM');
  },

  readdirSync() {
    return [];
  }
};

export default fs;
