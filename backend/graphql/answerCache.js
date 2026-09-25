// In-memory cache of model answers, so asking the same question about the same payrun version
// returns the same reply word for word (and spends no tokens). The key covers the agent, its
// model and instructions, the payrun and its version, and the normalized question; editing the
// payrun bumps its version, so stale answers are never served. Per process and lost on restart;
// the shared Redis store can replace it with the same get/set interface.
const { createHash } = require('node:crypto');

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;

function createAnswerCache({ ttlMs = TTL_MS, maxEntries = MAX_ENTRIES, now = Date.now } = {}) {
  const entries = new Map();
  return {
    key(parts) {
      return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (now() - entry.at > ttlMs) { entries.delete(key); return null; }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { at: now(), value });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value); // Oldest first.
    },
  };
}

module.exports = { createAnswerCache };
