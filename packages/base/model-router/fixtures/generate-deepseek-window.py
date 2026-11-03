#!/usr/bin/env python3
"""Regenerate/check goldens using OFFICIAL deepseek-recipe, never the TS port.

Usage: python generate-deepseek-window.py --input INPUT --output OUTPUT [--check]
Install deepseek-recipe==0.2.0 in a development-only virtualenv. Python is not
required by the application or Node test suite.
"""
import argparse
import hashlib
import importlib.metadata
import json
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
if importlib.metadata.version("deepseek-recipe") != "0.2.0":
    raise RuntimeError("Official parity generation requires deepseek-recipe==0.2.0")
from deepseek_recipe import ChatCompletionRequest, ConversionOptions, DeepseekV41Encoding, Tokenizer
asset = pathlib.Path(__file__).resolve().parents[1] / "assets/deepseek-v41/tokenizer.json"
sha = hashlib.sha256(asset.read_bytes()).hexdigest()
if sha != "81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99":
    raise RuntimeError("Official tokenizer checksum mismatch")
encoding = DeepseekV41Encoding().with_tokenizer(Tokenizer.from_file(str(asset)))
rows = json.loads(pathlib.Path(args.input).read_text())["cases"]
for row in rows:
    body = dict(row["body"])
    body["model"] = "DeepSeek-V4.1-Flash"  # Local recipe's documented canonical alias only.
    converted = ChatCompletionRequest(body).convert(ConversionOptions())
    row["officialPrompt"] = encoding.render_conversation(converted.conversation).prompt
    row["officialTokenIds"] = encoding.encode(converted.conversation)
    row["officialInputTokens"] = len(row["officialTokenIds"])
payload = {"recipeVersion": "0.2.0", "recipeCommit": "935817c66f5d6e64838f419692545f06787e485f",
           "tokenizerSha256": sha, "caseCount": len(rows), "cases": rows}
output = pathlib.Path(args.output)
if args.check:
    if json.loads(output.read_text()) != payload:
        raise RuntimeError("Official recipe no longer matches the frozen parity fixtures")
else:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"cases": len(rows), "source": "official deepseek-recipe==0.2.0", "check": args.check}))
