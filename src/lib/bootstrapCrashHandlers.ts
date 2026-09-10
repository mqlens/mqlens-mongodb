import { installCrashHandlers } from './crashLog';

// Installed as a side effect of importing this module, so that main.tsx can
// import it *before* `./App`. ES modules evaluate a module's dependencies, in
// import order, before its own body — so a call placed in main.tsx's body runs
// only after App and its whole dependency graph have already initialized. A
// throw during another module's initialization would then happen before the
// handlers existed, and the resulting startup blank screen would leave no crash
// log (#381 review). Importing this first gets the listeners up before the app
// graph evaluates.
installCrashHandlers();
