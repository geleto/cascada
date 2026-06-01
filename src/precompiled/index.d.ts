export type RenderCallback<T> = (err: CascadaRenderError | Error | null, res: T | null) => void;

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
  render(callback: RenderCallback<string>): void;
  render(context: object, callback?: RenderCallback<string>): void;
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
  render(name: string, callback: RenderCallback<string>): void;
  render(name: string, context: object, callback?: RenderCallback<string>): void;
  renderTemplate(name: string, context?: object): string;
  renderTemplate(name: string, callback: RenderCallback<string>): void;
  renderTemplate(name: string, context: object, callback?: RenderCallback<string>): void;
  getTemplate(name: string, eagerCompile?: boolean, parentName?: string, ignoreMissing?: boolean, cb?: RenderCallback<Template>): Template | void;
  addGlobal(name: string, value: any): this;
  addFilter(name: string, func: Function, async?: boolean): this;
  addTest(name: string, func: Function): this;
  waterfall(tasks: Function[], callback?: Function, forceAsync?: boolean): void;
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
  waterfall(tasks: Function[], callback?: Function, forceAsync?: boolean): void;
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
  name: string;
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
  name: string;
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
  name: string;
  errors: PoisonError[];
}

export type CascadaPoisonError = PoisonError;
export type CascadaRenderError = CompileError | RuntimeError | CascadaPoisonError;

export function isPoisonError(error: unknown): error is CascadaPoisonError;
export function isRuntimeError(error: unknown): error is RuntimeError;
