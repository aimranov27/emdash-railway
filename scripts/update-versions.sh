#!/usr/bin/env bash
# Bumps the pinned versions in the Dockerfile.
#
# EmDash and the starter template commit are bumped as soon as they change.
# Astro, its Node and React adapters, pg and Node.js are bumped on Mondays,
# together with an EmDash or template change, or when FORCE_ALL=1. That keeps
# "update available" notices for template users to roughly one a week.
#
# npm packages stay within the version ranges the pinned template declares
# (for example astro ^7), so a new major only arrives once upstream moves the
# template to it. Node.js stays on its current major line.
#
# NPM_BEFORE is moved to the current time whenever anything changes, so the
# transitive dependency tree is refreshed together with the bump.
#
# Prints a markdown summary of changes. Prints nothing if nothing changed.
set -euo pipefail

DOCKERFILE="$(dirname "$0")/../Dockerfile"
TEMPLATES_REPO=https://github.com/emdash-cms/templates

current() { sed -n "s/^ARG $1=//p" "$DOCKERFILE"; }
bump() { sed -i.bak "s|^ARG $1=.*|ARG $1=$2|" "$DOCKERFILE" && rm -f "$DOCKERFILE.bak"; }

changes=""
set_arg() {
  local arg="$1" new="$2" label="$3" old
  old="$(current "$arg")"
  if [ -z "$new" ]; then
    echo "Could not resolve a version for $label" >&2
    exit 1
  fi
  if [ "$old" != "$new" ]; then
    bump "$arg" "$new"
    changes+="- ${label}: \`${old}\` → \`${new}\`"$'\n'
  fi
}

# Highest stable version of a package that satisfies a semver range.
max_satisfying() {
  npm view "$1@$2" version --json 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (d) => (input += d)).on("end", () => {
      const parsed = input.trim() ? JSON.parse(input) : [];
      const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
      const key = (v) => v.split(".").map(Number);
      list.sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      });
      process.stdout.write(list.at(-1) ?? "");
    });'
}

template_range() {
  node -e 'const p = JSON.parse(process.argv[1]); process.stdout.write(p.dependencies?.[process.argv[2]] ?? "")' "$TEMPLATE_PKG" "$1"
}

# 1. Starter template commit and EmDash.
templates_commit="$(git ls-remote "$TEMPLATES_REPO" refs/heads/main | cut -f1)"
set_arg TEMPLATES_COMMIT "$templates_commit" "emdash-cms/templates commit"
TEMPLATE_PKG="$(curl -fsSL "https://raw.githubusercontent.com/emdash-cms/templates/${templates_commit}/blog/package.json")"

set_arg EMDASH_VERSION "$(max_satisfying emdash "$(template_range emdash)")" EmDash
primary_changed="$changes"

# 2. Everything else, on the weekly cadence.
if [ -n "$primary_changed" ] || [ "$(date -u +%u)" = 1 ] || [ "${FORCE_ALL:-}" = 1 ]; then
  set_arg ASTRO_VERSION "$(max_satisfying astro "$(template_range astro)")" Astro
  set_arg ASTRO_NODE_VERSION "$(max_satisfying @astrojs/node "$(template_range @astrojs/node)")" "@astrojs/node"
  set_arg ASTRO_REACT_VERSION "$(max_satisfying @astrojs/react "$(template_range @astrojs/react)")" "@astrojs/react"

  pg_range="$(npm view "emdash@$(current EMDASH_VERSION)" optionalDependencies.pg)"
  set_arg PG_VERSION "$(max_satisfying pg "${pg_range:-^8}")" pg

  node_major="$(current NODE_VERSION | cut -d. -f1)"
  node_latest="$(curl -fsSL https://nodejs.org/dist/index.json | node -e '
    let input = "";
    process.stdin.on("data", (d) => (input += d)).on("end", () => {
      const hit = JSON.parse(input).find((r) => r.version.startsWith(`v${process.argv[1]}.`));
      process.stdout.write(hit ? hit.version.slice(1) : "");
    });' "$node_major")"
  # Only move once the official Docker image for that release exists.
  if [ -n "$node_latest" ] && curl -fsS -o /dev/null \
      "https://hub.docker.com/v2/repositories/library/node/tags/${node_latest}-bookworm-slim"; then
    set_arg NODE_VERSION "$node_latest" "Node.js"
  fi
fi

if [ -n "$changes" ]; then
  bump NPM_BEFORE "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

printf '%s' "$changes"
