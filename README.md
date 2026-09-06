# Payroll Agent

A simple agent builder for creating and managing HR, payroll, and time-off assistants.

## Run with Docker

```bash
docker compose up --build
```

- UI: http://localhost:5173/agents
- API: http://localhost:8000/api/agents/

Stop the application with:

```bash
docker compose down
```

## Development

The frontend is built with React and Vite. The backend uses Django REST Framework and SQLite.
