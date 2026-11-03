"""Mutation check for src/fixed.js. Applies one small defect at a time to a temporary copy, runs the
test suite, and requires the suite to FAIL. Exit code 1 if any mutation survives (is not detected).
Run from the lab root: python3 scripts/mutate.py
The mutation list below is the record of exactly what was planted."""
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MUTATIONS = [
    ("signature check removed entirely", "if (typeof header !== 'string' || !Number.isFinite(nowS)) return false;", "return true;"),
    ("constant-time MAC compare removed", "given.length === expected.length && timingSafeEqual(given, expected)", "given.length === expected.length"),
    ("replay window removed", "if (Math.abs(nowS - Number(t)) > TOLERANCE_S) return false;", ""),
    ("future timestamps accepted", "Math.abs(nowS - Number(t))", "(nowS - Number(t))"),
    ("hex format check removed", "if (!HEX64.test(s)) continue;", ""),
    ("only the first v1 value is considered", "else if (k === 'v1') sigs.push(v);", "else if (k === 'v1' && sigs.length === 0) sigs.push(v);"),
    ("only the first secret is considered", "for (const secret of [].concat(secrets))", "for (const secret of [].concat(secrets).slice(0, 1))"),
    ("NaN clock no longer fails closed", " || !Number.isFinite(nowS)", ""),
    ("timestamp format check removed", "!/^\\d{1,12}$/.test(t)", "false"),
    ("payload validation removed", "const bad = validateEvent(ev);", "const bad = null;"),
    ("amount type check removed", "Number.isSafeInteger(ev.data.amount) && ev.data.amount > 0", "true"),
    ("duplicate check removed", "if (done.has(ev.id)) return { status: 200, duplicate: true };", ""),
    ("concurrent-duplicate collapse removed", "if (inflight.has(ev.id)) {", "if (false) {"),
    ("concurrent duplicate always told 200", "return r.status === 200 ? { ...r, duplicate: true } : r;", "return { status: 200, duplicate: true };"),
    ("stale-event guard removed", "if (cur && (cur.at > ev.created || (cur.at === ev.created && cur.id >= ev.id))) return;", "if (false) return;"),
    ("same-second tie broken by arrival order", "cur.at === ev.created && cur.id >= ev.id", "cur.at === ev.created"),
    ("retries reduced to one attempt", "maxAttempts = 3,", "maxAttempts = 1,"),
    ("failure list not recorded", "deadLetter.push({ event: ev, error: String(err.message) });", ""),
    ("failure list records duplicates", "if (!deadIds.has(ev.id)) {", "if (true) {"),
    ("persistent failure acknowledged with 200", "return { status: 500, deadLettered: true };", "return { status: 200, deadLettered: true };"),
    ("maxAttempts validation removed", "if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {", "if (false) {"),
    ("security log for bad signatures removed", "log({ event: 'rejected', reason: 'bad signature' }); ", ""),
    ("dead-letter log removed", "log({ event: 'dead-lettered', reason: String(err.message), id: ev.id });", ""),
    ("backoff hook never called", "await sleep(backoffMs(attempt));", ""),
]


def run_suite(d):
    r = subprocess.run(["node", "--test", "test/lab.test.js"], cwd=d, capture_output=True, text=True, timeout=120)
    return r.returncode == 0


def main():
    tmp = tempfile.mkdtemp(prefix="mutate-")
    work = os.path.join(tmp, "lab")
    shutil.copytree(ROOT, work, ignore=shutil.ignore_patterns(".git", "node_modules", "evidence"))
    target = os.path.join(work, "src", "fixed.js")
    with open(target, encoding="utf-8") as f:
        original = f.read()
    if not run_suite(work):
        print("baseline suite FAILS; refusing to run mutations")
        sys.exit(2)
    survived = 0
    for i, (desc, old, new) in enumerate(MUTATIONS, 1):
        if original.count(old) != 1:
            print(f"M{i:02d} SKIPPED (pattern matches {original.count(old)} times): {desc}")
            survived += 1
            continue
        with open(target, "w", encoding="utf-8") as f:
            f.write(original.replace(old, new))
        killed = not run_suite(work)
        print(f"M{i:02d} {'KILLED  ' if killed else 'SURVIVED'} {desc}")
        survived += 0 if killed else 1
    with open(target, "w", encoding="utf-8") as f:
        f.write(original)
    print(f"restored baseline passes: {run_suite(work)}")
    print(f"{len(MUTATIONS) - survived} of {len(MUTATIONS)} mutations killed")
    shutil.rmtree(tmp)
    sys.exit(1 if survived else 0)


if __name__ == "__main__":
    main()
