"""Print the CHANGELOG.md section for one tag — the release body CI publishes.

    python tools/release_notes.py v1.3.0 > notes.md

Exits non-zero when the tag has no section, so a release is never published with the wrong notes.
"""
import argparse
import sys
from pathlib import Path

CHANGELOG = Path(__file__).resolve().parent.parent / "CHANGELOG.md"
HEADING = "## "


def section(text: str, tag: str) -> str | None:
    """The lines under `## <tag>`, up to the next section heading."""
    out, collecting = [], False
    for line in text.splitlines():
        if line.startswith(HEADING):
            if collecting:
                break
            collecting = line[len(HEADING):].strip() == tag
            continue
        if collecting:
            out.append(line)
    body = "\n".join(out).strip()
    return body or None


def main() -> None:
    # The notes contain box glyphs and arrows; a Windows runner's stdout defaults to cp1252 and
    # would raise UnicodeEncodeError instead of printing them.
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("tag", help="release tag, e.g. v1.3.0")
    ap.add_argument("--changelog", type=Path, default=CHANGELOG)
    a = ap.parse_args()
    body = section(a.changelog.read_text(encoding="utf-8"), a.tag)
    if body is None:
        sys.exit(f"{a.changelog.name} has no '## {a.tag}' section — add it before tagging.")
    print(body)


if __name__ == "__main__":
    main()
