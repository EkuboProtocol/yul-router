"""Recount router-only instruction gas from the reduced baseline debugger trace."""
import collections
import json
from pathlib import Path

def category(op):
    if op in (0x56, 0x57, 0x5b):
        return "branches/jump destinations"
    if 0x80 <= op <= 0x9f or op == 0x50:
        return "DUP/SWAP/POP"
    if 0x5f <= op <= 0x7f:
        return "PUSH"
    if op in (0x35, 0x36, 0x37, 0x38, 0x39):
        return "calldata/code reads/copies"
    if op in (0x51, 0x52, 0x53):
        return "memory loads/stores"
    return "arithmetic/checks/environment/other"

rows = json.loads(Path(__file__).with_name("router-steps.json").read_text())
for name, entry, callback in [("Yul", 16, 18), ("Huff", 36, 38)]:
    costs = collections.Counter()
    segments = []
    for row in rows:
        if row["frame"] == callback:
            segments.append(sum(step[2] for step in row["steps"]))
            for _, op, gas in row["steps"]:
                costs[category(op)] += gas
    outer = sum(s[2] for row in rows if row["frame"] == entry for s in row["steps"])
    print(name, "entry/return", outer, "callback segments", segments)
    print(dict(costs), "callback sum", sum(costs.values()))
