"""Check the order smoke by transcribing only the finished MP4's first audio track."""
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# Official whisper.cpp v1.9.6 and its public English base model. Pin the upstream
# revisions and the bytes; no package manager, service credentials, or ASR prompt.
ENGINE = "96ec4d9823e9d0211944172da35f9f29134af990"
ENGINE_SHA = "4d46e659151f31535b3947e322a58b0c604d3cbe93dfb284294e989a19d25ad7"
MODEL = "5359861c739e955e79d9a303bcbc70fb988958b1"
MODEL_SHA = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
PHRASES = ["order summary", "confirm order", "receipt ready"]


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(*args):
    subprocess.run(args, check=True)


def download(url, path, expected):
    run("curl", "--fail", "--location", "--silent", "--show-error", "--retry", "3",
        "--connect-timeout", "15", "--max-time", "180", "--output", path, url)
    if digest(path) != expected:
        raise ValueError(f"Unexpected SHA-256 for {path.name}")


def prepare(tmp):
    archive, model = tmp / "source.tar.gz", tmp / "ggml-base.en.bin"
    download(f"https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/{ENGINE}", archive, ENGINE_SHA)
    download(f"https://huggingface.co/ggerganov/whisper.cpp/resolve/{MODEL}/ggml-base.en.bin", model, MODEL_SHA)
    source, build = tmp / "source", tmp / "build"
    source.mkdir()
    run("tar", "-xzf", archive, "-C", source, "--strip-components", "1")
    run("cmake", "-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DGGML_METAL=OFF",
        "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF")
    run("cmake", "--build", build, "--target", "whisper-cli", "--parallel", "4")
    return build / "bin/whisper-cli", model


def check_speech(movie, tmp, cli, model, receipt):
    receipt["movieSha256"] = digest(movie)
    wav, prefix = tmp / "input.wav", tmp / "asr"
    run("ffmpeg", "-nostdin", "-v", "error", "-i", movie, "-map", "0:a:0", "-ac", "1",
        "-ar", "16000", "-c:a", "pcm_s16le", wav)
    run(cli, "-ng", "-m", model, "-l", "en", "-t", "4", "-oj", "-of", prefix, wav)
    segments = json.loads(prefix.with_suffix(".json").read_text())["transcription"]
    receipt["segments"] = [{"text": s["text"].strip(), "offsetsMs": s["offsets"]} for s in segments]
    text = " " + " ".join(re.findall(r"[a-z0-9]+", " ".join(s["text"] for s in segments).lower())) + " "
    cursor = 0
    for phrase in PHRASES:
        start = text.find(" " + phrase + " ", cursor)
        if start == -1:
            raise ValueError(f"MP4 audio did not contain '{phrase}' at the expected point in the sequence")
        receipt["matchedInOrder"].append(phrase)
        cursor = start + 1 + len(phrase)


def verify(parent):
    receipt = {"passed": False, "engineCommit": ENGINE, "engineSourceSha256": ENGINE_SHA,
               "model": "ggml-base.en.bin", "modelRevision": MODEL, "modelSha256": MODEL_SHA,
               "expectedInOrder": PHRASES, "matchedInOrder": []}
    try:
        movies = list(parent.glob("run-*/recording.mp4"))
        if len(movies) != 1:
            raise ValueError(f"Expected one new run-*/recording.mp4, found {len(movies)}")
        movie = movies[0]
        receipt["movie"] = str(movie.relative_to(parent))
        with tempfile.TemporaryDirectory() as work:
            tmp = Path(work)
            cli, model = prepare(tmp)
            check_speech(movie, tmp, cli, model, receipt)
        receipt["passed"] = True
        print("Heard in the MP4: " + " → ".join(receipt["matchedInOrder"]))
    except Exception as error:
        receipt["error"] = str(error)
        raise
    finally:
        (parent / "acoustic-verification.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    verify(Path(sys.argv[1]))
