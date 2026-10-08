#!/usr/bin/env python3
"""Sample Stockroom engine: a tiny deterministic engine used to test @officehum/sdk.

It follows the Office Hum engine contract: one JSON object on stdout, input data read from
OFFICEHUM_DATA_DIR, working records written only to OFFICEHUM_WORK_DIR, and writes deduplicated
by OFFICEHUM_IDEMPOTENCY_KEY.
"""

import argparse
import json
import os
import sys

DEFAULT_STOCK = {"BOLT-10": 120, "NUT-10": 80, "WASHER-10": 15}


def emit(result, code=0):
    print(json.dumps(result))
    sys.exit(code)


def adjustments_path():
    work_dir = os.environ.get("OFFICEHUM_WORK_DIR")
    if not work_dir:
        emit({"ok": False, "error": "OFFICEHUM_WORK_DIR is not set"}, 2)
    return os.path.join(work_dir, "adjustments.json")


def load_adjustments():
    work_dir = os.environ.get("OFFICEHUM_WORK_DIR")
    if not work_dir:
        return []
    path = os.path.join(work_dir, "adjustments.json")
    if not os.path.exists(path):
        return []
    with open(path) as handle:
        return json.load(handle)


def load_stock():
    stock = dict(DEFAULT_STOCK)
    data_dir = os.environ.get("OFFICEHUM_DATA_DIR")
    if data_dir and os.path.exists(os.path.join(data_dir, "stock.json")):
        with open(os.path.join(data_dir, "stock.json")) as handle:
            stock = json.load(handle)
    for adjustment in load_adjustments():
        stock[adjustment["sku"]] = stock.get(adjustment["sku"], 0) + adjustment["quantity"]
    return stock


def levels(args):
    stock = load_stock()
    skus = [args.sku] if args.sku else sorted(stock)
    unknown = [sku for sku in skus if sku not in stock]
    if unknown:
        emit({"ok": False, "error": "unknown SKU: " + ", ".join(unknown)}, 2)
    findings = [
        {"id": "stock:" + sku, "description": sku + " on hand", "quantity": stock[sku]} for sku in skus
    ]
    caveats = [sku + " is below 20 units" for sku in skus if stock[sku] < 20]
    emit({"ok": True, "data": {sku: stock[sku] for sku in skus}, "findings": findings, "caveats": caveats})


def adjust(args):
    key = os.environ.get("OFFICEHUM_IDEMPOTENCY_KEY")
    path = adjustments_path()
    adjustments = load_adjustments()
    for index, existing in enumerate(adjustments):
        if key and existing.get("key") == key:
            finding = {"id": "adjustment:" + str(index + 1), "description": "already recorded"}
            emit({"ok": True, "data": existing, "findings": [finding], "caveats": ["This adjustment was already recorded."]})
    if args.sku not in load_stock():
        emit({"ok": False, "error": "unknown SKU: " + args.sku}, 2)
    record = {"sku": args.sku, "quantity": args.quantity, "reason": args.reason, "key": key}
    adjustments.append(record)
    with open(path, "w") as handle:
        json.dump(adjustments, handle)
    finding = {"id": "adjustment:" + str(len(adjustments)), "description": "recorded", "quantity": args.quantity}
    emit({"ok": True, "data": record, "findings": [finding], "caveats": []})


def env_names(_args):
    # Test aid: which environment variables the engine can see.
    emit({"ok": True, "data": sorted(os.environ), "findings": [], "caveats": []})


def main():
    parser = argparse.ArgumentParser(prog="engine.py")
    commands = parser.add_subparsers(dest="command", required=True)
    levels_parser = commands.add_parser("levels")
    levels_parser.add_argument("--sku")
    adjust_parser = commands.add_parser("adjust")
    adjust_parser.add_argument("--sku", required=True)
    adjust_parser.add_argument("--quantity", type=int, required=True)
    adjust_parser.add_argument("--reason", required=True)
    commands.add_parser("env-names")
    commands.add_parser("crash")
    args = parser.parse_args()
    if args.command == "crash":
        raise RuntimeError("the engine crashed")
    {"levels": levels, "adjust": adjust, "env-names": env_names}[args.command](args)


if __name__ == "__main__":
    main()
