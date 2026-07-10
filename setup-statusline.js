'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const useFanout = process.argv.includes('--fanout');
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
const configDir = arg('--config-dir') || path.join(os.homedir(), '.claude');
const cachePath = arg('--cache') || path.join(configDir, 'usage-cache.json');
const settingsPath = path.join(configDir, 'settings.json');
const scriptName = useFanout ? 'statusline-both.js' : 'statusline-usage.js';
const scriptPath = path.join(__dirname, scriptName);

function quote(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"';
}

function backupPathFor(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return filePath + '.bak-' + stamp;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node setup-statusline.js [--fanout] [--config-dir DIR] [--cache FILE]');
  console.log('');
  console.log('--fanout  Use statusline-both.js so this dashboard can coexist with another statusLine command.');
  process.exit(0);
}

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
  } catch (error) {
    console.error('Failed to parse Claude settings: ' + settingsPath);
    process.exit(1);
  }

  try {
    const backupPath = backupPathFor(settingsPath);
    fs.copyFileSync(settingsPath, backupPath);
    console.log('Backed up existing settings to:');
    console.log('  ' + backupPath);
  } catch (error) {
    console.warn('Warning: could not create a backup for settings.json.');
  }
}

const command = quote(process.execPath) + ' ' + quote(scriptPath) + ' --cache ' + quote(cachePath);
settings.statusLine = {
  type: 'command',
  command,
  padding: 0,
};

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log('');
console.log('Claude Code statusLine is now configured:');
console.log('  ' + command);
console.log('');
console.log('Next steps:');
console.log('  1. Restart Claude Code completely.');
console.log('  2. Send one message in Claude Code.');
console.log('  3. Refresh the dashboard.');
if (useFanout) {
  console.log('');
  console.log('Fanout mode is enabled. Edit config.json if you want to forward statusLine JSON to another command.');
}
