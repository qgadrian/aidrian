// The server entry OpenCode loads from this package: its plugin object, `{ id, setup }`. It imports nothing from
// OpenCode's plugin package, whose `define` returns its argument as it is.

import { setup } from './bridge.mjs';

export default { id: 'aidrian', setup };
