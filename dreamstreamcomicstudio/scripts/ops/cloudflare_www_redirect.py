#!/usr/bin/env python3
"""Keep www.dreamstreamstudio.ai → dreamstreamstudio.ai a 301 that keeps the path + query.

Seen 2026-10-22: a zone redirect answered every www URL with a 302 to the bare root, so
shared www links (events, nurseries, auth links) lost where they pointed. This script makes
the zone's Single Redirect rule the source of truth (idempotent):

  (http.host eq "www.dreamstreamstudio.ai")
    → 301 concat("https://dreamstreamstudio.ai", http.request.uri.path), query string kept

It also points any www "Forwarding URL" Page Rule at the same place (Page Rules can't be
ordered against Single Redirects reliably, so both must agree) and prints any Bulk
Redirect entries for www so a stale one is visible. Stdlib only; reads CLOUDFLARE_API_TOKEN
(and CLOUDFLARE_ACCOUNT_ID for the Bulk Redirect listing). Nothing else in the zone is
touched. Exit code 1 means the token can't do it — the log says which permission is missing.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
ZONE = "dreamstreamstudio.ai"
HOST = f"www.{ZONE}"
APEX = f"https://{ZONE}"
PHASE = "http_request_dynamic_redirect"
DESCRIPTION = "www → apex (301, keep path + query)"
RULE = {
    "description": DESCRIPTION,
    "expression": f'(http.host eq "{HOST}")',
    "action": "redirect",
    "action_parameters": {
        "from_value": {
            "status_code": 301,
            "target_url": {"expression": f'concat("{APEX}", http.request.uri.path)'},
            "preserve_query_string": True,
        }
    },
    "enabled": True,
}

TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")


def call(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            payload = json.loads(err.read() or b"{}")
        except ValueError:
            payload = {}
        return err.code, payload


def errors(payload):
    return "; ".join(f"{e.get('code')}: {e.get('message')}" for e in payload.get("errors", [])) or "no detail"


def mentions_www(rule):
    return HOST in (rule.get("expression") or "") or rule.get("description") == DESCRIPTION


def main():
    if not TOKEN:
        print("CLOUDFLARE_API_TOKEN is not set.")
        return 1

    status, body = call("GET", f"/zones?name={ZONE}")
    zones = body.get("result") or []
    if status != 200 or not zones:
        print(f"Can't read zone {ZONE} (HTTP {status}: {errors(body)}). The token needs Zone → Zone → Read.")
        return 1
    zone_id = zones[0]["id"]
    print(f"zone {ZONE} found")

    # 1) Single Redirect rule (the source of truth).
    status, body = call("GET", f"/zones/{zone_id}/rulesets/phases/{PHASE}/entrypoint")
    if status == 200:
        ruleset = body["result"]
        rules = ruleset.get("rules") or []
        for r in rules:
            if mentions_www(r):
                print(f"existing redirect rule: {r.get('description')!r} {r.get('expression')!r} → {json.dumps(r.get('action_parameters'))}")
        match = next((r for r in rules if mentions_www(r)), None)
        if match:
            status, body = call("PATCH", f"/zones/{zone_id}/rulesets/{ruleset['id']}/rules/{match['id']}", {**RULE, "position": {"index": 1}})
            action = "updated"
        else:
            status, body = call("POST", f"/zones/{zone_id}/rulesets/{ruleset['id']}/rules", {**RULE, "position": {"index": 1}})
            action = "added"
    elif status == 404:
        status, body = call("PUT", f"/zones/{zone_id}/rulesets/phases/{PHASE}/entrypoint", {"rules": [RULE]})
        action = "created"
    else:
        print(f"Can't read Single Redirects (HTTP {status}: {errors(body)}). The token needs Zone → Single Redirect → Edit.")
        return 1
    if status not in (200, 201):
        print(f"Couldn't save the redirect rule (HTTP {status}: {errors(body)}). The token needs Zone → Single Redirect → Edit.")
        return 1
    print(f"single redirect rule {action}: {RULE['expression']} → 301 {APEX}<path>?<query>")

    # 2) Page Rules: make any www forwarding rule agree (or report that we can't see them).
    status, body = call("GET", f"/zones/{zone_id}/pagerules")
    if status == 200:
        for pr in body.get("result") or []:
            targets = " ".join(t.get("constraint", {}).get("value", "") for t in pr.get("targets", []))
            forwards = [a for a in pr.get("actions", []) if a.get("id") == "forwarding_url"]
            if HOST in targets and forwards:
                print(f"page rule {targets!r} forwards to {forwards[0].get('value')}")
                fixed = {
                    "targets": [{"target": "url", "constraint": {"operator": "matches", "value": f"*{HOST}/*"}}],
                    "actions": [{"id": "forwarding_url", "value": {"url": f"{APEX}/$2", "status_code": 301}}],
                    "status": pr.get("status", "active"),
                    "priority": pr.get("priority", 1),
                }
                s2, b2 = call("PUT", f"/zones/{zone_id}/pagerules/{pr['id']}", fixed)
                print("  → now keeps the path (301)" if s2 == 200 else f"  → couldn't update (HTTP {s2}: {errors(b2)}); needs Zone → Page Rules → Edit")
    else:
        print(f"(page rules not readable: HTTP {status} — fine if the zone has none)")

    # 3) Bulk Redirects (account level): report only.
    if ACCOUNT:
        status, body = call("GET", f"/accounts/{ACCOUNT}/rules/lists")
        if status == 200:
            for lst in body.get("result") or []:
                if lst.get("kind") != "redirect":
                    continue
                s3, b3 = call("GET", f"/accounts/{ACCOUNT}/rules/lists/{lst['id']}/items")
                for item in (b3.get("result") or []) if s3 == 200 else []:
                    red = item.get("redirect") or {}
                    if HOST in (red.get("source_url") or ""):
                        print(f"bulk redirect in list {lst.get('name')!r}: {red} — keep_path should be on (preserve_path_suffix)")

    # 4) Check what a visitor gets now (propagation takes a few seconds).
    probe = f"https://{HOST}/live?e=ci-probe"
    for _ in range(6):
        time.sleep(10)
        req = urllib.request.Request(probe, method="HEAD")
        opener = urllib.request.build_opener(NoRedirect)
        try:
            opener.open(req, timeout=15)
            code, location = 200, None
        except urllib.error.HTTPError as err:
            code, location = err.code, err.headers.get("location")
        print(f"probe {probe} → {code} {location}")
        if code == 301 and location == f"{APEX}/live?e=ci-probe":
            print("www now keeps the full link.")
            return 0
    print("The rule is saved, but the probe hasn't seen it yet — re-run this workflow in a minute to confirm.")
    return 0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - stdlib signature
        return None


if __name__ == "__main__":
    sys.exit(main())
