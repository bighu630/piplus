#!/usr/bin/env python3
"""Generate release notes from git log between the last two v* tags."""
import subprocess, sys, os, glob, re
from datetime import date

TAG = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TAG", "unknown")
OUT = sys.argv[2] if len(sys.argv) > 2 else "release-notes.md"

# Get tags sorted by creation date (newest first)
result = subprocess.run(
    ["git", "tag", "--sort=-creatordate"],
    capture_output=True, text=True)
tags = [t.strip() for t in result.stdout.strip().split("\n") if t.strip().startswith("v")]
prev = tags[1] if len(tags) > 1 else None

lines = []
lines.append(f"# piplus {TAG}")
lines.append("")
lines.append(f"> 发布日期: {date.today().isoformat()}")
lines.append("")
lines.append("---")

categories = {
    "feat": ("✨", "新功能"),
    "fix": ("🐛", "问题修复"),
    "refactor": ("🔧", "重构"),
    "docs": ("📝", "文档"),
    "style": ("🎨", "样式"),
    "chore": ("🛠", "工程与配置"),
    "ci": ("🤖", "CI/CD"),
}

if prev:
    result = subprocess.run(
        ["git", "log", "--no-decorate", "--no-merges", "--format=%s", f"{prev}..{TAG}"],
        capture_output=True, text=True)
    # Dedup by subject line while preserving order
    seen = set()
    unique_msgs = []
    for msg in result.stdout.strip().split("\n"):
        if msg not in seen:
            seen.add(msg)
            unique_msgs.append(msg)

    classified = {k: [] for k in categories}
    uncategorized = []
    for msg in unique_msgs:
        matched = False
        for prefix in categories:
            if re.match(rf"^{prefix}[(:]", msg, re.IGNORECASE):
                clean = re.sub(r"^[^(:]+[:(]\s*", "", msg)
                if clean.endswith(")"):
                    clean = clean[:-1]
                classified[prefix].append(f"  - {clean}" if clean else f"  - {msg}")
                matched = True
                break
        if not matched:
            uncategorized.append(f"  - {msg}")

    for prefix, (emoji, title) in categories.items():
        if classified[prefix]:
            lines.append("")
            lines.append(f"## {emoji} {title}")
            lines.append("")
            lines.extend(classified[prefix])

    if uncategorized:
        lines.append("")
        lines.append("## \U0001f4cb 其他")
        lines.append("")
        lines.extend(uncategorized)

lines.append("")
lines.append("---")
lines.append("")
lines.append("## \U0001f4e6 下载")
lines.append("")
lines.append("| 平台 | 文件 |")
lines.append("|------|------|")

for pattern, label in [
    ("linux-amd64/*.AppImage", "Linux AppImage"),
    ("linux-amd64/*.deb", "Linux deb"),
    ("linux-amd64/*.rpm", "Linux rpm"),
    ("windows-amd64/*.exe", "Windows"),
    ("mac-amd64/*.dmg", "macOS Intel"),
    ("mac-arm64/*.dmg", "macOS Apple Silicon"),
]:
    for f in sorted(glob.glob(pattern)):
        name = os.path.basename(f)
        lines.append(f"| {label} | `{name}` |")

with open(OUT, "w") as f:
    f.write("\n".join(lines) + "\n")

print(f"Generated {OUT} ({len(lines)} lines)")
