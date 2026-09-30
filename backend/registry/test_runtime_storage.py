"""Opt-in Redis/pgvector integration; unique test rows, no provider calls."""
import os
from unittest import skipUnless
from uuid import uuid4

from django.test import SimpleTestCase

from .runtime.common import redis_client
from .runtime.retrieval import VectorStore, vector_connection
from .runtime.sessions import with_conversation


class TestEmbeddings:
    dimensions = 384

    def __init__(self):
        self.version = "test-"+uuid4().hex

    def embed(self, texts):
        return [[1.0 if index == (1 if "overtime" in text else 0) else 0.0 for index in range(384)] for text in texts]


@skipUnless(os.getenv("RUN_STORAGE_TESTS") == "1", "Set RUN_STORAGE_TESTS=1 for Redis and pgvector")
class RuntimeStorageTests(SimpleTestCase):
    def test_real_redis_session_cas_and_retry(self):
        client = redis_client()
        options = {"question": "Question", "requestId": uuid4().hex, "context": {"payrunId": "test"}, "scope": {"owner": uuid4().hex}}
        answer = with_conversation(options, lambda _: {"answer": {"reply": "Answer"}}, client)
        try:
            retry = with_conversation({**options, "sessionId": answer["session"]["id"]}, lambda _: self.fail("Retry re-executed"), client)
            self.assertEqual(answer, retry)
        finally:
            client.delete("payroll:session:py:"+answer["session"]["id"])

    def test_real_pgvector_scoping_idempotency_and_trusted_source_content(self):
        embeddings = TestEmbeddings()
        store = VectorStore(embeddings=embeddings)
        identity = uuid4().hex
        docs = [{"id": identity+"-pay", "scope": identity, "text": "pay"}, {"id": identity+"-overtime", "scope": identity, "text": "overtime"}]
        try:
            self.assertEqual(store.index(docs), {"inserted": 2, "existing": 0})
            self.assertEqual(store.index(docs), {"inserted": 0, "existing": 2})
            self.assertEqual(store.search(docs, "overtime", 1)[0]["id"], docs[1]["id"])
            self.assertEqual(store.search(docs[:1], "overtime", 1)[0]["id"], docs[0]["id"])
            trusted = [{**docs[0], "text": "trusted current text"}]
            self.assertEqual(store.search(trusted, "pay")[0]["text"], "trusted current text")
        finally:
            with vector_connection() as conn:
                conn.execute("DELETE FROM payroll_agent_vectors WHERE model=%s", (embeddings.version,))


@skipUnless(os.getenv("RUN_EMBEDDING_TESTS") == "1", "Set RUN_EMBEDDING_TESTS=1 to download/cache local model weights")
class EmbeddingSmokeTests(SimpleTestCase):
    def test_local_minilm_dimensions_and_semantic_matching(self):
        from .runtime.retrieval import LocalEmbeddings
        import math
        vectors = LocalEmbeddings().embed(["Why is my paycheck lower?", "Why did my net pay decrease?", "What is the weather forecast?"])
        self.assertTrue(all(len(vector) == 384 and all(math.isfinite(v) for v in vector) for vector in vectors))
        similarity = lambda a, b: sum(x*y for x, y in zip(a, b))/math.sqrt(sum(x*x for x in a)*sum(y*y for y in b))
        self.assertGreater(similarity(vectors[0], vectors[1]), similarity(vectors[0], vectors[2]))
