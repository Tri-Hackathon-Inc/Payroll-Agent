// Outbound payrun.loaded, paycheck.opened, and payrun.changed events are sent
// to PAYROLL_EVENTS_URL (Agent Studio's /events/payroll),
// with PAYROLL_EVENTS_TOKEN as a shared secret when set. Fire and forget: a source request never waits
// for, or fails because of, the receiver.
const TIMEOUT_MS = 3000;

function createEventNotifier({ url = process.env.PAYROLL_EVENTS_URL, token = process.env.PAYROLL_EVENTS_TOKEN, fetchImpl = fetch } = {}) {
  return {
    enabled: Boolean(url),
    notify(event) {
      if (!url) return Promise.resolve(false);
      return fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Payroll-Events-Token': token } : {}) },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(response => response.ok).catch(error => {
        console.warn(`Payroll event not delivered: ${error.message}`);
        return false;
      });
    },
  };
}

module.exports = { createEventNotifier };
