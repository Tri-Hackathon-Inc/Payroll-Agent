// Privacy: employee names never reach a model. Before a model call, each employee's name is
// replaced with their employee ID in everything sent (payroll context, question, conversation,
// retrieved documents); the reply gets the names back for the reader. Pay figures stay, since the
// model needs them to reason. Set PII_MASKING=false to turn it off (e.g. to compare models).
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// employees: [{ employeeId, name }]. Returns { mask(text), unmask(text), masked } for them.
function createPseudonymizer(employees = [], env = process.env) {
  const people = [...new Map(employees.filter(item => item?.employeeId && item?.name).map(item => [item.employeeId, item])).values()];
  const enabled = env.PII_MASKING !== 'false' && people.length > 0;
  const lastNames = new Map();
  for (const person of people) {
    const last = person.name.trim().split(/\s+/).at(-1);
    lastNames.set(last, lastNames.has(last) ? null : person); // Only last names that identify one person.
  }
  // Longest first: "E1004 Daniel Brooks" -> "E1004", then "Daniel Brooks" -> "E1004", then "Brooks" -> "E1004".
  const rules = people.flatMap(person => [
    [new RegExp(`\\b${escape(person.employeeId)}\\s+${escape(person.name)}\\b`, 'g'), person.employeeId],
    [new RegExp(`\\b${escape(person.name)}\\b`, 'gi'), person.employeeId],
  ]).concat([...lastNames].filter(([, person]) => person)
    .map(([last, person]) => [new RegExp(`\\b${escape(last)}\\b`, 'gi'), person.employeeId]));
  let masked = 0;
  return {
    get masked() { return masked; },
    enabled,
    mask(text) {
      if (!enabled || typeof text !== 'string') return text;
      return rules.reduce((result, [pattern, id]) => result.replace(pattern, () => { masked += 1; return id; }), text);
    },
    // "E1004" -> "E1004 Daniel Brooks" unless the name already follows.
    unmask(text) {
      if (!enabled || typeof text !== 'string') return text;
      return people.reduce((result, person) => result.replace(
        new RegExp(`\\b${escape(person.employeeId)}\\b(?!\\s+${escape(person.name)})`, 'g'), `${person.employeeId} ${person.name}`), text);
    },
  };
}

// For JSON replies (the RAG and anomaly pipelines): restores names in the prose fields only, so
// IDs used as keys (findingId, sourceIds) stay exactly as the postprocessor expects. Text that is
// not JSON is returned unchanged.
const PROSE_FIELDS = new Set(['answer', 'explanation', 'reviewAction']);
function unmaskJsonProse(text, pii) {
  if (!pii.enabled || typeof text !== 'string') return text;
  let value;
  try { value = JSON.parse(text); } catch { return text; }
  const walk = item => {
    if (Array.isArray(item)) return item.map(walk);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key,
      PROSE_FIELDS.has(key) && typeof entry === 'string' ? pii.unmask(entry) : walk(entry)]));
  };
  return JSON.stringify(walk(value));
}

// The employees in a payroll context (current run and history).
function employeesIn(context) {
  const runs = [context?.current || context?.payrun, ...(context?.history || [])].filter(Boolean);
  return runs.flatMap(run => (run.lines || []).map(line => ({ employeeId: line.employeeId, name: line.name })));
}

module.exports = { createPseudonymizer, employeesIn, unmaskJsonProse };
