#!/usr/bin/env python3
"""Собирает src/* в один файл: dist/pult.html (открывать в браузере) и
dist/pult-artifact.html (то же без doctype, для публикации)."""
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
ORDER = ["core.js", "transports.js", "sims.js", "drivers.js", "wm.js", "widgets.js", "spectrum.js", "panels.js", "tinysa.js", "app.js"]


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return f.read()


def main():
    js = "\n".join(re.sub(r"^'use strict';\n", "", read(n)) for n in ORDER)
    shell = read("shell.html").replace("/*CSS*/", read("style.css")).replace("/*JS*/", "'use strict';\n" + js)
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    full = '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    head, _, rest = shell.partition("<header")
    with open(os.path.join(ROOT, "dist", "pult.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(full + head + "</head>\n<body>\n<header" + rest + "</body>\n</html>\n")
    with open(os.path.join(ROOT, "dist", "pult-artifact.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(shell)
    print("pult.html", os.path.getsize(os.path.join(ROOT, "dist", "pult.html")), "bytes")


if __name__ == "__main__":
    main()
