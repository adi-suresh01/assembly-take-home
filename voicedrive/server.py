"""Keeps the AssemblyAI key on this machine: hands the browser short-lived streaming tokens, and
forwards each finished turn to AssemblyAI's LLM Gateway to turn it into a car command.

    uv run python voicedrive/server.py     # http://localhost:8787
"""

import json
import wave
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

PORT = 8787
TOKEN_URL = "https://token.assemblyai.com/v1/token"
LLM_URL = "https://llm-gateway.assemblyai.com/v1/chat/completions"
CLIPS = Path(__file__).parent / "clips"  # dev only: audio of each held turn, for offline tuning


def token_request_body() -> dict:
    # One token per take; it only has to open the session, so a minute is plenty.
    return {"product": "streaming", "expires_in_seconds": 60}


def mint_token(api_key: str) -> str:
    req = urllib.request.Request(
        TOKEN_URL, data=json.dumps(token_request_body()).encode(), method="POST",
        headers={"Authorization": api_key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)["token"]


def command_request_body(model: str, prompt: str) -> dict:
    return {"model": model, "max_tokens": 200, "messages": [{"role": "user", "content": prompt}]}


def run_command(api_key: str, model: str, prompt: str) -> str:
    req = urllib.request.Request(
        LLM_URL, data=json.dumps(command_request_body(model, prompt)).encode(), method="POST",
        headers={"Authorization": api_key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)["choices"][0]["message"]["content"]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/token":
            return self._send(404, {"error": "not found"})
        try:
            self._send(200, {"token": mint_token(os.environ["ASSEMBLYAI_API_KEY"])})
        except (KeyError, urllib.error.URLError, ValueError) as e:
            self._send(502, {"error": f"could not mint a token: {e!r}"})

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/command":
            try:
                req = json.loads(data)
                content = run_command(os.environ["ASSEMBLYAI_API_KEY"], req["model"], req["prompt"])
                return self._send(200, {"content": content})
            except urllib.error.HTTPError as e:
                return self._send(502, {"error": f"LLM Gateway {e.code}: {e.read()[:300].decode(errors='replace')}"})
            except (KeyError, ValueError, urllib.error.URLError) as e:
                return self._send(502, {"error": f"could not run the command: {e!r}"})
        if self.path.startswith("/clip?name="):
            CLIPS.mkdir(exist_ok=True)
            name = "".join(c for c in self.path.split("=", 1)[1] if c.isalnum() or c in "-_")[:40]
            with wave.open(str(CLIPS / f"{name}.wav"), "wb") as w:
                w.setnchannels(1), w.setsampwidth(2), w.setframerate(16000), w.writeframes(data)
            return self._send(200, {"saved": name})
        self._send(404, {"error": "not found"})

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
