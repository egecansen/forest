#!/usr/bin/env python3
"""
port-mcp-user.py — mirror this repo's MCP servers into Cursor at USER level.

Cursor reads MCP config from two places:
    ~/.cursor/mcp.json          every project, every window   <- this script
    <project>/.cursor/mcp.json  one project only

Per-project is the wrong unit here: worktrees come and go, and a new one would
start with no Jira and no qagent — `hektor-from-jira` cannot fetch a ticket and
`hektor-qagent` cannot query. User level survives every worktree.

Source is Claude Code's own config (~/.claude.json): `Atlassian` sits at the
global level, `qagent` under projects[<repo>]. Those are the two Hektor needs.

    python3 scripts/port-mcp-user.py [--repo <path>] [--dry-run]

Existing servers in ~/.cursor/mcp.json are preserved; a server of the same name
is replaced. The file is written 0600 and lives outside every git repo. Re-run
after rotating a token, then restart Cursor.
"""
import json
import os
import shutil
import sys

DEFAULT_REPO = "/Users/egecan.sen/sahibinden/repo/web-test"
SRC = os.path.expanduser("~/.claude.json")
DST = os.path.expanduser("~/.cursor/mcp.json")

repo = DEFAULT_REPO
dry = "--dry-run" in sys.argv
if "--repo" in sys.argv:
    repo = sys.argv[sys.argv.index("--repo") + 1]
repo = os.path.abspath(repo)

if not os.path.exists(SRC):
    sys.exit("no %s — nothing to mirror" % SRC)

claude = json.load(open(SRC))
projects = claude.get("projects", {}) or {}

wanted = {}
wanted.update(claude.get("mcpServers") or {})
# The repo's own entry, else any project entry that looks like this repo (a
# worktree registers under its own path, so an exact key match can miss).
base = os.path.basename(repo)
for key in [repo] + [k for k in projects if base in k]:
    wanted.update((projects.get(key, {}) or {}).get("mcpServers") or {})

if not wanted:
    sys.exit("no MCP servers found for %s in %s" % (repo, SRC))

existing = {}
if os.path.exists(DST):
    try:
        existing = json.load(open(DST)).get("mcpServers", {}) or {}
    except Exception as e:
        sys.exit("REFUSING: %s is not valid JSON (%s) — fix or move it first" % (DST, e))

merged = dict(existing)
merged.update(wanted)

added = sorted(set(wanted) - set(existing))
replaced = sorted(k for k in wanted if k in existing and existing[k] != wanted[k])
unchanged = sorted(k for k in wanted if k in existing and existing[k] == wanted[k])

print("source : %s" % SRC)
print("target : %s" % DST)
for label, names in (("add", added), ("replace", replaced), ("unchanged", unchanged)):
    for n in names:
        print("  %-9s %s (transport=%s)" % (label, n, merged[n].get("type", "stdio")))
for n in sorted(set(existing) - set(wanted)):
    print("  %-9s %s" % ("keep", n))

if dry:
    print("\n--dry-run: nothing written")
    sys.exit(0)
if merged == existing:
    print("\nno change")
    sys.exit(0)

os.makedirs(os.path.dirname(DST), exist_ok=True)
if os.path.exists(DST):
    shutil.copyfile(DST, DST + ".bak")
    print("\nbacked up -> %s.bak" % (DST,))
with open(DST, "w") as fh:
    json.dump({"mcpServers": merged}, fh, indent=2)
    fh.write("\n")
os.chmod(DST, 0o600)
print("wrote %s (mode 600, outside every git repo)" % DST)
print("Restart Cursor, then Settings -> MCP: the servers should be green.")
