import {register} from 'node:module';
import {URL} from 'node:url';

register(new URL('./dist-source-loader.mjs', import.meta.url));
