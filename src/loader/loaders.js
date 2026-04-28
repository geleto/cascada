// This file will automatically be rewired to web-loader.js when
// building for the browser
import {FileSystemLoader, PrecompiledLoader, NodeResolveLoader} from './node-loaders.js';

const WebLoader = undefined;

export default {
  FileSystemLoader,
  PrecompiledLoader,
  NodeResolveLoader,
  WebLoader
};

export {FileSystemLoader, PrecompiledLoader, NodeResolveLoader, WebLoader};
