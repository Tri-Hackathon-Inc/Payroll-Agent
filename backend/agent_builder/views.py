

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework import status

from .models import AgentBuilder, AgentBuilderHelperQuestion

# Create your views here.

@api_view(['POST'])
@transaction.atomic
def create_agent_builder(request):
    data = request.data
    required_fields = ['name', 'domain', 'description', 'instructions']
    missing_fields = [field for field in required_fields if not data.get(field)]
    if missing_fields:
        return Response(
            {'error': f"Missing required fields: {', '.join(missing_fields)}"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    questions = data.get('questions') or []
    if not isinstance(questions, list):
        return Response({'error': 'questions must be a list.'}, status=status.HTTP_400_BAD_REQUEST)

    agent_id = data.get('id')
    agent_builder = get_object_or_404(AgentBuilder, pk=agent_id) if agent_id else AgentBuilder()
    agent_builder.name = data['name'].strip()
    agent_builder.domain = data['domain']
    agent_builder.description = data['description'].strip()
    agent_builder.Instructions = data['instructions'].strip()
    agent_builder.model = str(data.get('model') or '').strip()
    agent_builder.save()

    if agent_id:
        AgentBuilderHelperQuestion.objects.filter(agent_builder=agent_builder).delete()
    AgentBuilderHelperQuestion.objects.bulk_create(
        AgentBuilderHelperQuestion(agent_builder=agent_builder, question=str(question).strip())
        for question in questions if str(question).strip()
    )

    return Response(
        serialize_agent(agent_builder),
        status=status.HTTP_200_OK if agent_id else status.HTTP_201_CREATED,
    )


@api_view(['GET'])
def get_agent_builders(request):
    agent_builders = AgentBuilder.objects.prefetch_related('helper_questions').order_by('-id')
    return Response([serialize_agent(agent) for agent in agent_builders], status=status.HTTP_200_OK)


def serialize_agent(agent):
    return {
        'id': agent.id,
        'name': agent.name,
        'domain': agent.domain,
        'description': agent.description,
        'instructions': agent.Instructions,
        'model': agent.model,
        'questions': [
            item.question
            for item in AgentBuilderHelperQuestion.objects.filter(agent_builder=agent)
        ],
    }
