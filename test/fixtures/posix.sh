#!/bin/sh
set -e
usage() { echo "usage: $0 file" >&2; exit 1; }
[ $# -eq 1 ] || usage
while IFS= read -r line;do
  case $line in \#*) continue;; esac
printf '%s\n' "$line"
done < "$1"
