# call-latest

Only the latest async call should win.

## Links

- [npm](https://www.npmjs.com/package/call-latest)
- [Documentation](./README.md)

## Install

```bash
npm install call-latest
```

## Quick example (createSmartSearch controller)

```ts
import {
  createFetchSearchAdapter,
  createSmartSearch,
  dispatchCancelSignal,
} from "call-latest";

const runSearch = createFetchSearchAdapter({ endpoint: "/api/search" });

const smart = createSmartSearch(runSearch, {
  enableDelta: true,
  itemId: (x: { id: string }) => x.id,
  onDistributedCancel: (oldCallId) =>
    dispatchCancelSignal("/api/search/cancel", oldCallId),
});

const result = await smart.search("react");
```

See [README.md](./README.md) for full documentation.
