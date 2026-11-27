"""Keeps the AssemblyAI key on this machine: hands the browser short-lived streaming tokens, and
forwards each finished turn to AssemblyAI's LLM Gateway to turn it into a car command.

    uv run python voicedrive/server.py     # http://localhost:8787

Only the local app may use it: requests must come from localhost (no other site's page, no DNS
rebinding), and /command only runs the demo's models with a demo-sized prompt.
"""

import json
import os
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

PORT = 8787
TOKEN_URL = "https://token.assemblyai.com/v1/token"
LLM_URL = "https://llm-gateway.assemblyai.com/v1/chat/completions"
MODELS = {"gemma-4-31b", "qwen3.5-4b-32k-fast"}
MAX_PROMPT = 6000  # the command prompt is ~3 KB plus one spoken sentence
LOCAL_HOSTS = {"localhost", "127.0.0.1"}
APP_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}
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


def request_problem(headers) -> str | None:
    """Why this request isn't from the local app, or None if it is."""
    host = (headers.get("Host") or "").rsplit(":", 1)[0]
    if host not in LOCAL_HOSTS:
        return "requests must come from localhost"
    origin = headers.get("Origin")
    if origin is not None and origin not in APP_ORIGINS:
        return "requests must come from the VoiceDrive page"
    return None


def command_problem(req: dict) -> str | None:
    """Why this /command body won't be forwarded, or None if it's fine."""
    if req.get("model") not in MODELS:
        return f"model must be one of {sorted(MODELS)}"
    prompt = req.get("prompt")
    if not isinstance(prompt, str) or not 0 < len(prompt) <= MAX_PROMPT:
        return f"prompt must be text of at most {MAX_PROMPT} characters"
    return None


def clips_enabled() -> bool:
    return os.environ.get("VOICEDRIVE_RECORD") == "1"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if problem := request_problem(self.headers):
            return self._send(403, {"error": problem})
        if self.path != "/token":
            return self._send(404, {"error": "not found"})
        try:
            self._send(200, {"token": mint_token(os.environ["ASSEMBLYAI_API_KEY"])})
        except Exception as e:  # always answer, so the page can show what went wrong
            self._send(502, {"error": f"could not mint a token: {e!r}"})

    def do_POST(self):
        if problem := request_problem(self.headers):
            return self._send(403, {"error": problem})
        length = int(self.headers.get("Content-Length", 0))
        if length > 10_000_000:
            return self._send(413, {"error": "too large"})
        data = self.rfile.read(length)
        if self.path == "/command":
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self._send(415, {"error": "send JSON"})
            try:
                req = json.loads(data)
                if problem := command_problem(req):
                    return self._send(400, {"error": problem})
                content = run_command(os.environ["ASSEMBLYAI_API_KEY"], req["model"], req["prompt"])
                return self._send(200, {"content": content})
            except urllib.error.HTTPError as e:
                return self._send(502, {"error": f"LLM Gateway {e.code}: {e.read()[:300].decode(errors='replace')}"})
            except Exception as e:  # timeouts, odd replies: always answer with JSON
                return self._send(502, {"error": f"could not run the command: {e!r}"})
        if self.path.startswith("/clip?name=") and clips_enabled():
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
    print(f"VoiceDrive server on http://localhost:{PORT}")
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
