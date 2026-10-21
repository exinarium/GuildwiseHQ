#!/bin/bash
# the old standalone `docker-compose` program: the same fake, reached the old way
echo "docker-compose $*" >> "$FAKE_ROOT/calls.log"
FAKE_VIA_V1=1 exec docker compose "$@"
