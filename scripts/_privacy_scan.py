"""Scan git-tracked files for high-risk secrets before CI or release packing."""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2", ".ico"}

HTTP_BASIC_URL = re.compile(
    r"\bhttps?://(?P<username>[^:/\s@]+):(?P<password>[^/\s@]+)@(?P<host>[^\s/?#:]+)(?::\d{1,5})?(?:[/?#][^\s]*)?",
    re.I,
)

# High-risk patterns (real keys, not placeholders)
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("openai_sk", re.compile(r"\bsk-[a-zA-Z0-9]{20,}\b")),
    ("openai_proj", re.compile(r"\bsk-proj-[a-zA-Z0-9_-]{20,}\b")),
    ("github_pat", re.compile(r"\bghp_[a-zA-Z0-9]{20,}\b")),
    ("github_fine", re.compile(r"\bgithub_pat_[a-zA-Z0-9_]{20,}\b")),
    ("aws_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("private_key", re.compile(r"-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----")),
    ("bearer", re.compile(r"\bBearer [A-Za-z0-9._\-]{24,}\b")),
    ("http_basic_url", HTTP_BASIC_URL),
]

# Placeholder-ish allowed substrings near matches
ALLOW = re.compile(
    r"YOUR_|your_|example|placeholder|<[^>\n]+>|\$\{[^}\n]+\}|process\.env|API_KEY_HERE|xxxx|TODO|changeme|privacy-scan:\s*allow-test-fixture",
    re.I,
)

PLACEHOLDER_PASSWORD = re.compile(
    r"(?:pass(?:word)?(?:\d{0,4})?|passwd|changeme|example(?:[-_ ]?(?:pass(?:word)?|secret|token|key))?|your[-_ ]?(?:pass(?:word)?|secret|token|key)|sample|demo|test|x{3,})",
    re.I,
)


class PrivacyScanSelfTest(unittest.TestCase):
    def test_flags_explicit_http_basic_url(self) -> None:
        text = "remote " + "https://alice:" + "RealSecret_123456@internal.local/repo.git"  # privacy-scan: allow-test-fixture
        hits = find_hits_in_text("docs.txt", text)
        self.assertEqual(1, len(hits))
        self.assertIn("[http_basic_url]", hits[0])
        self.assertNotIn("RealSecret_123456", hits[0])

    def test_ignores_placeholder_http_basic_url(self) -> None:
        text = "remote " + "https://alice:" + "password@example.com/repo.git"
        self.assertEqual([], find_hits_in_text("docs.txt", text))

    def test_ignores_plain_ip_without_credentials(self) -> None:
        self.assertEqual([], find_hits_in_text("notes.txt", "service at http://10.0.0.8:7620/"))

    def test_ignores_private_key_path(self) -> None:
        self.assertEqual([], find_hits_in_text("notes.txt", "/Users/alice/.ssh/id_ed25519"))


def git_files() -> list[Path]:
    out = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    return [ROOT / p.decode() for p in out.split(b"\0") if p]



def line_col(text: str, offset: int) -> tuple[int, int]:
    line = text.count("\n", 0, offset) + 1
    last_newline = text.rfind("\n", 0, offset)
    col = offset + 1 if last_newline == -1 else offset - last_newline
    return line, col



def is_placeholder_http_basic(match: re.Match[str]) -> bool:
    return bool(PLACEHOLDER_PASSWORD.fullmatch(match.group("password")))



def iter_secret_hits(text: str) -> list[tuple[str, int]]:
    hits: list[tuple[str, int]] = []
    for name, pat in PATTERNS:
        for match in pat.finditer(text):
            span = text[max(0, match.start() - 40) : match.end() + 40]
            if name == "http_basic_url" and is_placeholder_http_basic(match):
                continue
            if ALLOW.search(span) or ALLOW.search(match.group()):
                continue
            hits.append((name, match.start()))
    return hits



def format_hit(rel: str, name: str, text: str, offset: int) -> str:
    line, col = line_col(text, offset)
    return f"{rel}:{line}:{col} [{name}] redacted"



def find_hits_in_text(rel: str, text: str) -> list[str]:
    return [format_hit(rel, name, text, offset) for name, offset in iter_secret_hits(text)]



def find_hits_in_path(path: Path) -> list[str]:
    if not path.is_file():
        return []
    if path.suffix.lower() in BINARY_SUFFIXES:
        return []
    if path.stat().st_size > 2_000_000:
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    rel = path.relative_to(ROOT).as_posix()
    return find_hits_in_text(rel, text)



def run_scan() -> int:
    hits: list[str] = []
    for path in git_files():
        hits.extend(find_hits_in_path(path))

    # Also warn if personal config not ignored
    for risky in [
        "liyuan.config.json",
        "liyuan.agent.json",
        "liyuan.agent.meta.json",
        "liyuan-preset.json",
        ".liyuan-personas.json",
    ]:
        p = ROOT / risky
        if p.exists():
            tracked = subprocess.run(
                ["git", "ls-files", "--error-unmatch", risky],
                cwd=ROOT,
                capture_output=True,
            )
            if tracked.returncode == 0:
                hits.append(f"TRACKED personal file: {risky}")

    print(f"scanned git-tracked text files; hits={len(hits)}")
    for hit in hits:
        print("HIT", hit)
    return 1 if hits else 0



def run_self_test() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PrivacyScanSelfTest)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1



def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true", help="run unit tests for the scanner")
    args = parser.parse_args(argv)
    if args.self_test:
        return run_self_test()
    return run_scan()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
