#!/usr/bin/env python3
"""Removes the staging edge login from smoke-test artifacts before upload.

The repository is public, so its workflow artifacts are readable by anyone
with a GitHub account. A Playwright trace records every request header (the
`Authorization: Basic ...` the browser sends for the edge login) and the
browser context options (`httpCredentials`). This script replaces the
password, the `user:password` pair and its Base64 form with a placeholder in
every file under the given directory, inside trace zips too, then checks
that none of them is left; a file that still holds one is deleted.

Usage: EDGE_BASIC_AUTH_USER=... EDGE_BASIC_AUTH_PASSWORD=... \
       python3 scripts/redact-smoke-artifacts.py test-results
"""

import base64
import json
import os
import sys
import zipfile

PLACEHOLDER = b"REDACTED"


def secret_variants(user: str, password: str) -> list[bytes]:
    pair = f"{user}:{password}"
    variants = {
        pair,
        base64.b64encode(pair.encode()).decode(),
        password,
        json.dumps(password)[1:-1],
        json.dumps(pair)[1:-1],
    }
    # Longest first, so the pair is replaced before the password inside it.
    return sorted((v.encode() for v in variants if v), key=len, reverse=True)


def scrub(data: bytes, secrets: list[bytes]) -> bytes:
    for secret in secrets:
        data = data.replace(secret, PLACEHOLDER)
    return data


def contains_secret(data: bytes, secrets: list[bytes]) -> bool:
    return any(secret in data for secret in secrets)


def redact_zip(path: str, secrets: list[bytes]) -> None:
    with zipfile.ZipFile(path) as source:
        entries = [(info, scrub(source.read(info), secrets)) for info in source.infolist()]
    tmp = f"{path}.tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as target:
        for info, data in entries:
            target.writestr(info, data)
    os.replace(tmp, path)


def still_leaks(path: str, secrets: list[bytes]) -> bool:
    with open(path, "rb") as handle:
        raw = handle.read()
    if contains_secret(raw, secrets):
        return True
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            return any(contains_secret(archive.read(info), secrets) for info in archive.infolist())
    return False


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = sys.argv[1]
    user = os.environ.get("EDGE_BASIC_AUTH_USER", "")
    password = os.environ.get("EDGE_BASIC_AUTH_PASSWORD", "")
    if not password or not os.path.isdir(root):
        print("nothing to redact (no edge login or no artifacts)")
        return 0
    secrets = secret_variants(user, password)
    files = [os.path.join(d, f) for d, _, names in os.walk(root) for f in names]
    for path in files:
        if zipfile.is_zipfile(path):
            redact_zip(path, secrets)
        else:
            with open(path, "rb") as handle:
                raw = handle.read()
            clean = scrub(raw, secrets)
            if clean != raw:
                with open(path, "wb") as handle:
                    handle.write(clean)
    removed = 0
    for path in files:
        if still_leaks(path, secrets):
            os.remove(path)
            removed += 1
            print(
                f"::warning title=Artifact withheld::{path} still held the edge login after redaction and was removed"
            )
    print(f"redacted {len(files)} file(s), withheld {removed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
