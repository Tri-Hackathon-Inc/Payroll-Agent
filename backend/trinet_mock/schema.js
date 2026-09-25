// GraphQL schema and resolvers for the mock TriNet payroll API. The context holds `store`,
// the SQLite-backed store from db.js.
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
    payrun: (_, { id }, { store }) => findRun(store, id),
    payrunHistory: (_, { limit, before }, { store }) => store.listCompletedPayruns({
      limit, beforeDate: before ? findRun(store, before).payDate : null,
    }),
    employeePayHistory: (_, { employeeId }, { store }) => ({
      employee: store.getEmployee(employeeId) || fail(`Employee ${employeeId} was not found.`, 'NOT_FOUND'),
      lines: store.getEmployeeLines(employeeId),
    }),
  },
  Mutation: {
    updatePayLine: (_, { input }, { store }) => updatePayLine(store, input),
    resetPayrollData: (_, __, { store }) => {
      store.reset();
      return true;
    },
  },
};

module.exports = { typeDefs, resolvers };
