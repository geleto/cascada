export type TemplateCallback<T> = (err: Error | null, res: T | null) => void;

export class Loader {}

export class PrecompiledLoader extends Loader {
  constructor(compiledTemplates?: Record<string, object>);
}

export interface PrecompiledTemplateSource {
  type: 'code';
  obj: object;
}

export class Template {
  /**
   * Low-level constructor for loader-provided compiled template sources.
   * Prefer `new Environment(new PrecompiledLoader(templates))`.
   */
  constructor(src: PrecompiledTemplateSource, env?: Environment, path?: string, eagerCompile?: boolean);
  render(context?: object): string;
  render(callback: TemplateCallback<string>): void;
  render(context: object, callback?: TemplateCallback<string>): void;
}

export class AsyncTemplate {
  /**
   * Low-level constructor for loader-provided compiled template sources.
   * Prefer `new AsyncEnvironment(new PrecompiledLoader(templates))`.
   */
  constructor(src: PrecompiledTemplateSource, env?: AsyncEnvironment, path?: string, eagerCompile?: boolean);
  render(context?: object): Promise<string>;
}

export class PrecompiledTemplate extends Template {}
export class AsyncPrecompiledTemplate extends AsyncTemplate {}
export class AsyncPrecompiledScript extends AsyncTemplate {
  render(context?: object): Promise<Record<string, any> | string | null>;
}
export class Script extends AsyncPrecompiledScript {}

export class Environment {
  constructor(loaders?: Loader | Loader[], opts?: object);
  render(name: string, context?: object): string;
  render(name: string, callback: TemplateCallback<string>): void;
  render(name: string, context: object, callback?: TemplateCallback<string>): void;
  renderTemplate(name: string, context?: object): string;
  renderTemplate(name: string, callback: TemplateCallback<string>): void;
  renderTemplate(name: string, context: object, callback?: TemplateCallback<string>): void;
  getTemplate(name: string, eagerCompile?: boolean, parentName?: string, ignoreMissing?: boolean, cb?: TemplateCallback<Template>): Template | void;
  addGlobal(name: string, value: any): this;
  addFilter(name: string, func: Function, async?: boolean): this;
  addTest(name: string, func: Function): this;
}

export class AsyncEnvironment {
  constructor(loaders?: Loader | Loader[], opts?: object);
  renderTemplate(name: string, context?: object): Promise<string>;
  renderScript(name: string, context?: object): Promise<Record<string, any> | string | null>;
  getTemplate(name: string | Promise<string>, eagerCompile?: boolean, parentName?: string, ignoreMissing?: boolean): Promise<AsyncTemplate>;
  getScript(name: string | Promise<string>, eagerCompile?: boolean, parentName?: string, ignoreMissing?: boolean): Promise<AsyncPrecompiledScript>;
  addGlobal(name: string, value: any): this;
  addFilter(name: string, func: Function, async?: boolean): this;
  addFilterAsync(name: string, func: Function): this;
  addTest(name: string, func: Function): this;
  addDataMethods(methods: Record<string, Function>): this;
}

export class PrecompiledEnvironment extends Environment {}
export class AsyncPrecompiledEnvironment extends AsyncEnvironment {}

export class SafeString {
  constructor(val: string);
  val: string;
  length: number;
  valueOf(): string;
  toString(): string;
}

export function markSafe(val: string): SafeString;

export class TemplateError extends Error {
  constructor(message: string, lineno: number, colno: number);
  name: string;
  message: string;
  stack: string;
  cause?: Error | undefined;
  lineno: number;
  colno: number;
}
