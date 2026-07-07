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
        ["git", "log", "--no-decorate", "--format=%s", f"{prev}..{TAG}"],
        capture_output=True, text=True)
    log_text = result.stdout.strip()

    uncategorized = []
    for prefix, (emoji, title) in categories.items():
        items = []
        for msg in log_text.split("\n"):
            if re.match(rf"^{prefix}[(:]", msg, re.IGNORECASE):
                clean = re.sub(r"^[^(:]+[:(]\s*", "", msg)
                if not clean.endswith(")"):
                    clean = re.sub(r"\)$", "", clean)
                items.append(f"  - {clean}" if clean else f"  - {msg}")
            elif not re.match(r"^(feat|fix|refactor|docs|style|chore|ci)[(:]", msg, re.IGNORECASE):
                uncategorized.append(f"  - {msg}")

        if items:
            lines.append("")
            lines.append(f"## {emoji} {title}")
            lines.append("")
            lines.extend(items)

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
