#!/usr/bin/env python3
"""Drop the layers the server already has from an unpacked `docker save`.

Usage: thin_images.py SAVE_DIR SERVER_LAYERS

SERVER_LAYERS holds one line per image on the server: its layer diff_ids
(`docker image inspect -f '{{join .RootFS.Layers " "}}'`). A local image's
layers up to its longest common prefix with any of those lines already exist
there as the same chain, and the server's `docker load` (classic overlay2
image store) never opens their files, so their blobs are deleted here.
Configs, manifests and every later layer stay. Prints "kept/total" bytes.

The deploy falls back to the full archive if the server rejects the thin one
(e.g. after a switch to the containerd image store, which wants every blob).
"""
import json
import os
import sys


def main() -> int:
    root, server_file = sys.argv[1], sys.argv[2]
    with open(server_file, encoding="utf-8") as f:
        server = [line.split() for line in f if line.strip()]
    with open(os.path.join(root, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)

    keep, layers = set(), set()
    for entry in manifest:
        with open(os.path.join(root, entry["Config"]), encoding="utf-8") as f:
            diff_ids = json.load(f)["rootfs"]["diff_ids"]
        paths = entry["Layers"]
        if len(diff_ids) != len(paths):
            return fail("layer count mismatch in " + entry["Config"])
        have = 0
        for ids in server:
            n = 0
            while n < min(len(ids), len(diff_ids)) and ids[n] == diff_ids[n]:
                n += 1
            have = max(have, n)
        layers.update(paths)
        keep.update(paths[have:])

    total = kept = 0
    for p in layers:
        path = os.path.join(root, p)
        size = os.path.getsize(path)
        total += size
        if p in keep:
            kept += size
        else:
            os.remove(path)
    print(f"{kept}/{total}")
    return 0


def fail(msg: str) -> int:
    print("thin_images: " + msg, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
