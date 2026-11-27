"""Hands the browser short-lived AssemblyAI streaming tokens, so the API key never leaves this machine.

    uv run python voicedrive/server.py     # http://localhost:8787/token
"""

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

PORT = 8787
TOKEN_URL = "https://token.assemblyai.com/v1/token"


def token_request_body() -> dict:
    # One token per take; it only has to open the session, so a minute is plenty.
    return {"product": "streaming", "expires_in_seconds": 60}


def mint_token(api_key: str) -> str:
    req = urllib.request.Request(
        TOKEN_URL, data=json.dumps(token_request_body()).encode(), method="POST",
        headers={"Authorization": api_key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)["token"]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/token":
            return self._send(404, {"error": "not found"})
        try:
            self._send(200, {"token": mint_token(os.environ["ASSEMBLYAI_API_KEY"])})
        except (KeyError, urllib.error.URLError, ValueError) as e:
            self._send(502, {"error": f"could not mint a token: {e!r}"})

    def _send(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    load_dotenv(Path(__file__).parent.parent / ".env")
    print(f"token server on http://localhost:{PORT}/token")
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
