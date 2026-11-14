// Preloaded by `npm test` (node --test --require). Sends console.log / info / debug to stderr.
//
// Why: `node --test` runs each test file in a child process and reads that child's stdout as a
// stream of binary messages. Plain text that lands in the same pipe read right after a message is
// mistaken for the next message's 4-byte length (Node 22 and 24, FileTest#processRawBuffer). Our
// server logs start with an emoji ("🔄 Checking for offline data…", "📦 order_profiles: …"), whose
// UTF-8 bytes read as a negative length, so the runner tries to decode the text and the whole file
// fails with "Unable to deserialize cloned data due to invalid or unsupported version". Whether the
// text shares a read with a message depends on pipe timing, so it showed up on Linux CI only.
// stderr is passed through untouched, so logs stay visible and stdout carries only test messages.
const toStderr = (...args) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
