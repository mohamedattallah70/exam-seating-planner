// Starts the gateway and every service that exists, each as its own Node
// process (like separate ECS tasks). Usage: npm run dev
//   npm run dev -- exams halls   -> start only these services (+ gateway)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const only = process.argv.slice(2);
const procs = [
  ['gateway', 'gateway/server.js'],
  ['auth', 'services/auth/index.js'],
  ['halls', 'services/halls/index.js'],
  ['exams', 'services/exams/index.js'],
  ['allocation', 'services/allocation/index.js'],
  ['alloc-worker', 'services/allocation/worker.js'],
].filter(([name, file]) => fs.existsSync(path.join(root, file)) && (only.length === 0 || name === 'gateway' || only.some((o) => name.startsWith(o))));

const colors = [36, 33, 35, 32, 34, 31];
const children = procs.map(([name, file], i) => {
  const child = spawn(process.execPath, ['--watch-path=' + path.dirname(file), '--watch-path=shared', file], { cwd: root, env: process.env });
  const tag = `\x1b[${colors[i % colors.length]}m[${name}]\x1b[0m`;
  const out = (data) => data.toString().split('\n').filter(Boolean).forEach((l) => console.log(tag, l));
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  return child;
});

process.on('SIGINT', () => { children.forEach((c) => c.kill()); process.exit(0); });
console.log(`Started: ${procs.map(([n]) => n).join(', ')}. Gateway: http://localhost:8080/api/health`);
