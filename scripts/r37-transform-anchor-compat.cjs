'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, 'r37-explicit-handoff-clean-focus.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

// Qualified R36 still carries the R26/R27 frame metadata after displayFrequency.
// Insert R37's epoch after the final R27 field rather than assuming the old R24
// object shape. This preserves every existing diagnostic field.
replaceOnce(
  "  '          displayFrequency\\n        });',\n  `          displayFrequency,\n          r37HandoffEpoch: r34FocusHandoffPending ? r37PendingHandoffEpoch : 0\n        });`,",
  "  '          r27DispatchGapMs\\n        });',\n  `          r27DispatchGapMs,\n          r37HandoffEpoch: r34FocusHandoffPending ? r37PendingHandoffEpoch : 0\n        });`,",
  'R37 qualified-R36 metadata anchor'
);

// R36's builder intentionally stores the exact Windows artifact filename in
// package.json. Keep the same convention so the stable identity/package gate is
// exact rather than relying on electron-builder template expansion.
replaceOnce(
  "pkg.build.win.artifactName = 'LilacAnime-Libmpv-R37-Setup.${ext}';",
  "pkg.build.win.artifactName = 'LilacAnime-Libmpv-R37-Setup.exe';",
  'R37 exact artifact name'
);

fs.writeFileSync(target, source, 'utf8');
console.log('R37_TRANSFORM_ANCHOR_COMPAT_OK metadata=r27-tail+epoch diagnostics=preserved artifact=exact-exe');
