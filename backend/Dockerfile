FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock

COPY . .

# gRPC runtime selected by the local and temporary test Compose stacks.
FROM base AS api-test
EXPOSE 50051
ENTRYPOINT ["sh", "/app/docker-entrypoint.test.sh"]
CMD ["python", "manage.py", "rungrpc", "--address", "0.0.0.0:50051", "--insecure-for-testing"]

FROM base AS validate
CMD ["python", "manage.py", "validate_templates"]
