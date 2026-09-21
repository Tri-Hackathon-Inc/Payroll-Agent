from django.db import models

# Create your models here.


class AgentBuilder(models.Model):
    name=models.CharField(max_length=255)
    domain=models.CharField(max_length=255)
    description=models.TextField()
    Instructions=models.TextField()
    model=models.CharField(max_length=255, blank=True, default='')


class AgentBuilderHelperQuestion(models.Model):
    agent_builder=models.ForeignKey(
        AgentBuilder,
        on_delete=models.CASCADE,
        related_name='helper_questions',
    )
    question=models.TextField()
