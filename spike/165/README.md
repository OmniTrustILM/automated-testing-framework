# Spike #165: one throw-away ILM on kind

Throw-away material of the spike in issue #165, not a finished job. `env/up.sh` brings up, on a fresh kind cluster:
the upstream operators and the ILM operator as the operator's `e2e-managed` workflow does, ILM on the current
`develop-latest` images (digests resolved at run time), three public connectors and an own EJBCA CE set up by script.
`.github/workflows/throwaway-ilm-spike.yml` runs it on a standard GitHub runner and prints time and memory.
No secrets and no private images are used. This branch is deleted when the spike ends.
