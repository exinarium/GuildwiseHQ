#!/bin/bash
# The new app answers when it is "up" and not marked unhealthy.
[ -f "$FAKE_STATE/up-app" ] && [ ! -f "$FAKE_STATE/unhealthy" ]
