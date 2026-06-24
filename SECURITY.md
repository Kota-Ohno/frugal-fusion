# Security Policy

Frugal Fusion is pre-1.0 evaluation tooling. The current security boundary is
focused on preventing secret leakage, private holdout leakage, accidental model
spend, and unsupported public cost-performance claims.

## Supported Status

Only the current development line is in scope for security review. Historical
commits, local experiments, private case sets, and unpublished run artifacts are
not supported as stable release lines.

Before a public repository launch, maintainers must configure a private
vulnerability reporting channel, such as GitHub private vulnerability reporting
or another private contact path. Until that private channel exists, do not put
vulnerability details in a public issue. Open a minimal public issue asking for
a private security contact, without exploit details or sensitive artifacts.
Maintainers should also run `pnpm run public-release:secrets` and enable
host-side secret scanning and push protection before launch; the local scan is a
high-confidence release guard, not a full replacement for hosted secret
protection.

## What To Report

Please report issues that could:

- expose API keys, authorization headers, HMAC keys, environment values, private
  paths, raw prompts, raw answers, private reports, or private holdout material;
- bypass public-report redaction or include private model/provider, price,
  routing, trace, manifest, or case-set details in public artifacts;
- make `validate-cases`, `verify-public-report`, help paths, or preflight paths
  require an API key, model snapshot, network call, or model spend;
- allow case-manifest binding, HMAC manifest handling, output-path checks, or
  public claim gates to be bypassed;
- cause cost, budget, usage, or provider-routing evidence to be silently wrong.

Model quality disagreements, benchmark-design disagreements, and ordinary model
hallucinations are usually evaluation issues rather than security issues unless
they also create a leak, spend, provenance, or public-claim safety problem.

## Do Not Include Publicly

Do not put any of the following in public issues, pull requests, screenshots,
logs, comments, or CI output:

- `OPENROUTER_API_KEY`, `FRUGAL_FUSION_MANIFEST_HMAC_KEY`, account IDs, tokens,
  cookies, private endpoint names, or authorization headers;
- private holdout case files, private manifests, HMAC manifest keys, row hashes,
  raw case IDs, raw category labels, or unreleased benchmark data;
- private reports, raw prompts, raw answers, traces, raw failure messages,
  model/provider IDs, prices, provider routing slugs, BYOK/account routing
  settings, or exact commands containing private paths or environment names;
- public cost-performance claims that have not passed the documented holdout,
  manifest, fixed-matrix, endpoint-pinning, confidence-interval, and private
  reproduction requirements.

Use small synthetic examples or the checked-in public sample when possible. If a
private artifact is needed for diagnosis, share it only through the configured
private security channel.

## Safe Public Report Template

For non-sensitive public issues, include:

- affected command or module;
- operating system and Node/pnpm versions;
- a minimal synthetic case or public sample reference;
- sanitized stdout/stderr with secrets, private paths, model/provider details,
  raw prompts, raw answers, and private artifact names removed;
- whether the issue involves spend, public-report disclosure, manifest binding,
  claim-gate behavior, or ordinary local validation.

Security reports should be as small as possible while still showing the
suspected boundary break.
