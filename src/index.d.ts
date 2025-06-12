export type TemplateCallback<T> = (err: lib.TemplateError | null, res: T | null) => void;
export type Callback<E, T> = (err: E | null, res: T | null) => void;

/** @deprecated Use renderTemplate instead */
export function render(name: string, context?: object): string;

/** @deprecated Use renderTemplate instead */
export function render(name: string, context?: object, callback?: TemplateCallback<string>): void;

/** @deprecated Use renderTemplateAsync instead */
export function renderAsync(name: string, context?: object): Promise<string>;

export function renderTemplate(name: string, context?: object): string;
export function renderTemplate(name: string, context?: object, callback?: TemplateCallback<string>): void;
export function renderTemplateAsync(name: string, context?: object): Promise<string>;

/** @deprecated Use renderTemplateString instead */
export function renderString(src: string, context?: object): string;

/** @deprecated Use renderTemplateString instead */
export function renderString(src: string, context?: object, callback?: TemplateCallback<string>): void;

export function renderTemplateString(src: string, context?: object): string;
export function renderTemplateStringAsync(src: string, context?: object): Promise<string>;

export function renderScriptString(src: string, context?: object): Record<string, any> | string | null;
export function renderScriptStringAsync(src: string, context?: object): Promise<Record<string, any> | string | null>;

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
export function compileScript(src: string, env?: Environment, path?: string, eagerCompile?: boolean): Script;
export function compileScriptAsync(src: string, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean): AsyncScript;
export function precompileTemplate(path: string, opts?: PrecompileOptions): string;
export function precompileTemplateString(src: string, opts?: PrecompileOptions): string;

export function precompileScript(path: string, opts?: PrecompileOptions): string;
export function precompileScriptString(src: string, opts?: PrecompileOptions): string;

//@todo - does this realy return a promise?
export function precompileTemplateAsync(path: string, opts?: PrecompileOptionsAsync): Promise<string>;
export function precompileScriptAsync(path: string, opts?: PrecompileOptionsAsync): Promise<string>;
export function precompileTemplateStringAsync(src: string, opts?: PrecompileOptionsAsync): Promise<string>;
export function precompileScriptStringAsync(src: string, opts?: PrecompileOptionsAsync): Promise<string>;

export interface PrecompileOptionsBase {
  name?: string | undefined;
  asFunction?: boolean | undefined;
  force?: boolean | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  wrapper?(templates: { name: string; template: string }, opts: PrecompileOptions): string;
}

export interface PrecompileOptions extends PrecompileOptionsBase {
  env?: Environment | undefined;
}

export interface PrecompileOptionsAsync extends PrecompileOptionsBase {
  env?: AsyncEnvironment | undefined;
}

export class Script {
  constructor(src: string, env?: Environment, path?: string, eagerCompile?: boolean);
  render(context?: object): Record<string, any> | string | null;
  render(context?: object, callback?: TemplateCallback<Record<string, any> | string | null>): void;
}

export class Template {
  constructor(src: string, env?: Environment, path?: string, eagerCompile?: boolean);
  render(context?: object): string;
  render(context?: object, callback?: TemplateCallback<string>): void;
}

export class AsyncScript {
  constructor(src: string, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean);
  render(context?: object): Promise<Record<string, any> | string | null>;
}

export class AsyncTemplate {
  constructor(src: string, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean);
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
};

export class Environment {
  options: {
    autoescape: boolean;
  };

  constructor(loader?: ILoaderAny | ILoaderAny[] | null, opts?: ConfigureOptions);
  /** @deprecated Use renderTemplate instead */
  render(name: string, context?: object): string;

  /** @deprecated Use renderTemplate instead */
  render(name: string, context?: object, callback?: TemplateCallback<string>): void; renderTemplate(name: string, context?: object): string;
  renderTemplate(name: string, context?: object, callback?: TemplateCallback<string>): void;

  /** @deprecated Use renderTemplateString instead */
  renderString(src: string, context?: object, opts?:RenderOptions, callback?: TemplateCallback<string>): string;

  renderTemplateString(src: string, context?: object, opts?:RenderOptions): string;
  renderTemplateString(src: string, context?: object, opts?:RenderOptions, callback?: TemplateCallback<string>): void;

  renderScriptString(src: string, context?: object, opts?:RenderOptions): Record<string, any> | string | null;
  renderScriptString(src: string, context?: object, opts?:RenderOptions, callback?: TemplateCallback<Record<string, any> | string | null>): void;

  addFilter(name: string, func: (...args: any[]) => any, async?: boolean): Environment;
  getFilter(name: string): (...args: any[]) => any;

  addExtension(name: string, ext: Extension): Environment;
  removeExtension(name: string): void;
  getExtension(name: string): Extension;
  hasExtension(name: string): boolean;

  addGlobal(name: string, value: any): Environment;
  getGlobal(name: string): any;

  getTemplate(name: string, eagerCompile?: boolean): Template;
  getTemplate(name: string, eagerCompile?: boolean, callback?: Callback<Error, Template>): void;

  getScript(name: string, eagerCompile?: boolean): Script;
  getScript(name: string, eagerCompile?: boolean, callback?: Callback<Error, Script>): void;

  getScript(name: string, eagerCompile?: boolean): Script;
  getScript(name: string, eagerCompile?: boolean, callback?: Callback<Error, Script>): void;

  express(app: object): void;

  on(
    event: "load",
    fn: (name: string, source: { src: string; path: string; noCache: boolean }, loader: Loader) => void,
  ): void;
}

export class AsyncEnvironment extends Environment {
  constructor(loader?: ILoaderAny | ILoaderAny[] | null, opts?: ConfigureOptions);    /** @deprecated Use renderTemplate instead */

  renderTemplate(name: string, context?: object): Promise<string>;
  renderScript(name: string, context?: object): Promise<string>;

  renderTemplateString(src: string, context?: object, opts?:RenderOptions): Promise<string>;
  renderScriptString(src: string, context?: object, opts?:RenderOptions): Promise<Record<string, any> | string | null>;

  getTemplate(name: string, eagerCompile?: boolean): Promise<AsyncTemplate>;
  getScript(name: string, eagerCompile?: boolean): Promise<AsyncScript>;

  addFilterAsync(name: string, func: (val: any) => Promise<any>): AsyncEnvironment;

  /**
   * Merges a map of custom methods into the built-in data assembly commands.
   * These methods can be called in scripts using the `@` sigil (e.g., `@upsert users { ... }`).
   * @param methods An object where keys are command names and values are the functions to execute.
   * @returns The environment instance for chaining.
   */
  addDataMethods(methods: Record<string, (...args: any[]) => any>): this;

  /**
   * Registers a command handler class that will be instantiated once for each script run.
   * This is the "factory" pattern, providing a clean state for each execution.
   * @param name The name used to invoke the handler in a script (e.g., 'turtle' for `@turtle.forward()`).
   * @param handlerClass The class constructor to be instantiated.
   * @returns The environment instance for chaining.
   */
  addCommandHandlerClass(name: string, handlerClass: new (...args: any[]) => any): this;

  /**
   * Registers a pre-existing object instance as a command handler.
   * This "singleton" instance will be used across all script runs.
   * @param name The name used to invoke the handler in a script.
   * @param handlerInstance The persistent object instance to use.
   * @returns The environment instance for chaining.
   */
  addCommandHandler(name: string, handlerInstance: Record<string, any>): this;

  /**
   * Customizes the top-level keys in the final result object returned by a script.
   * @param opts An options object.
   * @param opts.dataKey The key for the structured data object built by commands like `@put` and `@push`. Defaults to 'data'.
   * @param opts.textKey The key for the string output generated by `@print`. Defaults to 'text'.
   * @returns The environment instance for chaining.
   */
  setResultStructure(opts: { dataKey?: string; textKey?: string; }): this;
}

export interface Extension {
  tags: string[];
  // Parser API is undocumented it is suggested to check the source: https://github.com/mozilla/nunjucks/blob/master/src/parser.js
  parse(parser: any, nodes: any, lexer: any): any;
}

export function installJinjaCompat(): void;

export function reset(): void;

/** A synchronous or an asynchronous loader. */
export type ILoaderAny = ILoader | ILoaderAsync | WebLoader;
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
  getSource: (name: string, callback: Callback<Error, LoaderSource | null>) => void;
}

/** An asynchronous loader returning a Promise. */
export interface ILoaderAsync {
  async: true;
  getSource: (name: string) => Promise<LoaderSource | null>;//@todo, wrap ILoaderAsync
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

export namespace runtime {
  class SafeString {
    constructor(val: string);
    val: string;
    length: number;
    valueOf(): string;
    toString(): string;
  }
}

export namespace lib {
  class TemplateError extends Error {
    constructor(message: string, lineno: number, colno: number);

    name: string; // always 'Template render error'
    message: string;
    stack: string;

    cause?: Error | undefined;
    lineno: number;
    colno: number;
  }
}
