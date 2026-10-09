// GraphQL schema and resolvers for the mock TriNet payroll API. The context holds `store`,
// the SQLite-backed store from db.js, and optionally `events` (events.js), which is told about
// monitored UI reads and every saved change.
const fs = require('node:fs');
const path = require('node:path');
const { updatePayLine, fail } = require('./payroll');

const typeDefs = fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8');

const findRun = (store, id) => store.getPayrun(id) || fail(`Payrun ${id} was not found.`, 'NOT_FOUND');

const resolvers = {
  PayrunStatus: { PENDING_APPROVAL: 'pending-approval', COMPLETED: 'completed' },
  Payrun: {
    // Lines are only loaded when a query selects them.
    lines: (run, _, { store }) => store.getLines(run.id),
  },
  Query: {
    payruns: (_, { status }, { store }) => store.listPayruns(status),
    payrun: (_, { id, monitor, domainName, checkLineId }, { store, events }) => {
      const run = findRun(store, id);
      if (monitor) {
        if (typeof domainName !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(domainName)) fail('A valid monitoring domain is required.');
        const line = checkLineId == null ? null : store.getLines(id).find(item => item.lineId === checkLineId);
        if (checkLineId != null && !line) fail('The paycheck is not in this payrun.', 'NOT_FOUND');
        events?.notify({ type: line ? 'paycheck.opened' : 'payrun.loaded', domainName, payrunId: run.id,
          version: run.version, ...(line ? { lineId: line.lineId, employeeId: line.employeeId } : {}), changedAt: new Date().toISOString() });
      }
      return run;
    },
    payrunHistory: (_, { limit, before }, { store }) => store.listCompletedPayruns({
      limit, beforeDate: before ? findRun(store, before).payDate : null,
    }),
    employeePayHistory: (_, { employeeId }, { store }) => ({
      employee: store.getEmployee(employeeId) || fail(`Employee ${employeeId} was not found.`, 'NOT_FOUND'),
      lines: store.getEmployeeLines(employeeId),
    }),
  },
  Mutation: {
    updatePayLine: (_, { input }, { store, events }) => {
      const run = updatePayLine(store, input);
      const line = store.getLines(run.id).find(item => item.lineId === input.lineId);
      events?.notify({ type: 'payrun.changed', payrunId: run.id, version: run.version, lineId: input.lineId,
        employeeId: line?.employeeId || null, changedAt: new Date().toISOString() });
      return run;
    },
    resetPayrollData: (_, __, { store }) => {
      store.reset();
      return true;
    },
  },
};

module.exports = { typeDefs, resolvers };
