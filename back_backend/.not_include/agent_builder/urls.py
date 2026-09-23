from django.urls import path

from .views import create_agent_builder, get_agent_builders

urlpatterns = [
    path('agents/', get_agent_builders, name='get-agent-builders'),
    path('agents/save/', create_agent_builder, name='save-agent-builder'),
]
