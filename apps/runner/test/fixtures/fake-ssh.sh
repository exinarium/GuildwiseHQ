#!/bin/bash
echo "ssh $*" >> "$FAKE_ROOT/calls.log"
cmd=""; for a in "$@"; do cmd="$a"; done
FAKE_SIDE=remote exec bash -c "$cmd"
