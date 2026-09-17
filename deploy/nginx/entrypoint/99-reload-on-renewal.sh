#!/bin/sh
# Certbot renews in its own container and cannot signal this one, so nginx keeps
# serving the old certificate until something reloads it. Renewal happens at day
# 60 and expiry at day 90, so without this the site breaks a month later, long
# after anyone connects it to the deploy.
#
# It lives in /docker-entrypoint.d/ rather than in `command:` on purpose: the
# official entrypoint only runs the envsubst templating when the command starts
# with `nginx`, so overriding the command silently ships an unsubstituted config.
( while :; do sleep 12h; nginx -s reload 2>/dev/null || true; done ) &
