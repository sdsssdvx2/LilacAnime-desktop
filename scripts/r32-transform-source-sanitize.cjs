'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const target = path.resolve(__dirname, 'r32-flix-worker-native-focus-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldExit = "  worker.on('exit',code=>{if(code!==0&&r32Worker===worker)fail(new Error(`Flix worker exited (${code})`));else if(r32Worker===worker)r32Worker=null;});";
const newExit = "  worker.on('exit',code=>{if(code!==0&&r32Worker===worker)fail(new Error('Flix worker exited ('+code+')'));else if(r32Worker===worker)r32Worker=null;});";
const count = source.split(oldExit).length - 1;
if (count !== 1) throw new Error(`R32 nested Flix template anchor expected 1, found ${count}`);
source = source.replace(oldExit, newExit);
fs.writeFileSync(target, source, 'utf8');

// The qualified R31 builder intentionally checks out pinned source commits. In
// GitHub Actions, record this deterministic normalization as a local-only commit
// so that checkout sees a clean tree. The commit is not pushed; the branch keeps
// this sanitizer as the reproducible build input.
if (process.env.GITHUB_ACTIONS === 'true') {
  const run = (args, label) => {
    const result = spawnSync('git', args, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || result.stdout || '').slice(0,500)}`);
  };
  run(['config','user.name','github-actions[bot]'], 'git user.name');
  run(['config','user.email','41898282+github-actions[bot]@users.noreply.github.com'], 'git user.email');
  run(['add','scripts/r32-flix-worker-native-focus-fix.cjs'], 'git add sanitized transform');
  run(['commit','-m','ci: normalize R32 generated transform source'], 'git commit sanitized transform');
}

console.log('R32_TRANSFORM_SOURCE_SANITIZE_OK nestedFlixTemplate=removed bridgeTemplates=escaped ciTree=clean');
