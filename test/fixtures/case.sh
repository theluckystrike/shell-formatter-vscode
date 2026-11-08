#!/bin/bash
case "$1" in
start|run) echo start ;;
  stop)
echo stop
;;
*) echo "usage" >&2; exit 1;;
esac
