// @xiaowu/client-core: plain JS shared by Frontend/ (Vite MVP), Web/ (Next.js) and the future
// mobile app. Rules for this package:
//   - no React, no DOM (document, window.open, clipboard) except reading window.location in config.js;
//   - no business rules: it renders, words and formats what the API decided;
//   - relative imports keep their ".js" extension so plain Node can run the tests.
export * from './api.js';
export * from './config.js';
export * from './connection.js';
export * from './csv.js';
export * from './format.js';
export * from './orders.js';
export * from './permissions.js';
export * from './receipt.js';
