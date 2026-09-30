"""Local embeddings and scoped pgvector retrieval; returned text is always current source data."""
import json
import math
import os
import threading
from contextlib import contextmanager

from .common import RuntimeFailure, digest
from .payroll import eligible_history, groups, matching_lines


@contextmanager
def vector_connection():
    import psycopg
    with psycopg.connect(host=os.getenv("VECTOR_DB_HOST", "vector-db"), port=int(os.getenv("VECTOR_DB_PORT", "5432")),
                         dbname=os.getenv("VECTOR_DB_NAME", "payroll_vectors"), user=os.getenv("VECTOR_DB_USER", "payroll_vector"),
                         password=os.getenv("VECTOR_DB_PASSWORD", ""), connect_timeout=5) as connection:
        yield connection


class LocalEmbeddings:
    dimensions = 384
    version = "fastembed:sentence-transformers/all-MiniLM-L6-v2:onnx:v1"
    _model = None
    _lock = threading.Lock()

    def embed(self, texts):
        from fastembed import TextEmbedding
        with self._lock:
            if self.__class__._model is None:
                self.__class__._model = TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2", cache_dir=os.getenv("EMBEDDING_CACHE_DIR", "/app/.cache/embeddings"), threads=2)
            result = [vector.tolist() for vector in self._model.embed(texts, batch_size=32)]
        if len(result) != len(texts) or any(len(v) != self.dimensions or not all(math.isfinite(n) for n in v) for v in result):
            raise RuntimeFailure("Invalid embedding response.")
        return result


class VectorStore:
    def __init__(self, kind="history", embeddings=None, connect=vector_connection):
        self.kind = kind
        self.embeddings = embeddings or LocalEmbeddings()
        self.connect = connect

    def _index(self, conn, documents):
        # A new versioned table permits coexistence with old vectors during upgrades.
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        conn.execute("""CREATE TABLE IF NOT EXISTS payroll_agent_vectors (
                kind text NOT NULL, id text NOT NULL, model text NOT NULL, scope text NOT NULL,
                embedding vector(384) NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY(kind,id,model))""")
        ids = [doc["id"] for doc in documents]
        present = {row[0] for row in conn.execute("SELECT id FROM payroll_agent_vectors WHERE kind=%s AND model=%s AND id=ANY(%s)", (self.kind, self.embeddings.version, ids))}
        missing = list({doc["id"]: doc for doc in documents if doc["id"] not in present}.values())
        inserted = 0
        if missing:
            vectors = self.embeddings.embed([doc["text"] for doc in missing])
            for doc, vector in zip(missing, vectors):
                inserted += conn.execute("INSERT INTO payroll_agent_vectors(kind,id,model,scope,embedding) VALUES(%s,%s,%s,%s,%s::vector) ON CONFLICT DO NOTHING",
                                        (self.kind, doc["id"], self.embeddings.version, doc["scope"], json.dumps(vector))).rowcount
        return {"inserted": inserted, "existing": len(set(ids))-inserted}

    def index(self, documents):
        if not documents:
            return {"inserted": 0, "existing": 0}
        with self.connect() as conn:
            return self._index(conn, documents)

    def search(self, documents, query, k=6):
        if not documents:
            return []
        with self.connect() as conn:
            self._index(conn, documents)
            ids = [doc["id"] for doc in documents]
            vector = json.dumps(self.embeddings.embed([query])[0])
            rows = conn.execute("""SELECT id, embedding <=> %s::vector AS distance FROM payroll_agent_vectors
                WHERE kind=%s AND model=%s AND id=ANY(%s) AND scope=ANY(%s)
                ORDER BY distance, id LIMIT %s""", (vector, self.kind, self.embeddings.version, ids, list({doc["scope"] for doc in documents}), max(1, min(int(k), 20)))).fetchall()
        trusted = {doc["id"]: doc for doc in documents}
        return [{**trusted[identity], "distance": float(distance)} for identity, distance in rows if identity in trusted and math.isfinite(distance)]


def history_documents(context, domain_name, service, employee_ids=None, topics=None):
    current = context["current"]
    scope = digest([domain_name, service, current["company"], current["currency"], current["frequency"]])
    current_groups = groups(current["lines"])
    documents = []
    for run in eligible_history(current, context["history"]):
        for identity, lines in current_groups.items():
            if employee_ids and identity not in employee_ids:
                continue
            previous = matching_lines(run, identity, lines)
            if not previous:
                continue
            for topic in topics or ("earnings", "overtime", "deductions"):
                fields = {"earnings": ("earnings", "gross", "net"), "overtime": ("hours", "earnings"), "deductions": ("deductions", "taxes")}[topic]
                data = [{key: line.get(key) for key in fields} for line in previous]
                text = f"Employee {identity} {previous[0].get('name', '')}; payrun {run['id']}; paid {run['payDate']}; {run['currency']}; {topic}: {json.dumps(data)}"
                documents.append({"id": digest([scope, run["id"], identity, topic, text]), "scope": scope, "text": text,
                                  "payrunId": run["id"], "employeeId": identity, "payDate": run["payDate"], "topic": topic,
                                  "lineIds": [line["lineId"] for line in previous if line.get("lineId")]})
    return documents
