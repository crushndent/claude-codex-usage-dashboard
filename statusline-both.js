'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OUR_STATUSLINE = path.join(__dirname, 'statusline-usage.js');
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch (error) {
    return {};
  }
}

function runCommand(command, args, input, options) {
  try {
    return spawnSync(command, args, {
      input,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    return null;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  const config = loadConfig();
  const extraCommand = process.env.EXTRA_STATUSLINE_COMMAND
    || config.extraStatuslineCommand
    || '';

  const own = runCommand(process.execPath, [OUR_STATUSLINE], input);

  if (extraCommand.trim()) {
    runCommand(extraCommand, [], input, { shell: true });
  }

  const output = own && own.stdout ? own.stdout.trim() : 'Claude';
  process.stdout.write(output);
});
