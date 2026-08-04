#!/usr/bin/env python3
"""
Verify a rules document produced by the rules-from-experts skill.

Checks that the document's own claims about itself are true, and that the
prose obeys the plain-English constraints. Counting by eye is unreliable;
a rules file whose header count is wrong is worthless as a standard.

Usage:
    python3 verify_rules_doc.py path/to/rules.md
    python3 verify_rules_doc.py path/to/rules.md --limit-descriptive 25 --limit-procedural 20

Exit code 0 if clean, 1 if any finding.

Recognised rule formats (either is fine, don't mix):

  Markdown table rows:
      | G3 | MUST | Make the section gap at least twice the group gap. |

  Delimited rows inside a fenced block:
      G3,MUST,Make the section gap at least twice the group gap.

Aggregate lines it looks for (optional but checked when present):
      rules: 80 across 10 groups
      severity: MUST=57, NEVER=14, DEFAULT=9
  and per-group counts as table rows:
      | G | Gaps | 10 |
"""

import argparse
import re
import sys
from collections import Counter

SEVERITIES = ("MUST", "NEVER", "DEFAULT")

BANNED_PROSE = [
    (r"\bshould\b", "hedging modal 'should' — use 'must' or state it as fact"),
    (r"\bwould\b", "hedging modal 'would' — restructure"),
    (r"\bmight\b", "hedging modal 'might' — use 'can' or state it as fact"),
    (r"\bcould\b", "hedging modal 'could' — use 'can'"),
    (r";", "semicolon — split into two sentences"),
    (r"\b\w+'(?:ll|re|ve|s|t)\b", "contraction — expand it"),
    (r"\be\.g\.", "'e.g.' — write 'for example'"),
    (r"\bi\.e\.", "'i.e.' — write 'that is'"),
    (r"\betc\.", "'etc.' — name the items"),
    (r"\bit is worth noting\b", "filler phrase — delete"),
    (r"\bin order to\b", "wordy — use 'to'"),
]

# Words that carry no fact. Flagged as warnings, not errors.
FILLER = ["genuinely", "actually", "robust", "comprehensive", "leverage", "seamlessly"]


def strip_code(text):
    """Remove fenced code blocks. Code is exempt from prose rules."""
    return re.sub(r"```.*?```", "", text, flags=re.S)


def parse_rules(text):
    """Return {rule_id: severity} from either supported format."""
    rules = {}
    dupes = []

    table = re.finditer(
        r"^\|\s*([A-Z]{1,2}\d{1,3})\s*\|\s*(MUST|NEVER|DEFAULT)\s*\|\s*(.+?)\s*\|\s*$",
        text, re.M)
    delim = re.finditer(
        r"^\s*([A-Z]{1,2}\d{1,3}),(MUST|NEVER|DEFAULT),(.+)$",
        text, re.M)

    for m in list(table) + list(delim):
        rid, sev = m.group(1), m.group(2)
        if rid in rules:
            dupes.append(rid)
        rules[rid] = sev
    return rules, dupes


def check_sentences(text, limit_desc, limit_proc):
    """Flag over-length sentences in prose. Code and tables are skipped."""
    findings = []
    for lineno, line in enumerate(strip_code(text).split("\n"), 1):
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("|") or "http" in s:
            continue
        procedural = bool(re.match(r"^(- \[ \]|\d+\.\s|[A-Z]{1,2}\d{1,3},)", s))
        limit = limit_proc if procedural else limit_desc
        body = re.sub(r"^(-\s*\[\s*\]\s*|\d+\.\s*|-\s+|>\s*)", "", s)
        body = re.sub(r"`[^`]*`", "X", body)      # inline code counts as one word
        body = re.sub(r"\([^)]*\)", "X", body)    # parenthetical counts as one word
        body = re.sub(r'"[^"]*"', "X", body)      # quoted title counts as one word
        body = re.sub(r"[*_]", "", body)
        for sentence in re.split(r"(?<=[.!?:])\s+", body):
            words = [w for w in sentence.split() if re.search(r"\w", w)]
            if len(words) > limit:
                findings.append(
                    f"line {lineno}: sentence is {len(words)} words (limit {limit}): "
                    f"{sentence[:70]}...")
    return findings


def check_banned(text):
    findings = []
    for lineno, line in enumerate(strip_code(text).split("\n"), 1):
        s = line.strip()
        if not s or "http" in s:
            continue
        for pattern, why in BANNED_PROSE:
            if re.search(pattern, s, re.I if pattern.startswith(r"\bit is") else 0):
                findings.append(f"line {lineno}: {why} — {s[:60]}")
    return findings


def check_filler(text):
    out = []
    for lineno, line in enumerate(strip_code(text).split("\n"), 1):
        for word in FILLER:
            if re.search(rf"\b{word}\b", line, re.I):
                out.append(f"line {lineno}: filler word '{word}'")
    return out


def check_aggregates(text, rules):
    findings = []
    sev_actual = Counter(rules.values())

    m = re.search(r"rules:\s*(\d+)\b", text)
    if m:
        claimed = int(m.group(1))
        if claimed != len(rules):
            findings.append(
                f"header claims {claimed} rules, found {len(rules)}")
    else:
        findings.append("no 'rules: N' aggregate line found — AXI requires "
                        "pre-computed totals")

    m = re.search(r"severity:\s*MUST=(\d+),\s*NEVER=(\d+),\s*DEFAULT=(\d+)", text)
    if m:
        claimed = dict(zip(SEVERITIES, (int(g) for g in m.groups())))
        for sev in SEVERITIES:
            if claimed[sev] != sev_actual[sev]:
                findings.append(
                    f"header claims {claimed[sev]} {sev} rules, "
                    f"found {sev_actual[sev]}")
    else:
        findings.append("no 'severity: MUST=..' aggregate line found")

    # Per-group counts, e.g. "| G | Gaps | 10 |"
    group_actual = Counter(re.match(r"([A-Z]{1,2})", r).group(1) for r in rules)
    for m in re.finditer(r"^\|\s*([A-Z]{1,2})\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*$",
                         text, re.M):
        code, name, claimed = m.group(1), m.group(2).strip(), int(m.group(3))
        if code in group_actual and group_actual[code] != claimed:
            findings.append(
                f"group {code} ({name}) claims {claimed}, found {group_actual[code]}")
    return findings


def check_references(text, rules):
    """Every rule ID mentioned anywhere must be defined.

    Conformance-check tables carry their own IDs in the first column. Those
    are not rule references, so strip them before scanning. A check ID that
    collides with a rule group letter is itself a finding — reviewers cannot
    tell which one is meant.
    """
    if not rules:
        return []
    prefixes = {re.match(r"([A-Z]{1,2})", r).group(1) for r in rules}
    pattern = r"\b(" + "|".join(sorted(prefixes, key=len, reverse=True)) + r")(\d{1,3})\b"

    findings = []
    collisions = set()
    scannable = []
    for line in text.split("\n"):
        m = re.match(r"^\|\s*([A-Z]{1,2}\d{1,3})\s*\|", line)
        if m and m.group(1) not in rules:
            collisions.add(re.match(r"([A-Z]{1,2})", m.group(1)).group(1))
            line = line[m.end(1):]          # drop the check ID, keep the rest
        scannable.append(line)

    referenced = {m.group(0) for m in re.finditer(pattern, "\n".join(scannable))}
    for r in sorted(referenced - set(rules)):
        findings.append(f"rule {r} is referenced but never defined")
    for c in sorted(collisions & prefixes):
        findings.append(
            f"conformance-check IDs start with '{c}', which is also a rule group "
            f"letter — give checks a prefix no rule group uses")
    return findings


def check_forbidden_content(text):
    """The rules file must carry no citations."""
    findings = []
    if re.search(r"^\s*#+\s*(References|Bibliography|Sources|Citations)\s*$",
                 text, re.M | re.I):
        findings.append(
            "a references section is present — the rules file must carry no citations")
    for m in re.finditer(r"\b(according to|as .{0,20} argues|et al\.)\b", text, re.I):
        findings.append(f"citation-style phrase '{m.group(0)}' — the rules stand alone")
    return findings


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path")
    ap.add_argument("--limit-descriptive", type=int, default=25)
    ap.add_argument("--limit-procedural", type=int, default=20)
    ap.add_argument("--strict", action="store_true",
                    help="treat filler-word warnings as findings")
    args = ap.parse_args()

    try:
        text = open(args.path, encoding="utf-8").read()
    except OSError as e:
        print(f"cannot read {args.path}: {e}")
        return 1

    rules, dupes = parse_rules(text)

    groups = Counter(re.match(r"([A-Z]{1,2})", r).group(1) for r in rules)
    sev = Counter(rules.values())
    print(f"Parsed {len(rules)} rules across {len(groups)} groups")
    print(f"  severity: {dict(sev)}")
    print(f"  groups:   {dict(sorted(groups.items()))}\n")

    sections = [
        ("duplicate IDs", [f"rule {r} is defined more than once" for r in sorted(set(dupes))]),
        ("aggregates", check_aggregates(text, rules)),
        ("undefined references", check_references(text, rules)),
        ("citations in rules file", check_forbidden_content(text)),
        ("sentence length", check_sentences(text, args.limit_descriptive,
                                            args.limit_procedural)),
        ("banned patterns", check_banned(text)),
    ]
    if args.strict:
        sections.append(("filler words", check_filler(text)))

    total = 0
    for title, findings in sections:
        if findings:
            total += len(findings)
            print(f"{title.upper()} — {len(findings)} finding(s)")
            for f in findings[:20]:
                print(f"  - {f}")
            if len(findings) > 20:
                print(f"  ... and {len(findings) - 20} more")
            print()

    if not rules:
        print("WARNING: no rules parsed. Check the rule row format "
              "(see the docstring for the two supported shapes).")
        return 1

    if total == 0:
        print("CLEAN — no findings.")
        return 0

    print(f"{total} finding(s). Fix and re-run.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
