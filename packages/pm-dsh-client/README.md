# WorkLoom PM DSH client

This package adapts the official DeepSeek Harness desktop UI into WorkLoom PM.

The host half registers six PM tools:

- `pm_create_mission`
- `pm_get_mission`
- `pm_wait_mission`
- `pm_read_artifact`
- `pm_cancel_mission`
- `pm_resume_mission`

The tools call the PMTest server through a loopback URL and a random
per-process capability. The launcher supplies both through the DSH process
environment. Neither value enters a model prompt, tool argument, tool result,
or durable repository file.

The browser half replaces the official brand occupants with WorkLoom PM
branding and adds three starter prompts to the empty conversation page.

## Run in this repository

```sh
pnpm app
```

The default client is DSH. The previous WorkLoom multi-page shell remains
available as a rollback path:

```sh
WORKLOOM_CLIENT=legacy pnpm app
```

## Test

```sh
pnpm -C packages/pm-dsh-client test
```
