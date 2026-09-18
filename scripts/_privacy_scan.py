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
SELF_TEST_FIXTURE_FILES = {"scripts/_privacy_scan.py"}
LINE_ALLOW_MARKER = "privacy-scan: allow-line"

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

LINE_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    (
        "deploy_password_field",
        re.compile(r"(?i)^\s*\|\s*(?:basic auth\s+)?(?:password|passwd|密码)\s*\|\s*`?(?P<value>[^`\n|]+)`?\s*\|\s*$"),
        "value",
    ),
    (
        "deploy_password_field",
        re.compile(r"(?i)^\s*(?:[-*]\s*)?(?:basic auth(?:\s+password)?|password|passwd|密码)\s*[:：=]\s*`?(?P<value>[^`\n]+?)`?\s*$"),
        "value",
    ),
    (
        "deploy_ssh_target",
        re.compile(r"(?i)\bssh\b[^\n]*\b(?P<value>[A-Za-z0-9._-]+@(?:\d{1,3}\.){3}\d{1,3})\b"),
        "value",
    ),
]

PLACEHOLDER_VALUE = re.compile(
    r"^(?:<[^>\n]+>|\$\{[^}\n]+\}|process\.env(?:\.[A-Za-z0-9_]+)?|YOUR_[A-Z0-9_]+|your_[a-z0-9_]+|API_KEY_HERE|x{3,}|example(?:[-_ ]?(?:pass(?:word)?|secret|token|key|user|account))?|placeholder(?:[-_ ]?(?:pass(?:word)?|secret|token|key|user|account))?|changeme|todo|pass(?:word)?(?:\d{0,4})?|passwd|secret|token|key|sample|demo|test)$",
    re.I,
)


class PrivacyScanSelfTest(unittest.TestCase):
    def test_flags_explicit_http_basic_url(self) -> None:
        password = "Real" + "Secret_123456"
        text = "remote https://alice:" + password + "@internal.local/repo.git"
        hits = find_hits_in_text("docs.txt", text)
        self.assertEqual(1, len(hits))
        self.assertIn("[http_basic_url]", hits[0])
        self.assertNotIn("RealSecret_123456", hits[0])

    def test_real_basic_url_still_hits_with_example_or_todo_nearby(self) -> None:
        password = "Alpha" + "Bravo_123456"
        text = "example TODO remote https://alice:" + password + "@internal.local/repo.git"
        hits = find_hits_in_text("docs.txt", text)
        self.assertEqual(1, len(hits))
        self.assertIn("[http_basic_url]", hits[0])

    def test_ignores_placeholder_http_basic_url(self) -> None:
        password = "pass" + "word"
        text = "remote https://alice:" + password + "@example.com/repo.git"
        self.assertEqual([], find_hits_in_text("docs.txt", text))

    def test_flags_deploy_password_field(self) -> None:
        password = "Deploy" + "Secret_456789"
        text = "| 密码 | `" + password + "` |"
        hits = find_hits_in_text("deploy/VPS-OPERATIONS.md", text)
        self.assertEqual(1, len(hits))
        self.assertIn("[deploy_password_field]", hits[0])

    def test_ignores_placeholder_deploy_password_field(self) -> None:
        password = "pass" + "word"
        text = "| Password | `" + password + "` |"
        self.assertEqual([], find_hits_in_text("deploy/template.md", text))

    def test_flags_ssh_user_at_ipv4(self) -> None:
        text = "ssh -i key -p 22 root@" + "203.0.113.10"
        hits = find_hits_in_text("deploy/VPS-OPERATIONS.md", text)
        self.assertEqual(1, len(hits))
        self.assertIn("[deploy_ssh_target]", hits[0])

    def test_ignores_plain_ip_without_login(self) -> None:
        self.assertEqual([], find_hits_in_text("notes.txt", "service at http://10.0.0.8:7620/"))

    def test_ignores_private_key_path(self) -> None:
        self.assertEqual([], find_hits_in_text("notes.txt", "/Users/alice/.ssh/id_ed25519"))

    def test_exact_line_allow_comment_is_fixture_only(self) -> None:
        password = "Allow" + "Me_123456"
        text = "https://alice:" + password + "@internal.local/repo.git # privacy-scan: allow-line"
        self.assertEqual([], find_hits_in_text("scripts/_privacy_scan.py", text))
        self.assertEqual(1, len(find_hits_in_text("docs.txt", text)))


def git_files() -> list[Path]:
    out = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    return [ROOT / p.decode() for p in out.split(b"\0") if p]



def line_col(text: str, offset: int) -> tuple[int, int]:
    line = text.count("\n", 0, offset) + 1
    last_newline = text.rfind("\n", 0, offset)
    col = offset + 1 if last_newline == -1 else offset - last_newline
    return line, col



def iter_lines_with_offsets(text: str) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    offset = 0
    for raw_line in text.splitlines(keepends=True):
        lines.append((offset, raw_line.rstrip("\r\n")))
        offset += len(raw_line)
    if not text:
        return [(0, "")]
    if not text.endswith(("\n", "\r")):
        return lines
    return lines



def is_placeholder_value(value: str) -> bool:
    return bool(PLACEHOLDER_VALUE.fullmatch(value.strip()))



def has_fixture_line_allow(rel: str, line: str) -> bool:
    return rel in SELF_TEST_FIXTURE_FILES and LINE_ALLOW_MARKER in line



def matched_value(name: str, match: re.Match[str]) -> str:
    if name == "http_basic_url":
        return match.group("password")
    return match.group(0)



def iter_secret_hits(rel: str, text: str) -> list[tuple[str, int]]:
    hits: list[tuple[str, int]] = []
    line_offsets = iter_lines_with_offsets(text)
    line_index: dict[int, str] = {start: line for start, line in line_offsets}

    for name, pat in PATTERNS:
        for match in pat.finditer(text):
            line_start = text.rfind("\n", 0, match.start()) + 1
            line = line_index.get(line_start, text[line_start : text.find("\n", match.start()) if text.find("\n", match.start()) != -1 else len(text)])
            if is_placeholder_value(matched_value(name, match)):
                continue
            if has_fixture_line_allow(rel, line):
                continue
            hits.append((name, match.start()))

    for line_start, line in line_offsets:
        for name, pat, value_group in LINE_PATTERNS:
            for match in pat.finditer(line):
                value = match.group(value_group).strip()
                if is_placeholder_value(value):
                    continue
                if has_fixture_line_allow(rel, line):
                    continue
                hits.append((name, line_start + match.start(value_group)))

    hits.sort(key=lambda item: item[1])
    return hits



def format_hit(rel: str, name: str, text: str, offset: int) -> str:
    line, col = line_col(text, offset)
    return f"{rel}:{line}:{col} [{name}] redacted"



def find_hits_in_text(rel: str, text: str) -> list[str]:
    return [format_hit(rel, name, text, offset) for name, offset in iter_secret_hits(rel, text)]



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
