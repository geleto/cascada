'use strict';

const nodes = require('../nodes');
const { RETURN_CHANNEL_NAME } = require('../inheritance-constants');

class CompileLinkedChannels {
  constructor(compiler) {
    this.compiler = compiler;
  }

  _getAnalysisNode(analysisOrNode) {
    if (!analysisOrNode) {
      return null;
    }
    return analysisOrNode._analysis || analysisOrNode;
  }

  getLinkedChannels(analysisOrNode, options = null) {
    const analysis = this._getAnalysisNode(analysisOrNode);
    if (!analysis) {
      return [];
    }

    const opts = options || {};
    const usedChannels = Array.from(analysis.usedChannels || []);
    const declaredChannels = new Set(
      ((analysis.declaredChannels || new Map()).keys())
    );
    const excludedNames = new Set(opts.excludeNames || []);
    const includeDeclaredChannelNames = new Set(opts.includeDeclaredChannelNames || []);
    const alwaysIncludeNames = new Set(opts.alwaysIncludeNames || []);
    const linkedChannels = new Set(opts.seedChannels || []);

    if (opts.includeDefaultTemplateTextChannel && !this.compiler.scriptMode) {
      linkedChannels.add('__text__');
    }

    usedChannels.forEach((name) => {
      if (!name ||
        name === RETURN_CHANNEL_NAME ||
        excludedNames.has(name)) {
        return;
      }

      if (opts.excludeSequentialChannels && name.indexOf('!') === 0) {
        return;
      }

      if (opts.sharedOnly) {
        const declaration = this.compiler.analysis.findDeclaration(analysis, name);
        if (declaration && declaration.shared) {
          linkedChannels.add(name);
        }
        return;
      }

      if (alwaysIncludeNames.has(name)) {
        linkedChannels.add(name);
        return;
      }

      if (!declaredChannels.has(name) || includeDeclaredChannelNames.has(name)) {
        linkedChannels.add(name);
      }
    });

    return Array.from(linkedChannels);
  }

  getImportedCallableLinkedChannels(funCallNode, importedChannelName = null) {
    const analysis = this._getAnalysisNode(funCallNode);
    if (!analysis) {
      return importedChannelName ? [importedChannelName] : [];
    }

    const boundaryChannelNames = new Set();
    if (importedChannelName) {
      boundaryChannelNames.add(importedChannelName);
    }

    const textChannel = this.compiler.analysis.getCurrentTextChannel(analysis);
    if (textChannel) {
      boundaryChannelNames.add(textChannel);
    }

    const collectUsedChannels = (valueNode) => {
      const valueAnalysis = this._getAnalysisNode(valueNode);
      const usedChannels = valueAnalysis && valueAnalysis.usedChannels;
      if (!usedChannels) {
        return;
      }
      Array.from(usedChannels).forEach((name) => {
        if (!name || name.charAt(0) === '!') {
          return;
        }
        boundaryChannelNames.add(name);
      });
    };

    const topLevelArgs = funCallNode && funCallNode.args && Array.isArray(funCallNode.args.children)
      ? funCallNode.args.children
      : [];
    topLevelArgs.forEach((argNode) => {
      if (argNode instanceof nodes.KeywordArgs) {
        argNode.children.forEach((pairNode) => {
          if (pairNode instanceof nodes.Pair &&
            pairNode.key instanceof nodes.Symbol &&
            pairNode.key.value === 'caller') {
            return;
          }
          collectUsedChannels(pairNode instanceof nodes.Pair ? pairNode.value : pairNode);
        });
        return;
      }
      collectUsedChannels(argNode);
    });

    return Array.from(boundaryChannelNames);
  }
}

module.exports = CompileLinkedChannels;
