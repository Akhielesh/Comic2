# Security policy

DreamStream Studio runs at `dreamstreamstudio.ai` and `stream.dreamstreamstudio.ai`
(Stream Studio, including its baby monitor). This repository is public; the service is not
open to testing against other people's accounts.

## Reporting a vulnerability

Please report privately — never in a public issue, pull request or post:

- **GitHub:** [Report a vulnerability](https://github.com/Akhielesh/Comic2/security/advisories/new)
  (private advisory to the maintainers), or
- **Email:** support@dreamstreamstudio.ai with "Security" in the subject.

Tell us what you found, how to reproduce it, and what an attacker could do with it. A short
proof of concept is more useful than a long report.

We aim to acknowledge a report within five working days, to keep you updated while we work
on it, and to credit you when the fix ships if you would like that. We do not run a paid bug
bounty.

## What is in scope

- The web apps and their APIs: `dreamstreamstudio.ai`, `stream.dreamstreamstudio.ai`,
  `/api/*`, `/live-api/*` and the Cloudflare Workers this repository deploys.
- Anything that could expose a nursery's camera, sound, alerts or history to someone who is
  not a member of that nursery, or that could silence or delay an alert. These come first.
- Account takeover, session handling, authorisation between nurseries, members and guests.

## Please don't

- Access, change or delete data that isn't yours, or watch a stream you weren't invited to.
  Use two accounts of your own to test anything between users or nurseries.
- Run denial-of-service, load or spam tests, or social-engineer people.
- Test a baby monitor that is in real use. Create your own nursery for testing.

If you follow these rules and act in good faith, we will not pursue or support legal action
against you for your research, and we will work with you to understand and fix the problem.

## Supported versions

Only the current production deployment is supported; fixes ship there.
