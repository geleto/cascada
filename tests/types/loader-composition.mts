import { AsyncEnvironment, Environment, clearStringCache, loadString, raceLoaders } from '../../src/index.js';
import type { LoaderGroup, LoaderInterface, SourceOrigin } from '../../src/index.js';
import { AsyncEnvironment as PrecompiledEnvironment } from '../../src/precompiled/index.js';

const load = (name: string) => name;
const nested: LoaderGroup = [[], [load, [async name => name]]];
const raced: LoaderInterface = raceLoaders([nested, []]);
new Environment([[load], [raced]]);
new AsyncEnvironment([nested, raced]);
new PrecompiledEnvironment([nested, raced]);
void loadString('entry', nested);
clearStringCache(nested);
raceLoaders([[name => { const value: string = name; return value; }]]);
declare const origin: SourceOrigin;
const policy: LoaderGroup = origin.loader;
void policy;

// @ts-expect-error A race takes one array of competitors.
raceLoaders(load);
// @ts-expect-error Recursive chains contain only native loaders or other chains.
raceLoaders([[123]]);
// @ts-expect-error A loader callback receives a string name.
raceLoaders([[(_name: number) => 'source']]);
// @ts-expect-error Loader callbacks resolve to native source values.
new AsyncEnvironment([[async () => false]]);
// @ts-expect-error Named group arguments are not native race settings.
raceLoaders([load], 'name');
