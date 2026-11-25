// The server entry OpenCode loads from this package: its plugin object, `{ id, setup }`. It imports nothing from
// OpenCode's plugin package, whose `define` returns its argument as it is. Its setup hands the bridge OpenCode's context
// alone, so an argument a later OpenCode adds never reaches the bridge's test seams.

import { setup } from './bridge.mjs';

export default { id: 'aidrian', setup: (context) => setup(context) };
