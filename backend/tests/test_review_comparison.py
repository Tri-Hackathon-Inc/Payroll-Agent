import unittest
from copy import deepcopy
from agents.anomaly_detection.paycheck import review_comparisons
from tests.test_runtime import fixture
from runtime.payroll import preprocess


class ReviewComparisonTests(unittest.TestCase):
    def setUp(self):
        self.context = fixture()
        self.identity = self.context['current']['lines'][0]['employeeId']

    def detection(self, scoped=True):
        analysis = preprocess(self.context['current'], self.context['history'], self.identity if scoped else None)
        return {'analysis': analysis, 'findings': [{'employeeId': self.identity}]}

    def test_employee_scope_and_flagged_payrun_scope(self):
        for scoped in (True, False):
            result = review_comparisons(self.context, self.detection(scoped))
            self.assertEqual([item['employeeId'] for item in result], [self.identity])

    def test_missing_history_is_not_zero(self):
        self.context['history'] = []
        result = review_comparisons(self.context, self.detection())[0]
        self.assertIsNone(result['previous'])
        self.assertIsNone(result['netChange'])
        self.assertFalse(result['reconciled'])

    def test_exact_net_difference_and_reconciliation(self):
        current = self.context['current']['lines'][0]
        old = deepcopy(current)
        current.update(gross=6346.15, net=4458.40,
                       taxes={'federal': 1015.38, 'state': 330.40, 'socialSecurity': 400, 'medicare': 85.48},
                       deductions={'health': 56.49, 'retirement401k': 0, 'garnishment': 0})
        # This matches the screenshot's net difference, but its components do not add up.
        old.update(net=4742.18)
        for run in self.context['history']:
            run['lines'] = [deepcopy(old)]
        result = review_comparisons(self.context, self.detection())[0]
        self.assertEqual(result['netChange'], -283.78)
        self.assertFalse(result['reconciled'])
        for line in [current, *[run['lines'][0] for run in self.context['history']]]:
            line['net'] = round(line['gross'] - sum(line['taxes'].values()) - sum(line['deductions'].values()), 2)
        self.assertTrue(review_comparisons(self.context, self.detection())[0]['reconciled'])
