'use strict';

// Import all the separated classes
const { BaseEnvironment } = require('./base-environment');
const { Environment } = require('./sync-environment');
const { AsyncEnvironment } = require('./async-environment');
const { Template, AsyncTemplate } = require('./template');
const { Script, AsyncScript } = require('./script');
const { Context } = require('./context');

// Re-export all the classes
module.exports = {
  BaseEnvironment,
  Environment,
  AsyncEnvironment,
  Template,
  AsyncTemplate,
  Script,
  AsyncScript,
  Context
};
