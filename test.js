'use strict';
const assert = require('assert');
const { quotaWindow, quotaProvider } = require('./server');
assert.deepStrictEqual(quotaWindow({ used_percentage: 37, resets_at: 100 }), { usedPercent: 37, remainingPercent: 63, resetAt: 100000 });
assert.strictEqual(quotaWindow({ remaining_percent: 81 }).usedPercent, 19);
const p = quotaProvider('agy', 'agy', { rate_limits: { five_hour: { used_percent: 25 }, weekly: { used: 70 } } }, 1000);
assert.strictEqual(p.five.remainingPercent, 75);
assert.strictEqual(p.weekly.remainingPercent, 30);
console.log('tests passed');
