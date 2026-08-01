# Forest Launcher Subcommands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `bin/forest` a five-command surface — bare, `up`, `down`, `status`, `restart` — so the server can be stopped and inspected without hand-rolling `lsof | xargs kill`.

**Architecture:** One file, `bin/forest`, restructured from a straight-line script into four helpers (`is_up`, `forest_pid`, `port_holder`, `reap_launcher`) plus two actions (`start_server`, `stop_server`) and a `case` dispatch at the bottom. The port is the server's identity: PIDs come from `lsof` on the configured port and are killed only after `ps` confirms the command line is Forest's `node server.mjs`.

**Tech Stack:** bash (macOS `/usr/bin/env bash`), `lsof`, `ps`, `pgrep`, `curl`, `node` (only to read `config.json`).

## Global Constraints

- **No new dependencies.** Forest is zero-dependency by design; the script may use only `lsof`, `ps`, `pgrep`, `curl`, `kill`, `open`, and `node`, all of which it or the OS already relies on.
- **`set -euo pipefail` stays at the top.** Every helper must behave correctly under it — command substitutions that may legitimately produce nothing need `|| true`.
- **Bare `forest` must not change behaviour**: start if down, then open the browser.
- **Never signal a process that is not Forest.** Every `kill` is gated on a `ps -o command=` match.
- **Exit codes:** `status` 0 running / 1 not running; unknown command 2; runtime failure 1; success 0.
- **The agent does not commit** (project rule `never-commit`). Each task ends by handing the working tree back for review.
- **Reference spec:** `docs/superpowers/specs/2026-08-01-forest-subcommands-design.md`

---

## File Structure

- **Modify: `bin/forest`** — the whole change. Grows from 25 to ~120 lines; still one responsibility (launch/manage the local server), so it stays one file.
- **Modify: `README.md`** — the `## Run` section gains the command table.

No new files. No changes to `server.mjs` or `lib/`.

---

### Task 1: Helpers and dispatch, bare behaviour preserved

Restructure the script without adding any user-visible command yet. At the end of this task `forest` behaves exactly as it does today, but the machinery the other commands need exists and any argument is rejected.

**Files:**
- Modify: `bin/forest` (whole file)

**Interfaces:**
- Consumes: nothing.
- Produces: `DIR`, `PORT`, `URL` globals; `usage()`, `is_up()`, `forest_pid()`, `port_holder()`, `start_server()` for Tasks 2–4.

- [ ] **Step 1: Replace `bin/forest` with the restructured script**

```bash
#!/usr/bin/env bash
set -euo pipefail
# Resolve this script's real directory, following the launcher symlink, so
# Forest works wherever the project lives (no hardcoded path).
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  LINKDIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$LINKDIR/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
PORT="$(node --input-type=commonjs -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('$DIR/config.json','utf8')).port||5577))}catch(e){process.stdout.write('5577')}" 2>/dev/null || echo 5577)"
URL="http://127.0.0.1:${PORT}"

usage() {
  cat >&2 <<'EOF'
usage: forest [command]

  (no command)  start the server if it is down, then open the dashboard
  up            start the server if it is down; do not open a browser
  down          stop the server
  status        report whether the server is running
  restart       stop the server, then start it again
EOF
  exit 2
}

# Is Forest answering on the port?
is_up() {
  curl -s "${URL}/api/config" >/dev/null 2>&1
}

# PID(s) of the Forest server listening on PORT, one per line. Prints nothing
# when the port is free or when the listener is not Forest. Liveness and PID
# are separate questions: a wedged Forest can hold the port while no longer
# answering /api/config, and `down` still has to be able to kill it.
forest_pid() {
  local pid cmd
  for pid in $(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true); do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *node*server.mjs*) printf '%s\n' "$pid" ;;
    esac
  done
}

# Command line of whatever holds the port, Forest or not. Returns 1 if free.
port_holder() {
  local pid
  pid="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] || return 1
  ps -o command= -p "$pid" 2>/dev/null || return 1
}

start_server() {
  if is_up; then
    return 0
  fi
  (cd "$DIR" && nohup node server.mjs >/tmp/forest.log 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if is_up; then return 0; fi
    sleep 0.3
  done
  echo "forest: server did not start on port ${PORT} — see /tmp/forest.log" >&2
  return 1
}

[ "$#" -le 1 ] || usage
cmd="${1:-open}"
case "$cmd" in
  open) start_server; open "$URL" ;;
  *)    usage ;;
esac
```

- [ ] **Step 2: Verify bare `forest` still works against a running server**

Run:
```bash
bin/forest status 2>/dev/null; echo "exit=$?"   # expect exit=2, usage on stderr (status not built yet)
bin/forest                                       # server already up: opens the browser, starts nothing new
```
Expected: the usage text for the first (exit 2), and for the second the dashboard opens with no new node process — confirm with `pgrep -f 'node server.mjs' | wc -l` still showing `1`.

- [ ] **Step 3: Verify the helpers in isolation**

Run:
```bash
bash -c 'source bin/forest 2>/dev/null; true' || true   # sourcing runs dispatch; use the subshell form below instead
bash -c 'set -euo pipefail; PORT=5577; URL="http://127.0.0.1:5577"
         lsof -ti tcp:5577 -sTCP:LISTEN; ps -o command= -p $(lsof -ti tcp:5577 -sTCP:LISTEN | head -1)'
```
Expected: a PID and the command line `node server.mjs` — this is the exact pair `forest_pid` matches on.

- [ ] **Step 4: Hand back**

Do not commit (project rule). Report: `bin/forest` restructured, behaviour unchanged, `up`/`down`/`status`/`restart` still reported as usage errors.

---

### Task 2: `up` and `status`

**Files:**
- Modify: `bin/forest` (add `status_server()`, extend the `case`)

**Interfaces:**
- Consumes: `forest_pid()`, `port_holder()`, `start_server()`, `PORT` from Task 1.
- Produces: `status_server()` for Task 4's `restart`.

- [ ] **Step 1: Add `status_server` immediately after `start_server`**

```bash
# 0 when Forest is running, 1 otherwise, so `forest status && ...` is scriptable.
status_server() {
  local pids holder
  pids="$(forest_pid)"
  if [ -n "$pids" ]; then
    echo "forest: running (pid $(printf '%s' "$pids" | tr '\n' ' ' | sed 's/ *$//'), port ${PORT})"
    return 0
  fi
  if holder="$(port_holder)"; then
    echo "forest: not running; port ${PORT} held by:"
    echo "  ${holder}"
    return 1
  fi
  echo "forest: not running (port ${PORT})"
  return 1
}
```

- [ ] **Step 2: Extend the dispatch**

Replace the `case` block from Task 1 with:

```bash
case "$cmd" in
  open)   start_server; open "$URL" ;;
  up)     start_server; status_server ;;
  status) status_server ;;
  *)      usage ;;
esac
```

- [ ] **Step 3: Verify against the running server**

Run:
```bash
bin/forest status; echo "exit=$?"
```
Expected: `forest: running (pid 41131, port 5577)` and `exit=0`.

- [ ] **Step 4: Verify `up` is a no-op when already running**

Run:
```bash
pgrep -f 'node server.mjs' | wc -l
bin/forest up
pgrep -f 'node server.mjs' | wc -l
```
Expected: the same count before and after, the `running` line printed, and no browser tab opened.

- [ ] **Step 5: Hand back**

Do not commit. Report `up` and `status` working; `down` and `restart` still usage errors.

---

### Task 3: `down`

The task a reviewer is most likely to reject on its own — it is the only one that signals processes.

**Files:**
- Modify: `bin/forest` (add `reap_launcher()` and `stop_server()`, extend the `case`)

**Interfaces:**
- Consumes: `forest_pid()`, `port_holder()`, `PORT` from Task 1.
- Produces: `stop_server()` for Task 4's `restart`.

- [ ] **Step 1: Add `reap_launcher` after `port_holder`**

```bash
# The `( ... nohup node server.mjs & )` subshell does not exit — it survives as
# the server's parent, reparented to init, and is why `ps | grep forest` is
# unreadable. Once the server is gone it is a childless bash running this very
# script, so reap it. Never touches our own shell, and never a process with
# surviving children.
reap_launcher() {
  local ppid="$1" cmd
  [ -n "$ppid" ] || return 0
  [ "$ppid" -gt 1 ] 2>/dev/null || return 0
  [ "$ppid" != "$$" ] || return 0
  cmd="$(ps -o command= -p "$ppid" 2>/dev/null || true)"
  case "$cmd" in
    *bash*forest*) ;;
    *) return 0 ;;
  esac
  [ -z "$(pgrep -P "$ppid" 2>/dev/null || true)" ] || return 0
  kill "$ppid" 2>/dev/null || true
}
```

- [ ] **Step 2: Add `stop_server` after `reap_launcher`**

```bash
stop_server() {
  local pids ppid holder signal gone
  pids="$(forest_pid)"

  if [ -z "$pids" ]; then
    if holder="$(port_holder)"; then
      echo "forest: port ${PORT} is held by something that is not forest:" >&2
      echo "  ${holder}" >&2
      return 1
    fi
    echo "forest: not running (port ${PORT})"
    return 0
  fi

  # Remember the launcher shell before the server dies and the link is lost.
  ppid="$(ps -o ppid= -p "$(printf '%s\n' "$pids" | head -1)" 2>/dev/null | tr -d ' ' || true)"

  kill $pids 2>/dev/null || true
  signal="TERM"
  gone=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [ -z "$(forest_pid)" ]; then gone=1; break; fi
    sleep 0.3
  done

  if [ "$gone" -eq 0 ]; then
    kill -9 $pids 2>/dev/null || true
    signal="KILL"
    sleep 0.3
    if [ -n "$(forest_pid)" ]; then
      echo "forest: failed to stop server on port ${PORT}" >&2
      return 1
    fi
  fi

  reap_launcher "$ppid"
  echo "forest: stopped (port ${PORT}, SIG${signal})"
}
```

Note `kill $pids` is deliberately unquoted: `forest_pid` may print more than one PID and each must become its own argument.

- [ ] **Step 3: Add `down` to the dispatch**

```bash
case "$cmd" in
  open)   start_server; open "$URL" ;;
  up)     start_server; status_server ;;
  down)   stop_server ;;
  status) status_server ;;
  *)      usage ;;
esac
```

- [ ] **Step 4: Verify the stranger-on-the-port guard BEFORE testing the happy path**

With the real server stopped, park a decoy on the port and confirm `down` refuses it:
```bash
bin/forest down                      # stop the real server first
nc -l 127.0.0.1 5577 &               # decoy holds the port
sleep 0.5
bin/forest down; echo "exit=$?"
jobs                                 # decoy must still be running
kill %1
```
Expected: `forest: port 5577 is held by something that is not forest:` plus the `nc` command line, `exit=1`, and `nc` alive in `jobs`.

- [ ] **Step 5: Verify the happy path and the launcher reap**

```bash
bin/forest up
ps -o pid,ppid,command -p "$(pgrep -f 'node server.mjs')"   # note the PPID
bin/forest down; echo "exit=$?"
ps aux | grep -c '[f]orest'          # expect 0
```
Expected: `forest: stopped (port 5577, SIGTERM)`, `exit=0`, and neither the server nor its launcher shell left behind.

- [ ] **Step 6: Verify idempotence**

```bash
bin/forest down; echo "exit=$?"
```
Expected: `forest: not running (port 5577)` and `exit=0`.

- [ ] **Step 7: Hand back**

Do not commit. Report `down` working, including the refusal case and the launcher reap.

---

### Task 4: `restart` and README

**Files:**
- Modify: `bin/forest` (one `case` arm)
- Modify: `README.md` (the `## Run` section)

**Interfaces:**
- Consumes: `stop_server()` (Task 3), `start_server()` and `status_server()` (Tasks 1–2).
- Produces: nothing.

- [ ] **Step 1: Add the `restart` arm**

```bash
case "$cmd" in
  open)    start_server; open "$URL" ;;
  up)      start_server; status_server ;;
  down)    stop_server ;;
  status)  status_server ;;
  restart) stop_server; start_server; status_server ;;
  *)       usage ;;
esac
```

`set -e` makes this correct for free: if `stop_server` returns 1 because a stranger holds the port, the restart aborts instead of starting a second server.

- [ ] **Step 2: Verify restart replaces the process**

```bash
bin/forest up
before="$(pgrep -f 'node server.mjs')"
bin/forest restart
after="$(pgrep -f 'node server.mjs')"
echo "before=$before after=$after"; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5577/api/config
```
Expected: `before` and `after` differ, and the final curl prints `200`.

- [ ] **Step 3: Replace the README `## Run` section**

```markdown
## Run

    forest            # start the server (if down) and open the dashboard

    forest up         # start the server; do not open a browser
    forest down       # stop the server
    forest status     # report running/stopped, with pid and port
    forest restart    # stop, then start again

`forest status` exits 0 when the server is running and 1 when it is not, so it
composes: `forest status && open http://127.0.0.1:5577`.

Forest finds its server by looking for the listener on its configured port and
checking that the process really is `node server.mjs` — if something else is
squatting on the port, `forest down` reports it and refuses to kill it.

Or directly:

    node server.mjs

Then open http://127.0.0.1:5577.
```

- [ ] **Step 4: Run the full verification checklist from the spec**

Work through all eight steps in the spec's Verification section end to end, on a clean start. Every one must pass.

- [ ] **Step 5: Confirm nothing else regressed**

```bash
npm test
```
Expected: the existing `lib/*.test.mjs` suite passes untouched — this change adds no JS, so any failure here is pre-existing and should be reported, not fixed in this task.

- [ ] **Step 6: Hand back for review and commit**

Do not commit. Summarise: `bin/forest` gained four commands, README documents them, spec checklist green.

---

## Self-Review

**Spec coverage:** bare/`up`/`down`/`status`/`restart` → Tasks 1–4. Port + identity PID lookup → Task 1 `forest_pid`. Stranger refusal → Task 3 Step 4. TERM-then-KILL escalation → Task 3 `stop_server`. Launcher reap → Task 3 `reap_launcher`. Exit codes → Task 1 `usage` (2), Task 2 `status_server` (0/1). README → Task 4. Every spec section maps to a task.

**Placeholder scan:** no TBD/TODO; every code step carries the literal code; every verification step carries the command and its expected output.

**Type consistency:** `is_up`, `forest_pid`, `port_holder`, `start_server`, `status_server`, `stop_server`, `reap_launcher`, `usage` — each defined once in Task 1, 2, or 3 and referenced under the same name in every later task. `PORT`/`URL`/`DIR` set once in Task 1.

**Known deviations from the writing-plans template**, both forced by constraints established earlier:
- No red/green test cycle. The spec settled that a port-binding, signal-sending bash script does not fit `node --test`, and that adding a shell-test framework for one script is not worth it. Each task instead ends in manual verification with exact commands and expected output.
- No commit steps. The project rule is that the user commits after review.
