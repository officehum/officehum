"""The isolated Paper document worker.

It runs one bounded document operation and prints exactly one JSON object on stdout. It has no agent
loop, no model client and no conversation state: the host sends a request, the worker answers, and
anything durable belongs to the service that started it.

What it does, in order:

1. Reads the request, then sets ``RLIMIT_CPU``, ``RLIMIT_FSIZE`` and (best effort) ``RLIMIT_AS``.
2. Verifies the three Paper sentinels — ``paper_docx_doctor``, ``paper_pptx_doctor``,
   ``paper_xlsx_doctor`` — and refuses if any of them does not own the installed module. This is the
   gate that keeps a fork and its upstream package from ever being importable together.
3. Verifies every leased input against the hash the lease pinned, refuses a symlink, and makes the
   input copies read-only.
4. Installs the in-process guards, binds the workspace API to this lease, and executes the submitted
   code with a restricted ``__builtins__``.
5. Collects the declared outputs, refuses anything undeclared, over the byte allowance, over the
   file-count allowance or a symlink, re-hashes the inputs to prove they are untouched, and reopens
   every output with its pinned library.

**What is enforced, and what is not.** The subprocess, the scrubbed environment, the rlimits, the
lease-scoped workspace API, the import guard and the socket guard are all enforced here, in process,
and the tests exercise each of them. They are *not* a security boundary against a determined
snippet: a ``ctypes`` call can reach libc ``socket()``, and a Python-level guard cannot confine the
filesystem at all — ``io.open`` and ``pathlib`` are shared with the libraries and cannot be replaced
without breaking them. The container profile in RASF-3111 (still Backlog) is what makes those
boundaries load-bearing: no egress, read-only mounts, and only the lease's directories visible. Until
it lands this worker must be treated as a *bounded workspace*, not a sandbox, and that limit is
recorded in every response and every receipt.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import signal
import stat
import sys
import traceback

PROTOCOL = "officehum.paper-worker/1"
CAPTURE_LIMIT = 8 * 1024
MESSAGE_LIMIT = 400
INPUT_NAME_BYTES_MAX = 255
MAX_OUTPUTS = 256

DOCTORS = {
    "docx": "paper_docx_doctor",
    "pptx": "paper_pptx_doctor",
    "xlsx": "paper_xlsx_doctor",
}
MODULES = {"docx": "docx", "pptx": "pptx", "xlsx": "openpyxl"}
FSIZE_FLOOR = 1024 * 1024
EFBIG = 27


class Refusal(Exception):
    """A typed, inspectable refusal. ``code`` is a stable reason the host records unchanged."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RunTimeout(Exception):
    """Raised by the wall-clock alarm inside submitted code."""


def main(argv: list[str]) -> int:
    enforcement: dict = {"limits": {}}
    notes: list[str] = []
    try:
        request = load_request(parse_args(argv))
        apply_limits(request["limits"], enforcement, notes)
        identity = check_sentinels(request["libraries"])
        staged = stage_inputs(request)
        enforcement.update(
            {
                "worker": "subprocess",
                "environment": "scrubbed",
                "home": "removed",
                "network": "python-socket-guard",
                "process": "python-import-and-os-guard",
                "filesystem": "lease-scoped-staging",
            }
        )
        notes.append(
            "network and filesystem confinement are Python-level guards only; the container profile "
            "(RASF-3111) is what makes them load-bearing"
        )
        response = run(request, staged, identity, enforcement, notes)
    except RunTimeout:
        return emit(
            {
                "ok": False,
                "code": "timeout",
                "message": "the run exceeded its wall-clock budget",
                "enforcement": enforcement,
            }
        )
    except Refusal as error:
        return emit(
            {
                "ok": False,
                "code": error.code,
                "message": error.message,
                "enforcement": enforcement,
            }
        )
    except MemoryError:
        return emit(
            {
                "ok": False,
                "code": "memory-limit",
                "message": "the run exceeded its memory allowance",
                "enforcement": enforcement,
            }
        )
    except BaseException as error:  # noqa: BLE001 - a crash must still be a stable refusal
        return emit(
            {
                "ok": False,
                "code": "worker-crash",
                "message": f"{type(error).__name__}: {str(error)[:MESSAGE_LIMIT]}",
                "enforcement": enforcement,
            }
        )
    return emit(response)


def parse_args(argv: list[str]) -> str:
    if len(argv) != 2 or argv[0] != "--request":
        raise Refusal("invalid-request", "usage: worker.py --request <path>")
    return argv[1]


def load_request(path: str) -> dict:
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as error:
        raise Refusal("invalid-request", f"the request could not be read: {error}") from error
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise Refusal("invalid-request", f"the request is not JSON: {error}") from error
    if not isinstance(request, dict) or request.get("protocol") != PROTOCOL:
        raise Refusal("invalid-request", f"the request is not a {PROTOCOL} request")
    for key in (
        "operationId",
        "code",
        "arguments",
        "libraries",
        "inputs",
        "inputsDir",
        "staging",
        "outputFormats",
        "limits",
    ):
        if key not in request:
            raise Refusal("invalid-request", f"the request is missing {key}")
    if not isinstance(request["code"], str) or request["code"].strip() == "":
        raise Refusal("invalid-request", "the request carries no code")
    if not isinstance(request["arguments"], dict):
        raise Refusal("invalid-request", "the request arguments must be an object")
    if not isinstance(request["inputs"], list):
        raise Refusal("invalid-request", "the request inputs must be a list")
    return request


def apply_limits(limits: dict, enforcement: dict, notes: list[str]) -> None:
    """Kernel-enforced budgets. A limit the platform refuses is reported, never silently skipped."""
    import resource  # imported here so little else is loaded once the limits can bite

    applied: dict[str, bool] = {}

    def set_limit(name: int, soft: int, hard: int, label: str) -> None:
        try:
            resource.setrlimit(name, (soft, hard))
            applied[label] = True
        except (ValueError, OSError) as error:
            applied[label] = False
            notes.append(f"the {label} limit is not enforced on this platform: {error}")

    cpu = int(limits["cpuSeconds"])
    set_limit(resource.RLIMIT_CPU, cpu, cpu + 1, "cpu")
    file_size = max(int(limits["outputBytes"]), FSIZE_FLOOR)
    set_limit(resource.RLIMIT_FSIZE, file_size, file_size, "fileSize")
    memory = int(limits["memoryBytes"])
    set_limit(resource.RLIMIT_AS, memory, memory, "memory")
    set_limit(resource.RLIMIT_CORE, 0, 0, "core")
    enforcement["limits"] = applied
    sys.dont_write_bytecode = True


def check_sentinels(pins: dict) -> dict:
    """Refuses unless the running interpreter is the pin's isolated Paper worker environment."""
    if sys.version_info[:2] != (3, 13):
        raise Refusal(
            "interpreter-version",
            "the document worker needs Python 3.13 and got "
            f"{sys.version_info.major}.{sys.version_info.minor}",
        )
    modules: dict[str, str] = {}
    for format_, module_name in DOCTORS.items():
        expected = pins.get(f"paper-{format_}")
        if not isinstance(expected, str) or expected == "":
            raise Refusal("invalid-request", f"the request pins no paper-{format_} version")
        try:
            doctor = importlib.import_module(module_name)
        except Exception as error:  # noqa: BLE001 - a missing sentinel is a refusal, not a crash
            raise Refusal(
                "doctor-missing",
                f"{module_name} is not installed, so this is not the pinned Paper worker "
                f"environment: {error}",
            ) from error
        try:
            version = doctor.verify_install()
        except Exception as error:  # noqa: BLE001 - DoctorError means the fork does not own it
            raise Refusal(
                "doctor-failed",
                f"{module_name} refused the installed module: {error}",
            ) from error
        if version != expected:
            raise Refusal(
                "doctor-failed",
                f"{module_name} verified {version} where the pin is {expected}",
            )
        modules[f"paper-{format_}:dist"] = version
    for module_name in MODULES.values():
        module = importlib.import_module(module_name)
        version = getattr(module, "__version__", None)
        modules[module_name] = str(version) if version else "unknown"
    return {"python": "{0}.{1}.{2}".format(*sys.version_info[:3]), "modules": modules}


def stage_inputs(request: dict) -> dict:
    """Verifies each leased input against the lease's hash and makes the copies read-only."""
    inputs_dir = os.path.realpath(request["inputsDir"])
    staged: dict[str, dict] = {}
    for leased in request["inputs"]:
        if not isinstance(leased, dict):
            raise Refusal("invalid-lease", "the request lists an unusable input")
        name = leased.get("name")
        if (
            not isinstance(name, str)
            or name in ("", ".", "..")
            or "/" in name
            or "\\" in name
            or len(name.encode("utf-8")) > INPUT_NAME_BYTES_MAX
            or any(ord(character) < 32 for character in name)
        ):
            raise Refusal("traversal", f"the lease names an unusable input: {name!r}")
        path = os.path.realpath(os.path.join(inputs_dir, name))
        if os.path.dirname(path) != inputs_dir:
            raise Refusal("traversal", f"the lease names an input outside its directory: {name!r}")
        try:
            info = os.lstat(path)
        except OSError as error:
            raise Refusal(
                "input-integrity", f"the staged input {name!r} is missing: {error}"
            ) from error
        if stat.S_ISLNK(info.st_mode):
            raise Refusal("symlink", f"the staged input {name!r} is a symbolic link")
        if not stat.S_ISREG(info.st_mode):
            raise Refusal("input-integrity", f"the staged input {name!r} is not a regular file")
        if info.st_size != leased.get("size") or digest(path) != leased.get("sha256"):
            raise Refusal(
                "input-integrity",
                f"the staged input {name!r} does not match the hash the lease pinned",
            )
        version_id = leased.get("versionId")
        if not isinstance(version_id, str) or version_id in staged:
            raise Refusal("invalid-lease", "the request lists an unusable input version")
        staged[version_id] = {
            "versionId": version_id,
            "fileId": leased.get("fileId"),
            "name": name,
            "format": leased.get("format"),
            "size": leased.get("size"),
            "sha256": leased.get("sha256"),
            "writable": bool(leased.get("writable")),
            "path": path,
        }
    # A speed bump, not a boundary: the same user could chmod them back. The hash check after the
    # run is the evidence, and the container profile is the boundary.
    try:
        for entry in staged.values():
            os.chmod(entry["path"], 0o400)
    except OSError:
        pass
    return staged


def run(request: dict, staged: dict, identity: dict, enforcement: dict, notes: list[str]) -> dict:
    import officehum_documents as documents

    session = documents._configure(
        staged,
        request["staging"],
        request["outputFormats"],
        request["limits"],
        dict(request["arguments"]),
    )
    install_guards()

    capture = _Capture()
    stdout, stderr = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = capture, capture
    install_wall_clock(int(request["limits"]["wallSeconds"]))
    try:
        try:
            code = compile(request["code"], "<submitted>", "exec")
        except SyntaxError as error:
            raise Refusal("code-syntax", f"line {error.lineno}: {error.msg}") from error
        exec(code, submitted_globals(documents))  # noqa: S102 - the point of the workspace
    except RunTimeout:
        raise
    except documents.WorkspaceError as error:
        raise Refusal(error.code, str(error)) from error
    except Refusal:  # the network and process guards raise this from inside submitted code
        raise
    except MemoryError:
        raise
    except OSError as error:
        if error.errno == EFBIG:  # RLIMIT_FSIZE: the per-file allowance
            raise Refusal(
                "file-size-limit", "a written file exceeded the per-file size allowance"
            ) from error
        raise Refusal("code-error", describe(error)) from error
    except BaseException as error:  # noqa: BLE001 - the snippet failed; report it as a refusal
        raise Refusal("code-error", describe(error)) from error
    finally:
        cancel_wall_clock()
        sys.stdout, sys.stderr = stdout, stderr

    verify_sources(staged)
    outputs = collect_outputs(session, request["limits"])
    reopened = reopen(outputs, request["staging"])
    return {
        "protocol": PROTOCOL,
        "ok": True,
        "operationId": request["operationId"],
        "python": identity["python"],
        "modules": identity["modules"],
        "reads": list(session.reads),
        "outputs": outputs,
        "reopen": reopened,
        "result": session.result_value if session.result_declared else None,
        "resultDeclared": session.result_declared,
        "stdout": capture.tail(),
        "enforcement": enforcement,
        "notes": notes,
    }


def verify_sources(staged: dict) -> None:
    """Sources must be byte-identical after the run: a refusal or a crash leaves them untouched."""
    for entry in staged.values():
        try:
            info = os.lstat(entry["path"])
        except OSError as error:
            raise Refusal(
                "source-integrity", f"input {entry['name']!r} disappeared during the run: {error}"
            ) from error
        if stat.S_ISLNK(info.st_mode) or digest(entry["path"]) != entry["sha256"]:
            raise Refusal(
                "source-integrity",
                f"input {entry['name']!r} was modified during the run; a lease grants read-only "
                "inputs and staging outputs",
            )


def collect_outputs(session, limits: dict) -> list[dict]:
    """Only declared outputs, only regular files, only inside staging."""
    staging = os.path.realpath(session.staging)
    found: dict[str, str] = {}
    for entry in os.scandir(staging):
        try:
            info = os.lstat(entry.path)
        except OSError as error:
            raise Refusal("undeclared-output", f"staging entry {entry.name!r} vanished: {error}")
        if stat.S_ISLNK(info.st_mode):
            raise Refusal("symlink", f"staging entry {entry.name!r} is a symbolic link")
        if not stat.S_ISREG(info.st_mode):
            raise Refusal(
                "undeclared-output", f"staging entry {entry.name!r} is not a regular file"
            )
        if entry.name not in session.outputs:
            raise Refusal(
                "undeclared-output",
                f"{entry.name!r} was written but never declared; declare it with "
                "documents.declare_output(name, format)",
            )
        found[entry.name] = entry.path

    outputs: list[dict] = []
    total = 0
    for name, declared in session.outputs.items():
        path = found.get(name)
        if path is None:
            raise Refusal(
                "missing-output",
                f"{name!r} was declared but never written; a declared output must exist",
            )
        size = os.lstat(path).st_size
        total += size
        if total > int(limits["outputBytes"]):
            raise Refusal(
                "output-bytes",
                f"declared outputs exceed the {limits['outputBytes']} byte allowance",
            )
        if os.path.dirname(os.path.realpath(path)) != staging:
            raise Refusal("traversal", f"{name!r} escaped the staging directory")
        outputs.append(
            {
                "name": name,
                "format": declared.format,
                "size": size,
                "sha256": digest(path),
                "editOf": declared.edit_of,
            }
        )
    if len(outputs) > min(int(limits["fileCount"]), MAX_OUTPUTS):
        raise Refusal("file-count", f"more than {limits['fileCount']} files were declared")
    return outputs


def reopen(outputs: list[dict], staging: str) -> list[str]:
    """Reopens every output with its pinned library: the check the design wants before a commit."""
    import docx
    import openpyxl
    import pptx

    witnesses: list[str] = []
    for output in outputs:
        path = os.path.join(staging, output["name"])
        try:
            if output["format"] == "docx":
                document = docx.Document(path)
                witnesses.append(f"{output['name']}: {len(document.paragraphs)} paragraphs")
            elif output["format"] == "pptx":
                presentation = pptx.Presentation(path)
                witnesses.append(f"{output['name']}: {len(presentation.slides)} slides")
            else:
                workbook = openpyxl.load_workbook(path, data_only=False)
                sheets = len(workbook.sheetnames)
                workbook.close()
                witnesses.append(f"{output['name']}: {sheets} sheets")
        except Exception as error:  # noqa: BLE001 - an unopenable output is a refusal
            raise Refusal(
                "output-invalid",
                f"{output['name']!r} could not be reopened with {output['format']}: "
                f"{type(error).__name__}: {str(error)[:MESSAGE_LIMIT]}",
            ) from error
    return witnesses


def install_wall_clock(seconds: int) -> None:
    def expired(_signum, _frame):
        raise RunTimeout()

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, float(seconds))


def cancel_wall_clock() -> None:
    signal.setitimer(signal.ITIMER_REAL, 0)


def install_guards() -> None:
    block_network()
    block_process()


def block_network() -> None:
    """Blocks the common outbound paths in process.

    Honest limit: ``ctypes`` can call libc ``socket()`` directly, and a reference smuggled out of a
    library would bypass this. The import guard keeps ``ctypes`` and ``socket`` away from submitted
    code, and the container profile (RASF-3111) is what denies egress for real.
    """
    import socket

    def deny(*_args, **_kwargs):
        raise Refusal("network", "network access is not available in the document workspace")

    for name in (
        "socket",
        "socketpair",
        "create_connection",
        "create_server",
        "getaddrinfo",
        "gethostbyname",
        "gethostbyname_ex",
        "gethostbyaddr",
    ):
        if hasattr(socket, name):
            setattr(socket, name, deny)
    try:  # noqa: SIM105 - unrelated internals may use the C module, so failures are ignored
        import _socket

        for name in ("socket", "socketpair", "create_connection"):
            if hasattr(_socket, name):
                setattr(_socket, name, deny)
    except Exception:  # noqa: BLE001 - the pure-Python module is already closed
        pass


def block_process() -> None:
    """Blocks process creation and the shell in process; the import guard keeps the modules out."""
    import os as os_module

    def deny(*_args, **_kwargs):
        raise Refusal("process", "document code cannot start a process or a shell")

    for name in (
        "system",
        "popen",
        "fork",
        "forkpty",
        "execv",
        "execve",
        "execvp",
        "execvpe",
        "execl",
        "execle",
        "execlp",
        "execlpe",
        "spawnv",
        "spawnve",
        "spawnvp",
        "spawnvpe",
        "spawnl",
        "spawnle",
        "spawnlp",
        "spawnlpe",
        "posix_spawn",
        "posix_spawnp",
    ):
        if hasattr(os_module, name):
            setattr(os_module, name, deny)


ALLOWED_IMPORTS = frozenset(
    {
        "officehum_documents",
        "word_adapter",
        "pptx_adapter",
        "xlsx_adapter",
        "docx",
        "pptx",
        "openpyxl",
        "base64",
        "binascii",
        "bisect",
        "calendar",
        "collections",
        "colorsys",
        "contextlib",
        "copy",
        "csv",
        "dataclasses",
        "datetime",
        "decimal",
        "difflib",
        "enum",
        "fnmatch",
        "fractions",
        "functools",
        "gzip",
        "hashlib",
        "heapq",
        "html",
        "io",
        "itertools",
        "json",
        "keyword",
        "math",
        "numbers",
        "operator",
        "pathlib",
        "posixpath",
        "pprint",
        "random",
        "re",
        "statistics",
        "string",
        "struct",
        "textwrap",
        "time",
        "types",
        "typing",
        "unicodedata",
        "uuid",
        "warnings",
        "weakref",
        "xml",
        "zipfile",
        "zlib",
    }
)

DENIED_IMPORTS = frozenset(
    {
        "asyncio",
        "builtins",
        "ctypes",
        "ensurepip",
        "ftplib",
        "http",
        "importlib",
        "marshal",
        "multiprocessing",
        "os",
        "pickle",
        "pip",
        "resource",
        "shelve",
        "signal",
        "site",
        "smtplib",
        "socket",
        "sqlite3",
        "subprocess",
        "sys",
        "telnetlib",
        "urllib",
        "webbrowser",
        "_ctypes",
        "_socket",
    }
)

PROCESS_IMPORTS = frozenset({"ctypes", "subprocess", "multiprocessing", "_ctypes"})
NETWORK_IMPORTS = frozenset(
    {"asyncio", "ftplib", "http", "smtplib", "socket", "ssl", "telnetlib", "urllib", "webbrowser", "_socket"}
)


def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002
    """The only ``__import__`` submitted code has: no network, no process, no host introspection."""
    if level != 0:
        raise Refusal("invalid-request", "relative imports are not available in the workspace")
    root = name.split(".")[0]
    if root in DENIED_IMPORTS:
        if root in PROCESS_IMPORTS:
            code = "process"
        elif root in NETWORK_IMPORTS:
            code = "network"
        else:
            code = "invalid-request"
        raise Refusal(code, f"the document workspace does not provide {root!r}")
    if root not in ALLOWED_IMPORTS:
        raise Refusal(
            "invalid-request",
            f"the document workspace does not provide {root!r}; it provides the Paper libraries "
            "and their dependencies",
        )
    module = importlib.import_module(name)
    return module if fromlist else importlib.import_module(root)


BUILTIN_NAMES = (
    "abs all any ascii bin bool bytearray bytes callable chr classmethod complex delattr dict dir "
    "divmod enumerate filter float format frozenset getattr globals hasattr hash hex id int "
    "isinstance issubclass iter len list locals map max memoryview min next object oct ord pow "
    "print property range repr reversed round set setattr slice sorted staticmethod str sum super "
    "tuple type zip"
).split()

BUILTIN_EXCEPTIONS = (
    "ArithmeticError AssertionError AttributeError BaseException BufferError EOFError Exception "
    "FileExistsError FileNotFoundError FloatingPointError ImportError IndexError IsADirectoryError "
    "KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError "
    "NotADirectoryError NotImplemented NotImplementedError OSError OverflowError PermissionError "
    "RecursionError ReferenceError RuntimeError StopIteration SyntaxError SystemExit TimeoutError "
    "True False TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError "
    "ValueError ZeroDivisionError"
).split()


def submitted_builtins() -> dict:
    import builtins as real

    namespace: dict = {"__import__": guarded_import, "__build_class__": real.__build_class__}
    for name in BUILTIN_NAMES + BUILTIN_EXCEPTIONS:
        if hasattr(real, name):
            namespace[name] = getattr(real, name)
    # Deliberately absent: open (use the workspace API), eval/exec/compile (each would inject the
    # real builtins into whatever globals it is handed), input, breakpoint, exit, quit, vars.
    return namespace


def submitted_globals(documents) -> dict:
    return {
        "__name__": "__submitted__",
        "__doc__": None,
        "__builtins__": submitted_builtins(),
        "documents": documents,
    }


def describe(error: BaseException) -> str:
    detail = str(error) or traceback.format_exception_only(type(error), error)[-1].strip()
    return f"{type(error).__name__}: {detail[:MESSAGE_LIMIT]}"


class _Capture:
    """Collects submitted code's output so it can never corrupt the worker's JSON answer."""

    def __init__(self) -> None:
        self.chunks: list[str] = []
        self.total = 0

    def write(self, text) -> int:
        if not isinstance(text, str):
            text = str(text)
        self.total += len(text)
        self.chunks.append(text)
        if self.total > CAPTURE_LIMIT * 4:
            self.chunks = self.chunks[-8:]
            self.total = sum(len(chunk) for chunk in self.chunks)
        return len(text)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    def tail(self) -> str:
        return "".join(self.chunks)[-CAPTURE_LIMIT:]


def digest(path: str) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def emit(response: dict) -> int:
    payload = {"protocol": PROTOCOL, **response}
    sys.__stdout__.write(json.dumps(payload) + "\n")
    sys.__stdout__.flush()
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))