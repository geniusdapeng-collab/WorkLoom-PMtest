#!/usr/bin/env python3
"""Count complete text/tool Chat requests with DeepSeek's official V4.1 recipe.

The process accepts one JSON object per stdin line and never receives API keys.
Install the verified package with: python -m pip install deepseek-recipe==0.2.0
The tokenizer is the official, MIT-licensed V4.1 asset, pinned by SHA-256 below.
"""
import argparse
import hashlib
import importlib.metadata
import json
import pathlib
import sys

TOKENIZER_SHA256 = "81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99"
RECIPE_VERSION = "0.2.0"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokenizer", required=True)
    args = parser.parse_args()
    if importlib.metadata.version("deepseek-recipe") != RECIPE_VERSION:
        raise RuntimeError("The budget counter requires deepseek-recipe==0.2.0")
    asset = pathlib.Path(args.tokenizer)
    if hashlib.sha256(asset.read_bytes()).hexdigest() != TOKENIZER_SHA256:
        raise RuntimeError("The V4.1 tokenizer SHA-256 does not match the pinned official asset")
    from deepseek_recipe import ChatCompletionRequest, ConversionOptions, DeepseekV41Encoding, Tokenizer
    encoding = DeepseekV41Encoding().with_tokenizer(Tokenizer.from_file(str(asset)))
    print(json.dumps({"ready": True, "recipeVersion": RECIPE_VERSION, "tokenizerSha256": TOKENIZER_SHA256}), flush=True)
    for line in sys.stdin:
        # Match the explicit proxy transport boundary. A character-count clamp
        # must not reject a legal 1M-token request before model token accounting.
        if len(line.encode("utf-8")) > 32_000_000:
            print(json.dumps({"error": "Request exceeds the explicit 32000000-byte transport limit"}), flush=True)
            continue
        try:
            body = json.loads(line)
            # Public API aliases are deliberately normalized only inside the
            # tokenizer; the outbound model remains the caller's deepseek-flash.
            body["model"] = "DeepSeek-V4.1-Flash"
            converted = ChatCompletionRequest(body).convert(ConversionOptions())
            prompt_tokens = len(encoding.encode(converted.conversation))
            print(json.dumps({"promptTokens": prompt_tokens}), flush=True)
        except Exception as error:
            # Never echo a prompt or request body on error.
            print(json.dumps({"error": type(error).__name__}), flush=True)


if __name__ == "__main__":
    main()
