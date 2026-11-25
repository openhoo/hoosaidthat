#!/usr/bin/env python3
"""Recover only the immutable inputs of the qualified VoiceOver 0.1.2 release."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import zipfile


REPO = "openhoo/hoosaidthat"
REPO_ID = 1348829510
RUN = 45571274296
ATTEMPT = 1
WORKFLOW = 344133380
VERSION = "0.1.2"
TAG = "v" + VERSION
REF = "refs/tags/" + TAG
HEAD = "ae089e7fe0e42f924fb03e8137453d925e850ed6"
TAG_OBJECT = "5e61b86f1a9a92f99afc2124a6faa29a394e2649"
ENGINE = "016da2006799948947c1a74af196c9d57cb1dd31"
RUN_URL = f"https://github.com/{REPO}/actions/runs/{RUN}"
ATTEMPT_PATH = f"actions/runs/{RUN}/attempts/{ATTEMPT}"
ARCHIVES = (
    (15002926098, "release-inputs-45571274296-1", 274265,
     "76de96ac76fa667d57da3963fe36a0da8dd6e4b4ed253e133b61c9ee34067e81"),
    (15002426870, "release-buildx-metadata", 9208,
     "d85561131b86c7c212c31b0367e0d47396b35c770f1dbe77ea9cca71bed2889a"),
)
PACKAGE_SHA256 = "6b3aed62f670272d0a078167d1ac82c39bc3a91d633441ce312ff7ed46c51945"
PACKAGE_SRI = "sha512-NdAX7RC/w/JEP90hf4rdwyxcH7ABVvcKaDM05wUNlQkpQQtxg/s1vnQNdV3QxkA3tEdNaLJkdpopSP1NSP0j4Q=="
IMAGES = (
    ("engine", "hoovda-engine", "sha256:da2f78d6c4f8d3c2f5f92e8664b957bed6a7f530d56ca088eaef5af5de1b9931"),
    ("hoovda", "hoovda", "sha256:2f44b8c9f97ed2f821b750798b25998f716479fbcec4fda12f070eca51c60797"),
    ("orca", "orca", "sha256:f917023209d3ebf31cb8832d78532e889261f0291320043a7231154fa44910ed"),
)
LANES = {
    "parity-en-US-laptop-b": 139060922368, "parity-de-DE-laptop-b": 139060922379,
    "parity-de-DE-desktop-a": 139060922389, "parity-en-US-laptop-a": 139060922402,
    "parity-en-US-desktop-b": 139060922411, "parity-en-US-desktop-a": 139060922416,
    "browser-tools": 139060922436, "parity-de-DE-desktop-b": 139060922440,
    "hoovda-probe": 139060922441, "parity-de-DE-laptop-a": 139060922444,
    "hoovda-examples": 139060922470, "web-report": 139060922491,
    "orca-examples": 139060922515, "hoovda-localized": 139060922534,
}
JOBS = {
    "build": (139058248103, "success"), "qualify / plan": (139060874394, "success"),
    "publish": (139069987412, "failure"), "rehearse": (139058250063, "skipped"),
    "missing-rehearsal-candidate": (139058250253, "skipped"),
    "rehearsal-inputs": (139058250269, "skipped"),
    **{"qualify / Runtime / " + name: (job_id, "success") for name, job_id in LANES.items()},
}
NODE = "Run actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"
EXPECTED_NON_SUCCESS = {
    "publish": {
        "Promote qualified image manifests": "failure",
        "Publish npm package from GitHub Actions with provenance": "skipped",
        "Verify public npm integrity and provenance": "skipped",
        "Post " + NODE: "skipped",
    },
    "qualify / Runtime / browser-tools": {"Pull the exact candidate": "skipped"},
    "qualify / Runtime / hoovda-probe": {"Install the needed browser tools": "skipped"},
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def match(record, fields, label):
    for key, expected in fields.items():
        require(key in record and type(record[key]) is type(expected) and record[key] == expected,
                f"{label}: unexpected or missing {key}")


def gh(path):
    return subprocess.run(
        ["gh", "api", "--method", "GET", "--hostname", "github.com", f"repos/{REPO}/{path}"],
        check=True, stdout=subprocess.PIPE, timeout=90,
    ).stdout


def api(path):
    return json.loads(gh(path))


def verify_jobs(response):
    match(response, {"total_count": len(JOBS)}, "jobs")
    jobs = response["jobs"]
    require(len(jobs) == len(JOBS) and {j["name"] for j in jobs} == JOBS.keys(), "unexpected job set")
    records = []
    for job in jobs:
        name = job["name"]
        job_id, conclusion = JOBS[name]
        url = f"{RUN_URL}/job/{job_id}"
        match(job, {"id": job_id, "run_id": RUN, "run_attempt": ATTEMPT, "head_branch": TAG,
                    "head_sha": HEAD, "workflow_name": "Release", "status": "completed",
                    "conclusion": conclusion, "html_url": url}, name)
        steps = job.get("steps", [])
        require(isinstance(steps, list) and bool(steps) == (conclusion != "skipped"), f"{name}: no step evidence")
        numbers = [s["number"] for s in steps]
        require(len(set(numbers)) == len(steps), f"{name}: duplicate steps")
        expected = EXPECTED_NON_SUCCESS.get(name, {})
        actual = {}
        for step in steps:
            match(step, {"status": "completed", "conclusion": expected.get(step["name"], "success")}, name)
            if step["conclusion"] != "success":
                require(step["name"] not in actual, f"{name}: duplicate failure/skip")
                actual[step["name"]] = step["conclusion"]
        require(actual == expected, f"{name}: unexpected or missing skipped/failed steps")
        required = {
            "build": {"Validate immutable release identity", "Verify npm package", "Pack tested npm files",
                      "Build attested release candidates", "Store immutable publication inputs",
                      "Preserve Buildx attestation metadata"},
            "qualify / plan": {"Run set -euo pipefail"},
            "publish": {"Verify publication inputs", "Require unused publication destinations",
                        "Preserve release qualification and publication receipts"},
        }.get(name, set())
        if name.startswith("qualify / Runtime / "):
            required = {"Build the checked out client", "Run this lane with one reader at a time",
                        "Preserve this lane's receipts and raw test evidence"}
        require(required <= {s["name"] for s in steps if s["conclusion"] == "success"}, f"{name}: missing required step")
        records.append({"id": job_id, "name": name, "url": url, "conclusion": conclusion,
                        "nonSuccessfulSteps": actual})
    return records


def verify_attempt():
    attempt = api(ATTEMPT_PATH)
    match(attempt, {"id": RUN, "run_attempt": ATTEMPT, "run_number": 5, "name": "Release",
                    "workflow_id": WORKFLOW, "path": ".github/workflows/release.yml", "event": "workflow_dispatch",
                    "head_branch": TAG, "head_sha": HEAD, "html_url": RUN_URL,
                    "status": "completed", "conclusion": "failure"}, "original attempt")
    for field in ("repository", "head_repository"):
        match(attempt[field], {"id": REPO_ID, "full_name": REPO}, field)
    ref = api("git/ref/tags/" + TAG)
    match(ref, {"ref": REF}, "tag ref")
    match(ref["object"], {"type": "tag", "sha": TAG_OBJECT}, "tag object")
    tag = api("git/tags/" + TAG_OBJECT)
    match(tag, {"tag": TAG, "sha": TAG_OBJECT}, "annotated tag")
    match(tag["verification"], {"verified": True, "reason": "valid"}, "release tag signature")
    match(tag["object"], {"type": "commit", "sha": HEAD}, "tag target")
    return verify_jobs(api(ATTEMPT_PATH + "/jobs?per_page=100"))


def fetch_archive(pin, names):
    artifact_id, name, size, sha = pin
    path = f"actions/artifacts/{artifact_id}"
    artifact = api(path)
    match(artifact, {"id": artifact_id, "name": name, "expired": False, "size_in_bytes": size,
                     "digest": "sha256:" + sha,
                     "archive_download_url": f"https://api.github.com/repos/{REPO}/{path}/zip"}, name)
    match(artifact["workflow_run"], {"id": RUN, "repository_id": REPO_ID,
          "head_repository_id": REPO_ID, "head_branch": TAG, "head_sha": HEAD}, name + " owner")
    raw = gh(path + "/zip")
    require(len(raw) == size and hashlib.sha256(raw).hexdigest() == sha, name + ": unexpected archive bytes")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        require(len(members) == len(names) and {i.filename for i in members} == names, name + ": unexpected entries")
        require(all(i.orig_filename == i.filename and stat.S_ISREG(i.external_attr >> 16)
                    and i.flag_bits & 1 == 0 and 0 < i.file_size <= 300_000 for i in members), name + ": invalid member")
        files = {i.filename: archive.read(i) for i in members}
    return files, {k: artifact[k] for k in ("id", "name", "size_in_bytes", "digest", "workflow_run")}


def verify_inputs(files, metadata):
    package = files["package.tgz"]
    sri = "sha512-" + base64.b64encode(hashlib.sha512(package).digest()).decode("ascii")
    require(len(package) == 273637 and hashlib.sha256(package).hexdigest() == PACKAGE_SHA256 and sri == PACKAGE_SRI,
            "package.tgz does not match the qualified candidate")
    with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
        manifests = [m for m in archive.getmembers() if m.name == "package/package.json"]
        require(len(manifests) == 1 and manifests[0].isreg() and 0 < manifests[0].size <= 200_000, "invalid npm manifest")
        with archive.extractfile(manifests[0]) as manifest:
            match(json.load(manifest), {"name": "@openhoo/hoosaidthat", "version": VERSION}, "package.json")
    images = []
    for key, suffix, digest in IMAGES:
        image = "ghcr.io/openhoo/hoosaidthat-" + suffix
        candidate = f"{image}:candidate-{HEAD}-{RUN}-{ATTEMPT}"
        record = json.loads(metadata[suffix + "-metadata.json"])
        match(record, {"containerimage.digest": digest, "image.name": candidate}, suffix)
        match(record["containerimage.descriptor"], {"digest": digest, "mediaType": "application/vnd.oci.image.index.v1+json"}, suffix)
        images.append({"name": key, "candidateTag": candidate, "reference": image + "@" + digest,
                       "digest": digest, "versionTag": image + ":" + VERSION})
    candidates = json.loads(files["release-candidates.json"])
    expected = {"schemaVersion": 1, "repository": REPO, "sourceRef": REF, "sourceCommit": HEAD,
                "companionRepository": "openhoo/hoovda", "companionCommit": ENGINE, "version": VERSION,
                "run": {"id": str(RUN), "attempt": str(ATTEMPT), "url": RUN_URL}, "images": images}
    require(candidates == expected, "candidate manifest does not match the qualified release")


def recover(output):
    require(not os.path.lexists(output), "output already exists")
    jobs = verify_attempt()
    files, inputs = fetch_archive(ARCHIVES[0], {"package.tgz", "release-candidates.json"})
    meta, build = fetch_archive(ARCHIVES[1], {suffix + "-metadata.json" for _, suffix, _ in IMAGES})
    verify_inputs(files, meta)
    evidence = {"repository": REPO, "sourceRef": REF, "sourceCommit": HEAD, "tagObject": TAG_OBJECT,
                "companionCommit": ENGINE, "workflowId": WORKFLOW, "runId": RUN, "runAttempt": ATTEMPT,
                "runUrl": RUN_URL, "jobs": jobs, "artifacts": [inputs, build],
                "package": {"size": len(files["package.tgz"]), "sha256": PACKAGE_SHA256, "integrity": PACKAGE_SRI}}
    files["qualification.json"] = (json.dumps(evidence, indent=2) + "\n").encode()
    output.mkdir(mode=0o700)
    try:
        for name, data in files.items():
            with (output / name).open("xb") as target:
                target.write(data)
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: verify-recovery-012.py NEW_OUTPUT_DIRECTORY")
    try:
        recover(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError, zipfile.BadZipFile, subprocess.SubprocessError) as exc:
        sys.exit(f"0.1.2 release verification failed: {exc}")
    print(f"Verified run {RUN} attempt {ATTEMPT}, both original artifacts, and @openhoo/hoosaidthat@{VERSION}.")
