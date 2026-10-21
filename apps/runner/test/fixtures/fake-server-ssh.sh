#!/bin/bash
# A fake `ssh` for the move tests: the last-but-one argument is the alias (after `--`), its state folder is $FAKE_SERVERS/<alias>.
# The remote command runs locally with FAKE_STATE set, stdin and stdout passed through. Nothing leaves this computer.
echo "ssh $*" >> "$FAKE_SERVERS/calls.log"
args=("$@"); n=${#args[@]}
cmd=${args[$((n - 1))]}; alias=${args[$((n - 2))]}
[ "${args[$((n - 3))]}" = -- ] || { echo "fake ssh: unexpected arguments" >&2; exit 255; }
if [ -f "$FAKE_SERVERS/down-$alias" ]; then echo "ssh: connect to host $alias port 22: Connection refused" >&2; exit 255; fi
mkdir -p "$FAKE_SERVERS/$alias"
FAKE_STATE="$FAKE_SERVERS/$alias" exec sh -c "$cmd"
