import re
import os
import subprocess


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def run_shell(cmd: str):
    return subprocess.run(cmd, shell=True)


def calc(expr: str):
    return eval(expr)


def never_used():
    try:
        pass
    except:
        pass
