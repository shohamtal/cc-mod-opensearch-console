#!/usr/bin/env python3
"""A tiny fake OpenSearch for demos and screenshots: made-up data, localhost only.

    python3 demo/mock_opensearch.py            # serves http://127.0.0.1:9200
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

INDICES = ["products", "products-2026.10", "products-2026.09", "reviews", "reviews-2026.10", "orders", "logs-app-2026.10.19"]
ALIASES = ["products-current", "reviews-current"]

PRODUCTS = [
    {"name": "Trail Runner 3", "brand": "Northpeak", "category": "shoes", "price": 129.0, "rating": 4.6, "tags": ["running", "trail"]},
    {"name": "City Walker", "brand": "Urbano", "category": "shoes", "price": 89.5, "rating": 4.1, "tags": ["casual"]},
    {"name": "Summit Jacket", "brand": "Northpeak", "category": "outerwear", "price": 249.0, "rating": 4.8, "tags": ["waterproof", "hiking"]},
    {"name": "Trail Runner 2", "brand": "Northpeak", "category": "shoes", "price": 99.0, "rating": 4.3, "tags": ["running", "trail"]},
]


def search(body):
    q = json.dumps(body).lower()
    hits = [p for p in PRODUCTS if not any(w in q for w in ("trail", "northpeak")) or "trail" in p["name"].lower() or p["brand"] == "Northpeak"]
    size = body.get("size", 10) if isinstance(body, dict) else 10
    return {
        "took": 7,
        "timed_out": False,
        "_shards": {"total": 3, "successful": 3, "skipped": 0, "failed": 0},
        "hits": {
            "total": {"value": len(hits), "relation": "eq"},
            "max_score": 2.31,
            "hits": [
                {"_index": "products-2026.10", "_id": f"p-{i + 101}", "_score": round(2.31 - i * 0.4, 2), "_source": p}
                for i, p in enumerate(hits[:size])
            ],
        },
        "aggregations": {"by_brand": {"buckets": [{"key": "Northpeak", "doc_count": 3}, {"key": "Urbano", "doc_count": 1}]}},
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload, ctype="application/json"):
        data = payload if isinstance(payload, (bytes, str)) else json.dumps(payload)
        data = data.encode() if isinstance(data, str) else data
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {}
        path = url.path.strip("/")
        if path == "_cluster/health":
            return self._send(200, {"cluster_name": "demo-cluster", "status": "green", "number_of_nodes": 3, "active_shards": 42, "unassigned_shards": 0})
        if path == "_cat/indices":
            if "format=json" in url.query:
                return self._send(200, [{"index": i} for i in INDICES])
            rows = ["health status index                 docs.count store.size"] + [f"green  open   {i:<22}{1000 + 37 * n:>10} {12 + n}mb" for n, i in enumerate(INDICES)]
            return self._send(200, "\n".join(rows) + "\n", "text/plain")
        if path == "_cat/aliases":
            return self._send(200, [{"alias": a} for a in ALIASES])
        if path.endswith("_search") or path.endswith("_count"):
            res = search(body)
            return self._send(200, {"count": res["hits"]["total"]["value"]} if path.endswith("_count") else res)
        if path == "":
            return self._send(200, {"name": "demo-node-1", "cluster_name": "demo-cluster", "version": {"distribution": "opensearch", "number": "2.17.0"}})
        return self._send(404, {"error": {"type": "index_not_found_exception", "reason": f"no such index [{path}]"}, "status": 404})

    do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = handle_any

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9200
    print(f"fake OpenSearch on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
