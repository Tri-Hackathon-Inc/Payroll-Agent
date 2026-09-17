from rest_framework.test import APITestCase


class AgentBuilderApiTests(APITestCase):
    def test_create_and_list_agents(self):
        payload = {
            'name': 'Payroll Helper',
            'domain': 'Payroll',
            'description': 'Answers payroll questions.',
            'instructions': 'Be concise and accurate.',
            'questions': ['When is payday?'],
        }

        create_response = self.client.post('/api/agents/save/', payload, format='json')
        self.assertEqual(create_response.status_code, 201)
        self.assertEqual(create_response.data['questions'], ['When is payday?'])

        list_response = self.client.get('/api/agents/')
        self.assertEqual(list_response.status_code, 200)
        self.assertEqual(len(list_response.data), 1)
        self.assertEqual(list_response.data[0]['name'], 'Payroll Helper')

    def test_update_agent(self):
        created = self.client.post('/api/agents/save/', {
            'name': 'HR Helper', 'domain': 'HR', 'description': 'Old description',
            'instructions': 'Old instructions', 'questions': [],
        }, format='json').data
        created.update({'description': 'Updated description', 'questions': ['New question']})

        response = self.client.post('/api/agents/save/', created, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['description'], 'Updated description')
        self.assertEqual(response.data['questions'], ['New question'])
