'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const cacheArg = process.argv.indexOf('--cache');
const CACHE_PATH = (cacheArg >= 0 && process.argv[cacheArg + 1])
  || process.env.CLAUDE_USAGE_CACHE
  || path.join(os.homedir(), '.claude', 'usage-cache.json');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  let session = {};
  try {
    session = JSON.parse(input) || {};
  } catch (error) {}

  const rateLimits = session.rate_limits || null;
  if (rateLimits) {
    try {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify({
        fetchedAt: Date.now(),
        rate_limits: rateLimits,
      }));
    } catch (error) {}
  }

  let line = 'Claude';
  try {
    const fiveHour = rateLimits && rateLimits.five_hour;
    const sevenDay = rateLimits && rateLimits.seven_day;
    const percent = (value) => (
      typeof value === 'number' ? Math.round(value) + '%' : '--'
    );
    const model = (session.model && (session.model.display_name || session.model.id)) || 'Claude';
    line = (fiveHour || sevenDay)
      ? model + '  5h used ' + percent(fiveHour && fiveHour.used_percentage)
        + ' · 7d used ' + percent(sevenDay && sevenDay.used_percentage)
      : model;
  } catch (error) {}

  process.stdout.write(line);
});
