from django.test import SimpleTestCase
from runtime.incident_document import document_details, readable_report


class IncidentDocumentTests(SimpleTestCase):
    def test_report_keeps_amounts_and_images_without_internal_payloads(self):
        items = [
            {'employeeId':'E1','name':'Example Person','kind':'bonus_change','finding':'Bonus changed',
             'snapshot':{'metric':'bonus','baseline':0,'current':54545,'delta':54545,'unit':'USD','historyCount':3},
             'screenshots':[{'label':'Pay row','path':'snapshots/001.jpg'}]},
            {'employeeId':'E1','name':'Example Person','kind':'bonus outlier','finding':'Bonus 54545 versus historical range 0-0.',
             'snapshot':{},'screenshots':[{'label':'Pay row','path':'snapshots/001.jpg'}]},
            {'employeeId':None,'name':'Decision model','kind':'decision_model','finding':'Model requests review',
             'snapshot':{'confidence':0.97},'screenshots':[]},
        ]
        details = document_details(items,'payrun')
        report = readable_report({**details,'payrunId':'PR-1','evidence':items},conclusion='Verify approved bonus.\nSource: private-hash')
        self.assertIn('# Unexpected payroll bonus',report)
        self.assertIn('54,545.00 USD',report)
        self.assertIn('Example Person',report)
        self.assertIn('Verify approved bonus.',report)
        self.assertEqual(report.count('snapshots/001.jpg'),1)
        self.assertEqual(report.count('Confirm the bonus amount'),1)
        for unwanted in ('confidence','historyCount','private-hash','None Decision','Potential amount at risk','EV-','historical range'):
            self.assertNotIn(unwanted,report)
        self.assertEqual(items[2]['snapshot']['confidence'],0.97)

    def test_non_numeric_findings_and_missing_values_remain_visible(self):
        items = [{'employeeId':None,'name':'Whole payrun','kind':'duplicate','finding':'Possible duplicate payment',
                  'snapshot':{},'screenshots':[]}]
        report = readable_report({**document_details(items,'payrun'),'payrunId':'PR-1','evidence':items})
        self.assertIn('Possible duplicate payment',report)
        self.assertIn('No evidence snapshots were captured',report)
        self.assertNotIn('| Previous baseline |',report)
