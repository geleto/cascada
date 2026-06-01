export type RenderCallback<T> = (err: CascadaRenderError | Error | null, res: T | null) => void;
export type Callback<E, T> = (err: E | null, res: T | null) => void;

/** @deprecated Use renderTemplate instead */
export function render(name: string, context?: object): string;
/** @deprecated Use renderTemplate instead */
export function render(name: string, callback: RenderCallback<string>): void;
/** @deprecated Use renderTemplate instead */
export function render(name: string, context: object, callback?: RenderCallback<string>): void;

/** @deprecated Use renderTemplateAsync instead */
export function renderAsync(name: string, context?: object): Promise<string>;

export function renderTemplate(name: string, context?: object): string;
export function renderTemplate(name: string, callback: RenderCallback<string>): void;
export function renderTemplate(name: string, context: object, callback?: RenderCallback<string>): void;

/** @deprecated Use renderTemplateString instead */
export function renderString(src: string, context?: object): string;
/** @deprecated Use renderTemplateString instead */
export function renderString(src: string, callback: RenderCallback<string>): void;
/** @deprecated Use renderTemplateString instead */
export function renderString(src: string, context: object, callback?: RenderCallback<string>): void;

export function renderTemplateString(src: string, context?: object): string;
export function renderTemplateString(src: string, callback: RenderCallback<string>): void;
export function renderTemplateString(src: string, context: object, callback?: RenderCallback<string>): void;
export function renderTemplateStringAsync(src: string, context?: object): Promise<string>;
export function renderScriptString(src: string, context?: object): Promise<Record<string, any> | string | null>;

export function loadString(key: string, loader: ILoaderAny | ILoaderAny[]): Promise<string> | string;
export function clearStringCache(loader: ILoaderAny, key?: string): void;
export function raceLoaders(loaders: ILoaderAny[]): ILoaderAsync;

/** @deprecated Use compileTemplate instead */
export function compile(src: string, env?: Environment, path?: string, eagerCompile?: boolean): Template;

/** @deprecated Use compileTemplateAsync instead */
export function compileAsync(src: string, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean): AsyncTemplate;

/** @deprecated Use precompileTemplate instead */
export function precompile(path: string, opts?: PrecompileOptions): string;

/** @deprecated Use precompileTemplateString instead */
export function precompileString(src: string, opts?: PrecompileOptions): string;

export function compileTemplate(src: string, env?: Environment, path?: string, eagerCompile?: boolean): Template;
export function compileTemplateAsync(src: string, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean): AsyncTemplate;
export function compileScript(src: string, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean): Script;
export function precompileTemplate(path: string, opts?: PrecompileOptions): string;
export function precompileTemplateString(src: string, opts?: PrecompileOptions): string;

export function precompileTemplateAsync(path: string, opts?: PrecompileOptionsAsync): string;
export function precompileScript(path: string, opts?: PrecompileOptionsAsync): string;
export function precompileTemplateStringAsync(src: string, opts?: PrecompileOptionsAsync): string;
export function precompileScriptString(src: string, opts?: PrecompileOptionsAsync): string;
export function precompileEsm(templates: Array<{ name: string; template: string }>): string;

export interface PrecompileOptionsBase {
  name?: string | undefined;
  asFunction?: boolean | undefined;
  force?: boolean | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  format?: 'global' | 'esm' | undefined;
  wrapper?(templates: { name: string; template: string }, opts: PrecompileOptions): string;
}

export interface PrecompileOptions extends PrecompileOptionsBase {
  env?: Environment | undefined;
}

export interface PrecompileOptionsAsync extends PrecompileOptionsBase {
  env?: AsyncEnvironment | undefined;
}

export class Template {
  constructor(src: string, env?: Environment, path?: string, eagerCompile?: boolean);
  compileSource(): string;
  render(context?: object): string;
  render(callback: RenderCallback<string>): void;
  render(context: object, callback?: RenderCallback<string>): void;
}

export class Script {
  constructor(src: string, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean);
  compileSource(): string;
  render(context?: object): Promise<Record<string, any> | string | null>;
}

export class AsyncTemplate {
  constructor(src: string, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean);
  compileSource(): string;
  render(context?: object): Promise<string>;
}

interface ConfigureOptions {
  autoescape?: boolean | undefined;
  throwOnUndefined?: boolean | undefined;
  trimBlocks?: boolean | undefined;
  lstripBlocks?: boolean | undefined;
  watch?: boolean | undefined;
  noCache?: boolean | undefined;
  dev?: boolean | undefined;
  web?:
  | {
    useCache?: boolean | undefined;
    async?: boolean | undefined;
  }
  | undefined;
  express?: object | undefined;
  tags?:
  | {
    blockStart?: string | undefined;
    blockEnd?: string | undefined;
    variableStart?: string | undefined;
    variableEnd?: string | undefined;
    commentStart?: string | undefined;
    commentEnd?: string | undefined;
  }
  | undefined;
}

interface RenderOptions {
  path?: string | undefined;
}

export class Environment {
  options: {
    autoescape: boolean;
  };

  constructor(loader?: ILoaderAny | ILoaderAny[] | null, opts?: ConfigureOptions);
  /** @deprecated Use renderTemplate instead */
  render(name: string, context?: object): string;
  /** @deprecated Use renderTemplate instead */
  render(name: string, callback: RenderCallback<string>): void;
  /** @deprecated Use renderTemplate instead */
  render(name: string, context: object, callback?: RenderCallback<string>): void;

  renderTemplate(name: string, context?: object): string;
  renderTemplate(name: string, callback: RenderCallback<string>): void;
  renderTemplate(name: string, context: object, callback?: RenderCallback<string>): void;

  /** @deprecated Use renderTemplateString instead */
  renderString(src: string, context?: object, opts?: RenderOptions): string;
  /** @deprecated Use renderTemplateString instead */
  renderString(src: string, callback: RenderCallback<string>): void;
  /** @deprecated Use renderTemplateString instead */
  renderString(src: string, context: object, callback: RenderCallback<string>): void;
  /** @deprecated Use renderTemplateString instead */
  renderString(src: string, context: object, opts: RenderOptions, callback: RenderCallback<string>): void;

  renderTemplateString(src: string, context?: object, opts?: RenderOptions): string;
  renderTemplateString(src: string, callback: RenderCallback<string>): void;
  renderTemplateString(src: string, context: object, callback: RenderCallback<string>): void;
  renderTemplateString(src: string, context: object, opts: RenderOptions, callback: RenderCallback<string>): void;

  addFilter(name: string, func: (...args: any[]) => any, async?: boolean): Environment;
  getFilter(name: string): (...args: any[]) => any;

  addExtension(name: string, ext: Extension): Environment;
  removeExtension(name: string): void;
  getExtension(name: string): Extension;
  hasExtension(name: string): boolean;

  addGlobal(name: string, value: any): Environment;
  getGlobal(name: string): any;

  getTemplate(name: string, eagerCompile?: boolean): Template;
  getTemplate(name: string, eagerCompile: boolean, callback: Callback<Error, Template>): void;
  getTemplate(name: string, callback: Callback<Error, Template>): void;

  express(app: object): void;
  waterfall(tasks: Function[], callback?: Function, forceAsync?: boolean): void;

  on(
    event: "load",
    fn: (name: string, source: { src: string; path: string; noCache: boolean }, loader: Loader) => void,
  ): void;
}

export class AsyncEnvironment {
  options: {
    autoescape: boolean;
  };

  constructor(loader?: ILoaderAny | ILoaderAny[] | null, opts?: ConfigureOptions);

  renderTemplate(name: string, context?: object): Promise<string>;
  renderScript(name: string, context?: object): Promise<Record<string, any> | string | null>;

  renderTemplateString(src: string, context?: object, opts?: RenderOptions): Promise<string>;
  renderScriptString(src: string, context?: object, opts?: RenderOptions): Promise<Record<string, any> | string | null>;

  getTemplate(name: string, eagerCompile?: boolean): Promise<AsyncTemplate>;
  getScript(name: string, eagerCompile?: boolean): Promise<Script>;

  addFilter(name: string, func: (...args: any[]) => any, async?: boolean): AsyncEnvironment;
  getFilter(name: string): (...args: any[]) => any;

  addExtension(name: string, ext: Extension): AsyncEnvironment;
  removeExtension(name: string): void;
  getExtension(name: string): Extension;
  hasExtension(name: string): boolean;

  addGlobal(name: string, value: any): AsyncEnvironment;
  getGlobal(name: string): any;

  addFilterAsync(name: string, func: (val: any) => Promise<any>): AsyncEnvironment;

  express(app: object): void;
  waterfall(tasks: Function[], callback?: Function, forceAsync?: boolean): void;

  on(
    event: "load",
    fn: (name: string, source: { src: string; path: string; noCache: boolean }, loader: Loader) => void,
  ): void;

  /**
   * Merges a map of custom methods into the built-in data assembly commands.
   * These methods can be called in scripts using the `@` sigil (e.g., `@upsert users { ... }`).
   * @param methods An object where keys are command names and values are the functions to execute.
   * @returns The environment instance for chaining.
   */
  addDataMethods(methods: Record<string, (...args: any[]) => any>): this;

  /**
   * Registers a command chain class that will be instantiated once for each script run.
   * This is the "factory" pattern, providing a clean state for each execution.
   * @param name The name used to invoke the chain in a script (e.g., 'turtle' for `@turtle.forward()`).
   * @param chainClass The class constructor to be instantiated.
   * @returns The environment instance for chaining.
   */
  addCommandChainClass(name: string, chainClass: new (...args: any[]) => any): this;

  /**
   * Registers a pre-existing object instance as a command chain.
   * This "singleton" instance will be used across all script runs.
   * @param name The name used to invoke the chain in a script.
   * @param chainInstance The persistent object instance to use.
   * @returns The environment instance for chaining.
   */
  addCommandChain(name: string, chainInstance: Record<string, any>): this;
}

export interface Extension {
  tags: string[];
  // Parser API is undocumented it is suggested to check the source: https://github.com/mozilla/nunjucks/blob/master/src/parser.js
  parse(parser: any, nodes: any, lexer: any): any;
}

export function installJinjaCompat(): void;

export function reset(): void;

/** Function-based loader that returns Promise<string> | string */
export type LoaderFunction = (name: string) => Promise<string | LoaderSource | null> | string | LoaderSource | null;

/** Class-based loader interface */
export interface LoaderInterface {
  load(name: string): Promise<string | LoaderSource | null> | string | LoaderSource | null;

  // Optional event hooks for cache invalidation and load notifications
  on?(
    event: 'load' | 'update',
    handler: (...args: any[]) => void
  ): void;
  emit?(event: 'load' | 'update', ...args: any[]): void;

  // Optional relative path helpers used by environment loader resolution
  isRelative?(filename: string): boolean;
  resolve?(from: string, to: string): string;
}

/** A synchronous or an asynchronous loader. Supports both legacy and native loader types. */
export type ILoaderAny = ILoader | ILoaderAsync | WebLoader | LoaderFunction | LoaderInterface;
// WebLoader is part of the union because it can be both sync or async depending
// on its constructor arguments, which possibly could only be known on runtime.

/** A synchronous loader. Return null instead of throwing error to handle properly ignoreMissing */
export interface ILoader {
  async?: false | undefined;
  getSource: (name: string) => LoaderSource | null;
}

/** An asynchronous loader. */
export interface ILoaderAsync {
  async: true;
  getSource(name: string, callback: Callback<Error, LoaderSource | null>): void;
  getSource(name: string): Promise<LoaderSource | null>;
}

// Needs both Loader and ILoader since nunjucks uses a custom object system
// Object system is also responsible for the extend methods
export class Loader {
  on(name: string, func: (...args: any[]) => any): void;
  emit(name: string, ...args: any[]): void;
  resolve(from: string, to: string): string;
  isRelative(filename: string): boolean;
  static extend<LoaderClass extends typeof Loader>(this: LoaderClass, toExtend: ILoaderAny): LoaderClass;
}

export interface LoaderSource {
  src: string;
  path: string;
  noCache: boolean;
}

export interface LoaderOptions {
  /** if true, the system will automatically update templates when they are changed on the filesystem */
  watch?: boolean;

  /**  if true, the system will avoid using a cache and templates will be recompiled every single time */
  noCache?: boolean;
}

export type FileSystemLoaderOptions = LoaderOptions;
export type NodeResolveLoaderOptions = LoaderOptions;

export class FileSystemLoader extends Loader implements ILoader {
  constructor(searchPaths?: string | string[], opts?: FileSystemLoaderOptions);
  getSource(name: string): LoaderSource;
}

export class NodeResolveLoader extends Loader implements ILoader {
  constructor(searchPaths?: string | string[], opts?: NodeResolveLoaderOptions);
  getSource(name: string): LoaderSource;
}

export interface WebLoaderOptions {
  useCache?: boolean;
  async?: boolean;
}

export class WebLoader extends Loader {
  constructor(baseUrl?: string, opts?: WebLoaderOptions);
  async: boolean;

  getSource: (name: string, callback: Callback<Error, LoaderSource>) => LoaderSource;
}

export class PrecompiledLoader extends Loader implements ILoader {
  constructor(compiledTemplates?: any[]);
  getSource(name: string): LoaderSource;
}

export class SafeString {
  constructor(val: string);
  val: string;
  length: number;
  valueOf(): string;
  toString(): string;
}

export function markSafe(val: string): SafeString;

export interface CompileErrorOptions {
  lineno?: number | null;
  colno?: number | null;
  label?: string | null;
  path?: string | null;
  cause?: Error | null;
}

export type DiagnosticContext = {
  lineno: number | null;
  colno: number | null;
  label: string | null;
  path: string | null;
};

export class CascadaError extends Error {
  message: string;
  stack: string;
  context: DiagnosticContext | RuntimeDiagnosticContext;
  lineno: number | null;
  colno: number | null;
  path: string | null;
  label: string | null;
}

export class CompileError extends CascadaError {
  constructor(message: string, options?: CompileErrorOptions);

  name: string; // always 'CompileError'
  cause?: Error | undefined;
  context: DiagnosticContext;
  description: string;
  fullMessage: string;
}

export type CompactErrorContext = [
  lineno: number | null,
  colno: number | null,
  label: string | null,
  path: string | null,
  renderState: unknown | null
];

export type RuntimeErrorContext = CompactErrorContext;

export type RuntimeDiagnosticContext = DiagnosticContext & Record<string, unknown>;

export class RuntimeError extends CascadaError {
  constructor(cause: string | Error, context?: RuntimeErrorContext | null);

  static create(message: string | Error | RuntimeError, context?: RuntimeErrorContext | null): RuntimeError;
  static report(message: string | Error | RuntimeError, context?: RuntimeErrorContext | null): RuntimeError;
  static reportAndThrow(message: string | Error | RuntimeError, context?: RuntimeErrorContext | null): never;

  name: string; // always 'RuntimeError'
  cause?: Error | undefined;
  context: RuntimeDiagnosticContext;
  description: string;
  fullMessage: string;
}

export class PoisonError extends CascadaError {
  constructor(cause: unknown, context: RuntimeErrorContext);

  static create(message: string, context: RuntimeErrorContext): CascadaPoisonError;
  static wrap(error: unknown, context: RuntimeErrorContext): CascadaPoisonError;
  /**
   * Returns the original PoisonError for one normalized child, or
   * PoisonErrorGroup when multiple poison errors remain after flattening.
   */
  static group(errors: PoisonError | PoisonError[] | PoisonErrorGroup): CascadaPoisonError;

  errors: PoisonError[];
  cause: Error;
  context: RuntimeDiagnosticContext;
  description: string;
  fullMessage: string;
}

export class PoisonErrorGroup extends PoisonError {
  constructor(errors: PoisonError | PoisonError[]);

  name: string; // always 'PoisonErrorGroup'
  errors: PoisonError[];
}

export type CascadaPoisonError = PoisonError;
export type CascadaRenderError = CompileError | RuntimeError | CascadaPoisonError;

export function isPoisonError(error: unknown): error is CascadaPoisonError;
export function isRuntimeError(error: unknown): error is RuntimeError;
