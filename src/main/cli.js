'use strict';
// Command line parsing, kept free of Electron so it can be unit tested.
const path = require('path');

const VALUE_FLAGS = { '--select-left': 'select-left', '--compare-to': 'compare-to', '--compare-selected': 'compare-selected' };
const PLAIN_FLAGS = { '--register-shell': 'register-shell', '--unregister-shell': 'unregister-shell', '--git-setup': 'git-setup' };

// args: the arguments after the executable (and after the app path in
// development). Unknown switches belong to Electron/Chromium and are skipped.
//   <left> [<right>]        open a comparison
//   --wait                  own process that lives until its window closes
//                           (what `git difftool` needs)
//   --select-left <path>    remember the left side (Explorer context menu)
//   --compare-to <path>     compare the remembered left side with this path
//   --compare-selected <p>  one item of an Explorer multi-selection; the items
//                           of one click are gathered and compared
function parseCli(args, cwd) {
  const out = { mode: 'open', paths: [], wait: false, target: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS[a]) {
      out.mode = VALUE_FLAGS[a];
      out.target = args[++i] ? path.resolve(cwd, args[i]) : null;
    } else if (PLAIN_FLAGS[a]) {
      out.mode = PLAIN_FLAGS[a];
    } else if (a === '--wait') {
      out.wait = true;
    } else if (!a.startsWith('-') && out.paths.length < 2) {
      out.paths.push(path.resolve(cwd, a));
    }
  }
  if (Object.values(VALUE_FLAGS).includes(out.mode) && !out.target) out.mode = 'open';
  return out;
}

// The app's own arguments in process.argv: everything after the executable
// and, when unpackaged (`electron [switches] <app> ...`), without the app
// path, which is the first argument that is not a switch — not necessarily
// argv[1], since launchers such as Playwright put switches before it.
function appArgs(argv, packaged) {
  const args = argv.slice(1);
  if (packaged) return args;
  // -r / --require <module> is Electron's one switch with a separate value.
  const i = args.findIndex((a, j) => !a.startsWith('-') && !['-r', '--require'].includes(args[j - 1]));
  return i < 0 ? args : args.slice(0, i).concat(args.slice(i + 1));
}

module.exports = { parseCli, appArgs };
